"""Tests for the minimal Reme -> OpenClaw/Miloco webhook adapter."""

from __future__ import annotations

import json
from dataclasses import dataclass
from urllib.error import HTTPError, URLError
from urllib.request import Request

import pytest
from reme.runtime.decision.config import ServerConfig
from reme.runtime.decision.server import build_decision_runtime
from reme.runtime.integrations.emergency import (
    EmergencyEvent,
    EmergencySeverity,
    EmergencyType,
)
from reme.runtime.integrations.miloco import (
    MilocoConfigError,
    MilocoDeliveryError,
    MilocoWebhookConfig,
    MilocoWebhookTransport,
    miloco_config_from_environment,
)


@dataclass
class _Response:
    status: int = 200
    closed: bool = False

    def getcode(self) -> int:
        return self.status

    def close(self) -> None:
        self.closed = True


def _event() -> EmergencyEvent:
    return EmergencyEvent(
        schema_version="reme-emergency-event/v1",
        event_id="reme-event-0042",
        type=EmergencyType.URGENT_ATTENTION,
        severity=EmergencySeverity.CRITICAL,
        summary="Reme 检测到需要立即外部介入的紧急事件，请立即处理。",
        occurred_at="2026-08-07T11:42:00Z",
    )


def test_miloco_config_is_disabled_without_environment() -> None:
    assert miloco_config_from_environment({}) is None


def test_miloco_config_requires_url_and_token_together() -> None:
    with pytest.raises(MilocoConfigError, match="both"):
        miloco_config_from_environment(
            {"REME_MILOCO_WEBHOOK_URL": "http://127.0.0.1:18789/hooks/reme-emergency"}
        )


def test_miloco_config_reads_only_dedicated_hook_credentials() -> None:
    config = miloco_config_from_environment(
        {
            "REME_MILOCO_WEBHOOK_URL": "http://127.0.0.1:18789/hooks/reme-emergency",
            "REME_MILOCO_WEBHOOK_TOKEN": "hook-secret",
            "OPENCLAW_GATEWAY_TOKEN": "must-not-be-used",
        }
    )

    assert config is not None
    assert config.token == "hook-secret"
    assert config.url.endswith("/hooks/reme-emergency")


def test_decision_runtime_enables_optional_miloco_publisher(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(
        "REME_MILOCO_WEBHOOK_URL", "http://127.0.0.1:18789/hooks/reme-emergency"
    )
    monkeypatch.setenv("REME_MILOCO_WEBHOOK_TOKEN", "hook-secret")
    runtime = build_decision_runtime(ServerConfig(audit_path=None, danger_enabled=False))
    try:
        assert runtime.emergency_publisher is not None
    finally:
        runtime.shutdown()


def test_decision_runtime_survives_partial_miloco_config(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv(
        "REME_MILOCO_WEBHOOK_URL", "http://127.0.0.1:18789/hooks/reme-emergency"
    )
    monkeypatch.delenv("REME_MILOCO_WEBHOOK_TOKEN", raising=False)
    runtime = build_decision_runtime(ServerConfig(audit_path=None, danger_enabled=False))
    try:
        assert runtime.emergency_publisher is None
        assert "Miloco integration disabled" in capsys.readouterr().out
    finally:
        runtime.shutdown()


def test_miloco_transport_posts_exact_minimal_payload_with_hook_token() -> None:
    captured: list[tuple[Request, float]] = []

    def opener(request: Request, *, timeout: float) -> _Response:
        captured.append((request, timeout))
        return _Response()

    transport = MilocoWebhookTransport(
        MilocoWebhookConfig(
            url="http://127.0.0.1:18789/hooks/reme-emergency",
            token="hook-secret",
            timeout_seconds=3.0,
            max_attempts=1,
        ),
        opener=opener,
    )

    transport.send_event(_event())

    assert len(captured) == 1
    request, timeout = captured[0]
    assert request.full_url == "http://127.0.0.1:18789/hooks/reme-emergency"
    assert request.get_method() == "POST"
    assert request.get_header("Authorization") == "Bearer hook-secret"
    assert request.get_header("Content-type") == "application/json"
    assert timeout == 3.0
    assert json.loads(request.data or b"{}") == {
        "schema_version": "reme-emergency-event/v1",
        "event_id": "reme-event-0042",
        "type": "urgent_attention",
        "severity": "critical",
        "summary": "Reme 检测到需要立即外部介入的紧急事件，请立即处理。",
        "occurred_at": "2026-08-07T11:42:00Z",
    }


def test_miloco_transport_retries_only_known_pre_run_failures() -> None:
    attempts = 0

    def opener(request: Request, *, timeout: float) -> _Response:
        del request, timeout
        nonlocal attempts
        attempts += 1
        if attempts < 3:
            raise HTTPError(
                "http://127.0.0.1/hooks/reme-emergency",
                503,
                "admission timeout",
                hdrs=None,
                fp=None,
            )
        return _Response()

    transport = MilocoWebhookTransport(
        MilocoWebhookConfig(
            url="http://127.0.0.1:18789/hooks/reme-emergency",
            token="hook-secret",
            max_attempts=3,
            retry_delay_seconds=0.0,
        ),
        opener=opener,
    )

    transport.send_event(_event())

    assert attempts == 3


def test_miloco_transport_does_not_retry_ambiguous_network_failures() -> None:
    attempts = 0

    def opener(request: Request, *, timeout: float) -> _Response:
        del request, timeout
        nonlocal attempts
        attempts += 1
        raise URLError("socket timed out")

    transport = MilocoWebhookTransport(
        MilocoWebhookConfig(
            url="http://127.0.0.1:18789/hooks/reme-emergency",
            token="hook-secret",
            max_attempts=3,
            retry_delay_seconds=0.0,
        ),
        opener=opener,
    )

    with pytest.raises(MilocoDeliveryError, match="delivery outcome unknown"):
        transport.send_event(_event())

    assert attempts == 1
