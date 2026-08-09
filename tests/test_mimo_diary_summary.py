from __future__ import annotations

import http.client
import json
import threading
from http.server import ThreadingHTTPServer
from typing import Any

import pytest
from reme.runtime.decision.mimo.adapter import MimoCallResult
from reme.runtime.decision.mimo.diary import (
    DIARY_REQUEST_SCHEMA,
    DIARY_RESPONSE_SCHEMA,
    DiarySummaryError,
    MimoDiarySummaryService,
    parse_diary_summary_completion,
    parse_diary_summary_request,
)
from reme.runtime.decision.policy import DecisionService, PolicyConfig
from reme.runtime.decision.server import build_decision_handler


def _request_payload() -> dict[str, object]:
    return {
        "schema_version": DIARY_REQUEST_SCHEMA,
        "date": "2026-08-09",
        "events": [
            {
                "time": "07:12",
                "kind": "activity",
                "period": "清晨",
                "description": "从床边起身",
            },
            {
                "time": "10:08",
                "kind": "response",
                "period": "上午",
                "description": "本人回应：在听广播",
            },
            {
                "time": "10:42",
                "kind": "device",
                "period": "上午",
                "description": "冰箱门打开：取出番茄和鸡蛋",
            },
        ],
    }


class _FakeClient:
    def __init__(self, content: str) -> None:
        self.content = content
        self.system_prompt = ""
        self.user_content: str | list[dict[str, Any]] = ""

    def complete(
        self,
        *,
        system_prompt: str,
        user_content: str | list[dict[str, Any]],
    ) -> MimoCallResult:
        self.system_prompt = system_prompt
        self.user_content = user_content
        return MimoCallResult(content=self.content, latency_ms=812.34, attempts=1)


def _completion() -> str:
    return json.dumps(
        {
            "headline": "今天从起身开始，上午完成一次回应",
            "summary": "07:12 记录到从床边起身；10:08 本人回应正在听广播。",
            "highlights": [
                {"time": "07:12", "text": "从床边起身"},
                {"time": "10:08", "text": "本人回应正在听广播"},
            ],
            "care_note": "一次主动关怀已收到回应。",
            "uncertainty": "low",
        },
        ensure_ascii=False,
    )


def test_diary_request_accepts_only_bounded_structured_events() -> None:
    request = parse_diary_summary_request(_request_payload())
    assert request.date == "2026-08-09"
    assert len(request.events) == 3

    unsafe = _request_payload()
    events = list(unsafe["events"])  # type: ignore[arg-type]
    events[0] = {**events[0], "video_b64": "not-allowed"}
    unsafe["events"] = events
    with pytest.raises(DiarySummaryError, match="video_b64"):
        parse_diary_summary_request(unsafe)


def test_diary_completion_rejects_extra_or_unbounded_model_fields() -> None:
    headline, summary, highlights, care_note, uncertainty = parse_diary_summary_completion(
        _completion()
    )
    assert headline.startswith("今天")
    assert "听广播" in summary
    assert highlights[1].time == "10:08"
    assert care_note == "一次主动关怀已收到回应。"
    assert uncertainty == "low"

    invalid = json.loads(_completion())
    invalid["diagnosis"] = "invented"
    with pytest.raises(DiarySummaryError, match="diagnosis"):
        parse_diary_summary_completion(json.dumps(invalid, ensure_ascii=False))


def test_service_sends_event_facts_and_wraps_validated_mimo_json() -> None:
    client = _FakeClient(_completion())
    service = MimoDiarySummaryService(client, model="mimo-v2.5", clock=lambda: 123.456)
    summary = service.generate(_request_payload())
    payload = summary.to_payload()

    assert payload["schema_version"] == DIARY_RESPONSE_SCHEMA
    assert payload["source"] == "mimo"
    assert payload["generated_at_ms"] == 123456
    assert payload["input_event_count"] == 3
    assert payload["latency_ms"] == 812.3
    assert isinstance(client.user_content, str)
    sent = json.loads(client.user_content)
    assert sent["events"][0] == {
        "time": "07:12",
        "kind": "activity",
        "period": "清晨",
        "description": "从床边起身",
    }
    assert "不诊断疾病" in client.system_prompt


def test_service_rejects_highlight_times_not_present_in_input_events() -> None:
    completion = json.loads(_completion())
    completion["highlights"][0]["time"] = "11:59"
    service = MimoDiarySummaryService(
        _FakeClient(json.dumps(completion, ensure_ascii=False))
    )
    with pytest.raises(DiarySummaryError, match="unobserved times: 11:59"):
        service.generate(_request_payload())


def _post(port: int, payload: dict[str, object]) -> tuple[int, dict[str, Any]]:
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        connection.request(
            "POST",
            "/api/diary/summary",
            body=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={"Content-Type": "application/json"},
        )
        response = connection.getresponse()
        body = json.loads(response.read().decode("utf-8"))
        return response.status, body
    finally:
        connection.close()


def _serve(
    diary_summary: MimoDiarySummaryService | None,
) -> tuple[ThreadingHTTPServer, threading.Thread]:
    decision = DecisionService(scenes={}, config=PolicyConfig())
    handler = build_decision_handler(
        service=decision,
        static_dir=None,
        diary_summary=diary_summary,
    )
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, thread


def _stop(server: ThreadingHTTPServer, thread: threading.Thread) -> None:
    server.shutdown()
    server.server_close()
    thread.join(timeout=5)


def test_http_diary_route_returns_live_mimo_json_and_never_mock_fallback() -> None:
    service = MimoDiarySummaryService(_FakeClient(_completion()), clock=lambda: 123.456)
    server, thread = _serve(service)
    try:
        status, body = _post(server.server_address[1], _request_payload())
        assert status == 200
        assert body["source"] == "mimo"
        assert body["schema_version"] == DIARY_RESPONSE_SCHEMA
    finally:
        _stop(server, thread)

    disabled_server, disabled_thread = _serve(None)
    try:
        status, body = _post(disabled_server.server_address[1], _request_payload())
        assert status == 503
        assert body["error"]["code"] == "mimo_summary_disabled"
    finally:
        _stop(disabled_server, disabled_thread)
