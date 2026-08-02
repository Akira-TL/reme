"""Danger-link confirmation orchestrator: two racing paths to one alarm.

On a fall check-in the elder device is asked to upload (a) a raw frame and
(b) the elder's spoken reply. This module runs both confirmations off-thread
and lets whichever finds danger first escalate:

- frame → one MiMo vision call → ``DecisionService.confirm_danger`` (a pure
  rule transition; the resulting family alert carries ``alarm``);
- voice → one MiMo omni call (ASR + intent in a single hop) → a synthetic
  ``InteractionResponse(source=voice)`` through the ordinary response
  machinery, so a spoken “我摔倒了” takes exactly the elder-report path.

Neither path is load-bearing: every failure here is audited and swallowed,
because the C-rendered countdown still expires into the deterministic
timeout escalation (ADR-0005). The worst case of this module is a *later*
alarm, never a missing one. Races resolve inside the service lock — the
second confirmation finds the episode already escalated and is discarded.
"""

from __future__ import annotations

import base64
import binascii
import threading
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Protocol

from reme.decision.audit import AuditLog
from reme.decision.mimo.adapter import (
    SUPPORTED_AUDIO_FORMATS,
    MimoCallResult,
    MimoTransportError,
)
from reme.decision.mimo.confirm import (
    VISION_CONFIRM_SYSTEM_PROMPT,
    VOICE_INTENT_SYSTEM_PROMPT,
    VoiceIntent,
    build_vision_confirm_content,
    build_voice_intent_content,
    classify_reply_text,
    guard_voice_intent,
    parse_vision_verdict,
    parse_voice_intent,
)
from reme.decision.mimo.schema import MimoSchemaError
from reme.decision.records import (
    CareDecision,
    DemoMode,
    InteractionResponse,
    ResponseSource,
    ResponseValue,
)

REJECT_NO_CONFIRM_PENDING = "no_confirm_pending"
REJECT_CHANNEL_NOT_OFFERED = "channel_not_offered"
REJECT_BAD_MEDIA = "bad_media"
REJECT_CONFIRM_BUDGET = "confirm_budget_exhausted"
REJECT_CONFIRM_UNAVAILABLE = "confirm_unavailable"

_TRANSCRIPT_LIMIT = 200

_IMAGE_MAGIC: dict[str, tuple[bytes, int]] = {
    "image/jpeg": (b"\xff\xd8\xff", 0),
    "image/png": (b"\x89PNG", 0),
}

_AUDIO_MAGIC: dict[str, tuple[bytes, int]] = {
    "wav": (b"RIFF", 0),
    "mp3": (b"", 0),  # ID3 tags vary; size checks only
    "m4a": (b"ftyp", 4),
    "ogg": (b"OggS", 0),
    "flac": (b"fLaC", 0),
}


class DangerRejectedError(ValueError):
    """An upload B refuses now; ``code`` maps to an HTTP status."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class DangerCognitionClient(Protocol):
    """The one transport call both confirmation paths need."""

    def complete(
        self, *, system_prompt: str, user_content: str | list[dict[str, Any]]
    ) -> MimoCallResult: ...


class DangerDecisionService(Protocol):
    """The slice of DecisionService the orchestrator drives."""

    @property
    def demo_mode(self) -> DemoMode: ...

    def pending_confirm_target(self, scene_id: str) -> tuple[str, tuple[str, ...]] | None: ...

    def confirm_danger(
        self, *, scene_id: str, timestamp_ms: float, note: str | None = None
    ) -> CareDecision | None: ...

    def submit_response(self, response: InteractionResponse) -> CareDecision: ...


@dataclass(frozen=True, slots=True)
class DangerConfig:
    """Budgets and thresholds for one episode's confirmation window."""

    vision_min_confidence: float = 0.5
    max_vision_calls: int = 2
    max_voice_calls: int = 3
    max_voice_unclear: int = 1
    max_media_bytes: int = 2_000_000


@dataclass(slots=True)
class _EpisodeBudget:
    decision_id: str
    vision_calls: int = 0
    voice_calls: int = 0
    voice_unclear: int = 0


def _spawn_daemon(work: Callable[[], None]) -> None:
    threading.Thread(target=work, daemon=True).start()


_DEFAULT_DANGER_CONFIG = DangerConfig()


class DangerConfirmController:
    """Validates uploads, budgets the episode, and runs both confirm paths."""

    def __init__(
        self,
        *,
        service: DangerDecisionService,
        client: DangerCognitionClient | None,
        audit: AuditLog | None = None,
        config: DangerConfig = _DEFAULT_DANGER_CONFIG,
        spawn: Callable[[Callable[[], None]], None] = _spawn_daemon,
    ) -> None:
        self._service = service
        self._client = client
        self._audit = audit
        self._config = config
        self._spawn = spawn
        self._lock = threading.Lock()
        self._budgets: dict[str, _EpisodeBudget] = {}

    # -- intake -------------------------------------------------------------

    def submit_frame(
        self,
        *,
        scene_id: str,
        decision_id: str,
        image_b64: str,
        timestamp_ms: float,
        mime_type: str = "image/jpeg",
        origin: str = "c_upload",
    ) -> None:
        """Accept one raw frame and start a visual confirmation off-thread."""

        if self._client is None:
            raise DangerRejectedError(REJECT_CONFIRM_UNAVAILABLE)
        target_id = self._require_channel(scene_id, "frame")
        if mime_type not in _IMAGE_MAGIC:
            raise DangerRejectedError(REJECT_BAD_MEDIA)
        image_bytes = self._decode_media(image_b64)
        magic, offset = _IMAGE_MAGIC[mime_type]
        if magic and image_bytes[offset : offset + len(magic)] != magic:
            raise DangerRejectedError(REJECT_BAD_MEDIA)
        self._consume_budget(scene_id, target_id, "vision")
        note = f"origin={origin} decision={decision_id}"
        self._spawn(lambda: self._run_vision(scene_id, image_bytes, mime_type, timestamp_ms, note))

    def submit_voice(
        self,
        *,
        scene_id: str,
        decision_id: str,
        timestamp_ms: float,
        text: str | None = None,
        audio_b64: str | None = None,
        audio_format: str | None = None,
        origin: str = "c_upload",
    ) -> None:
        """Accept one spoken reply (audio, or C-transcribed text) off-thread."""

        if (text is None) == (audio_b64 is None):
            raise DangerRejectedError(REJECT_BAD_MEDIA)
        audio_bytes: bytes | None = None
        if audio_b64 is not None:
            if self._client is None:
                # No cognition backend means no ASR; C must fall back to its
                # buttons (and may still send browser-transcribed text).
                raise DangerRejectedError(REJECT_CONFIRM_UNAVAILABLE)
            if audio_format not in SUPPORTED_AUDIO_FORMATS:
                raise DangerRejectedError(REJECT_BAD_MEDIA)
            audio_bytes = self._decode_media(audio_b64)
            magic, offset = _AUDIO_MAGIC[audio_format]
            if magic and audio_bytes[offset : offset + len(magic)] != magic:
                raise DangerRejectedError(REJECT_BAD_MEDIA)
        elif text is not None and not text.strip():
            raise DangerRejectedError(REJECT_BAD_MEDIA)
        target_id = self._require_channel(scene_id, "voice")
        self._consume_budget(scene_id, target_id, "voice")
        note = f"origin={origin} decision={decision_id}"
        if audio_bytes is not None:
            audio = audio_bytes
            assert audio_format is not None
            fmt = audio_format
            self._spawn(
                lambda: self._run_voice_audio(scene_id, target_id, audio, fmt, timestamp_ms, note)
            )
        else:
            assert text is not None
            reply = text.strip()
            self._spawn(
                lambda: self._run_voice_text(scene_id, target_id, reply, timestamp_ms, note)
            )

    # -- validation and budgets ---------------------------------------------

    def _require_channel(self, scene_id: str, channel: str) -> str:
        target = self._service.pending_confirm_target(scene_id)
        if target is None:
            raise DangerRejectedError(REJECT_NO_CONFIRM_PENDING)
        target_id, channels = target
        if channel not in channels:
            raise DangerRejectedError(REJECT_CHANNEL_NOT_OFFERED)
        return target_id

    def _decode_media(self, encoded: str) -> bytes:
        # 4/3 expansion plus padding slack: reject before decoding buys DoS room.
        if len(encoded) > self._config.max_media_bytes * 4 // 3 + 8:
            raise DangerRejectedError(REJECT_BAD_MEDIA)
        try:
            payload = base64.b64decode(encoded, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise DangerRejectedError(REJECT_BAD_MEDIA) from exc
        if not payload or len(payload) > self._config.max_media_bytes:
            raise DangerRejectedError(REJECT_BAD_MEDIA)
        return payload

    def _consume_budget(self, scene_id: str, decision_id: str, kind: str) -> None:
        with self._lock:
            budget = self._budgets.get(scene_id)
            if budget is None or budget.decision_id != decision_id:
                budget = _EpisodeBudget(decision_id=decision_id)
                self._budgets[scene_id] = budget
            if kind == "vision":
                if budget.vision_calls >= self._config.max_vision_calls:
                    raise DangerRejectedError(REJECT_CONFIRM_BUDGET)
                budget.vision_calls += 1
            else:
                if budget.voice_calls >= self._config.max_voice_calls:
                    raise DangerRejectedError(REJECT_CONFIRM_BUDGET)
                budget.voice_calls += 1

    def _consume_unclear(self, scene_id: str, decision_id: str) -> bool:
        with self._lock:
            budget = self._budgets.get(scene_id)
            if budget is None or budget.decision_id != decision_id:
                budget = _EpisodeBudget(decision_id=decision_id)
                self._budgets[scene_id] = budget
            if budget.voice_unclear >= self._config.max_voice_unclear:
                return False
            budget.voice_unclear += 1
            return True

    # -- workers ------------------------------------------------------------

    def _run_vision(
        self, scene_id: str, image_bytes: bytes, mime_type: str, timestamp_ms: float, note: str
    ) -> None:
        assert self._client is not None
        try:
            result = self._client.complete(
                system_prompt=VISION_CONFIRM_SYSTEM_PROMPT,
                user_content=build_vision_confirm_content(image_bytes, mime_type=mime_type),
            )
            verdict = parse_vision_verdict(result.content)
        except (MimoTransportError, MimoSchemaError) as exc:
            self._audit_event("danger_visual_failed", scene_id, note=f"{note} {exc}")
            return
        except Exception as exc:  # noqa: BLE001 - a worker must never crash the server
            self._audit_event("danger_visual_failed", scene_id, note=f"{note} unexpected: {exc}")
            return
        summary = (
            f"{note} fallen={verdict.fallen} confidence={verdict.confidence:.2f}"
            f" latency_ms={result.latency_ms:.0f} {verdict.reason}"
        ).strip()
        self._audit_event("danger_visual", scene_id, note=summary, latency_ms=result.latency_ms)
        if verdict.fallen and verdict.confidence >= self._config.vision_min_confidence:
            self._service.confirm_danger(scene_id=scene_id, timestamp_ms=timestamp_ms, note=summary)

    def _run_voice_audio(
        self,
        scene_id: str,
        target_id: str,
        audio_bytes: bytes,
        audio_format: str,
        timestamp_ms: float,
        note: str,
    ) -> None:
        assert self._client is not None
        try:
            result = self._client.complete(
                system_prompt=VOICE_INTENT_SYSTEM_PROMPT,
                user_content=build_voice_intent_content(audio_bytes, audio_format=audio_format),
            )
            verdict = guard_voice_intent(parse_voice_intent(result.content))
        except (MimoTransportError, MimoSchemaError) as exc:
            self._audit_event("danger_voice_failed", scene_id, note=f"{note} {exc}")
            return
        except Exception as exc:  # noqa: BLE001 - a worker must never crash the server
            self._audit_event("danger_voice_failed", scene_id, note=f"{note} unexpected: {exc}")
            return
        self._submit_intent(
            scene_id,
            target_id,
            verdict,
            timestamp_ms,
            f"{note} latency_ms={result.latency_ms:.0f}",
        )

    def _run_voice_text(
        self, scene_id: str, target_id: str, reply: str, timestamp_ms: float, note: str
    ) -> None:
        ruled = classify_reply_text(reply)
        if ruled is not None:
            self._submit_intent(
                scene_id,
                target_id,
                VoiceIntent(intent=ruled, transcript=reply),
                timestamp_ms,
                f"{note} ruled=1",
            )
            return
        if self._client is None:
            self._submit_intent(
                scene_id,
                target_id,
                VoiceIntent(intent=ResponseValue.UNCLEAR, transcript=reply),
                timestamp_ms,
                f"{note} ruled=0 no-client",
            )
            return
        try:
            result = self._client.complete(
                system_prompt=VOICE_INTENT_SYSTEM_PROMPT,
                user_content=f"老人回应的文字记录：{reply}",
            )
            verdict = guard_voice_intent(parse_voice_intent(result.content))
        except (MimoTransportError, MimoSchemaError) as exc:
            self._audit_event("danger_voice_failed", scene_id, note=f"{note} {exc}")
            return
        except Exception as exc:  # noqa: BLE001 - a worker must never crash the server
            self._audit_event("danger_voice_failed", scene_id, note=f"{note} unexpected: {exc}")
            return
        if verdict.transcript is None:
            verdict = VoiceIntent(intent=verdict.intent, transcript=reply)
        self._submit_intent(scene_id, target_id, verdict, timestamp_ms, note)

    def _submit_intent(
        self,
        scene_id: str,
        target_id: str,
        verdict: VoiceIntent,
        timestamp_ms: float,
        note: str,
    ) -> None:
        if verdict.intent is ResponseValue.UNCLEAR and not self._consume_unclear(
            scene_id, target_id
        ):
            self._audit_event(
                "danger_voice_discarded", scene_id, note=f"{note} unclear budget spent"
            )
            return
        transcript = verdict.transcript
        if transcript is not None:
            transcript = transcript.strip()[:_TRANSCRIPT_LIMIT] or None
        response = InteractionResponse(
            scene_id=scene_id,
            decision_id=target_id,
            timestamp_ms=timestamp_ms,
            response=verdict.intent,
            source=ResponseSource.VOICE,
            demo_mode=self._service.demo_mode,
            text=transcript,
        )
        try:
            decision = self._service.submit_response(response)
        except Exception as exc:  # noqa: BLE001 - late/raced replies are dropped, not fatal
            self._audit_event("danger_voice_discarded", scene_id, note=f"{note} {exc}")
            return
        self._audit_event(
            "danger_voice",
            scene_id,
            decision_id=decision.decision_id,
            note=f"{note} intent={verdict.intent.value}",
        )

    # -- audit --------------------------------------------------------------

    def _audit_event(
        self,
        kind: str,
        scene_id: str,
        *,
        decision_id: str | None = None,
        latency_ms: float | None = None,
        note: str | None = None,
    ) -> None:
        if self._audit is None:
            return
        self._audit.record(
            kind=kind,
            scene_id=scene_id,
            mode=self._service.demo_mode.value,
            decision_id=decision_id,
            latency_ms=latency_ms,
            note=note,
        )
