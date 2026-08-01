"""DecisionService: streams + state machine + guardrails + MiMo, behind one API.

Concurrency contract: the session store runs under one lock; MiMo calls happen
outside it. Before a call we snapshot the session generation, and we commit the
result only if the generation is unchanged — a rule escalation that lands while
MiMo is in flight wins unconditionally and the late proposal is discarded
(contract: MiMo must never cancel or delay a rule alert). When a MiMo-backed
transition fails, the session is left exactly where it was (phase and pending
decision preserved) and a standalone degraded decision is emitted, so C can
switch adapters and replay the same response.
"""

from __future__ import annotations

import json
import threading
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any, Protocol

from reme.decision.audit import AuditLog
from reme.decision.context import (
    DecisionContext,
    PerceptionStreams,
    SceneStreams,
    build_decision_context,
)
from reme.decision.guardrails import TriggerConfig, violates_risk_floor
from reme.decision.mimo.adapter import MimoCallResult, MimoClient, MimoTransportError
from reme.decision.mimo.prompts import PersonaConfig, build_system_prompt, build_user_prompt
from reme.decision.mimo.schema import MimoProposal, MimoSchemaError, parse_mimo_proposal
from reme.decision.records import (
    ActionCard,
    CardStatus,
    CareDecision,
    DecisionAction,
    DecisionSource,
    DecisionState,
    DemoMode,
    InteractionResponse,
    PrivacyMode,
    Uncertainty,
    VisualContext,
    append_recorded_decision,
    as_recorded,
    load_recorded_decisions,
)
from reme.decision.state_machine import (
    DecisionSkeleton,
    Directive,
    MimoTask,
    SessionState,
    TemplateId,
    on_response,
    on_tick,
)
from reme.decision.visual import load_visual_asset, visual_context_record, visual_payload


class DecisionRejectedError(ValueError):
    """A request C must fix or resequence; ``code`` maps to an HTTP status."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class UnknownSceneError(KeyError):
    """Raised when a scene_id has no loaded bundle."""


class DecisionPublisher(Protocol):
    """Pushes newly emitted decisions onto the runtime event stream (§14)."""

    def publish_decision(self, decision: CareDecision) -> None: ...


class MimoDecisionClient(Protocol):
    """One MiMo-compatible cognition backend (live or scripted)."""

    def complete_task(
        self,
        *,
        scene_id: str,
        task: MimoTask,
        system_prompt: str,
        user_content: str | list[dict[str, Any]],
    ) -> MimoCallResult: ...


@dataclass(frozen=True, slots=True)
class PolicyConfig:
    """Service-level behaviour switches."""

    persona: PersonaConfig = PersonaConfig()
    trigger: TriggerConfig = TriggerConfig()
    demo_mode: DemoMode = DemoMode.LIVE
    scene_privacy: Mapping[str, PrivacyMode] = field(default_factory=dict)
    record_capture: bool = False
    visual_enabled: bool = False


@dataclass(frozen=True, slots=True)
class _Template:
    reason_summary: str
    uncertainty: Uncertainty
    elder_message: str | None = None
    family_notification: str | None = None


_TEMPLATES: dict[TemplateId, _Template] = {
    TemplateId.NORMAL: _Template("状态正常，无需打扰", Uncertainty.LOW),
    TemplateId.OBSERVE: _Template("画面信息不足或动作不明，继续观察", Uncertainty.MEDIUM),
    TemplateId.FALL_CHECK_IN: _Template(
        "检测到跌倒式转变，随后长时间低运动",
        Uncertainty.MEDIUM,
        elder_message="{name}，刚才看您像是摔了一下，您还好吗？能回应我一下吗？",
    ),
    TemplateId.CONCERN_CHECK_IN: _Template(
        "长时间静坐超过基线，轻量问候",
        Uncertainty.MEDIUM,
        elder_message="{name}，坐了挺久啦，一切都好吗？",
    ),
    TemplateId.CLARIFY: _Template(
        "回应不清晰，进行一次澄清",
        Uncertainty.MEDIUM,
        elder_message="{name}，刚才没听清，您现在方便再说一遍吗？",
    ),
    TemplateId.SAFE_RESOLVED: _Template(
        "老人确认安全，事件关闭",
        Uncertainty.LOW,
        elder_message="{name}，好的，那您注意安全，有需要随时叫我。",
    ),
    TemplateId.LATE_SAFE_RESOLVED: _Template(
        "老人迟到回应安全；已发出的家属提醒保留",
        Uncertainty.LOW,
        elder_message="{name}，好的，我会告诉家人您没事，之前的提醒他们已经收到。",
    ),
    TemplateId.FALL_HELP_ALERT: _Template(
        "老人请求帮助，紧急通知家人",
        Uncertainty.LOW,
        elder_message="{name}，好的，我马上通知{relation}来帮您。",
        family_notification="疑似跌倒后老人请求帮助，请立即联系或前往查看。",
    ),
    TemplateId.UNCLEAR_FAMILY_ALERT: _Template(
        "澄清后仍无法理解回应，转家属确认",
        Uncertainty.HIGH,
        family_notification="多次沟通无法确认老人状态，请尽快联系确认。",
    ),
    TemplateId.TIMEOUT_FAMILY_ALERT: _Template(
        "询问超时无回应，规则升级通知家属",
        Uncertainty.HIGH,
        family_notification="呼叫老人未获回应，请尽快联系或前往查看。",
    ),
    TemplateId.CONSENT_REQUEST: _Template(
        "识别到具体需求，征求告知家人的授权",
        Uncertainty.MEDIUM,
        elder_message="{name}，需要把这件事告诉{relation}，让他们帮帮您吗？",
    ),
    TemplateId.CONSENT_DENIED_CLOSE: _Template(
        "老人拒绝授权，不通知家人，仅本地建议",
        Uncertainty.LOW,
        elder_message="{name}，好的，先不告诉家人。您自己多留意，不舒服随时叫我。",
    ),
    TemplateId.CONSENT_TIMEOUT_CLOSE: _Template(
        "授权询问未获回应，保守关闭，不通知家人",
        Uncertainty.MEDIUM,
        elder_message="{name}，那先不打扰您了，有需要随时叫我。",
    ),
    TemplateId.CARD_FAMILY_NOTIFY: _Template(
        "老人已授权，通知家人并生成行动卡",
        Uncertainty.LOW,
        elder_message="{name}，好的，我已经把您的情况告诉{relation}了。",
        family_notification="老人有需要帮助的情况，已获老人同意告知，请查看行动卡并确认。",
    ),
    TemplateId.RECEIPT_RESOLVED: _Template(
        "家人已确认，回执老人，事件关闭",
        Uncertainty.LOW,
        elder_message="{name}，{relation}已经收到并确认了，会尽快帮您安排。",
    ),
    TemplateId.URGENT_ALERT: _Template(
        "家属提醒后仍无任何回应，进入紧急关注",
        Uncertainty.HIGH,
        family_notification="家属提醒后仍无任何回应，请立即前往查看或呼叫近邻协助。",
    ),
}


class LiveMimoDecisionClient:
    """Adapt the transport-level MimoClient to the per-task protocol."""

    def __init__(self, client: MimoClient) -> None:
        self._client = client

    def complete_task(
        self,
        *,
        scene_id: str,
        task: MimoTask,
        system_prompt: str,
        user_content: str | list[dict[str, Any]],
    ) -> MimoCallResult:
        return self._client.complete(system_prompt=system_prompt, user_content=user_content)


class MockMimoClient:
    """Scripted proposals per (scene, task); walks the real parse and validation."""

    def __init__(self, *, script_dir: str | Path) -> None:
        self._script_dir = Path(script_dir)

    def complete_task(
        self,
        *,
        scene_id: str,
        task: MimoTask,
        system_prompt: str,
        user_content: str | list[dict[str, Any]],
    ) -> MimoCallResult:
        script_path = self._script_dir / f"{scene_id}.json"
        try:
            scripts = json.loads(script_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise MimoTransportError(f"no mock script for scene {scene_id!r}: {exc}") from exc
        payload = scripts.get(task.value) if isinstance(scripts, dict) else None
        if payload is None:
            raise MimoTransportError(f"mock script for {scene_id!r} lacks task {task.value!r}")
        content = json.dumps(payload, ensure_ascii=False)
        return MimoCallResult(content=content, latency_ms=0.0, attempts=1)


@dataclass(frozen=True, slots=True)
class VisualContextBundle:
    """A loaded visual payload plus its truthful wire record."""

    record: VisualContext
    payload: dict[str, Any]


@dataclass(slots=True)
class _SceneRuntime:
    session: SessionState
    pending: CareDecision | None = None
    sequence: int = 0
    replay_index: int = 0
    epoch: int = 0


class DecisionService:
    """The one object behind B's HTTP endpoints (and behind tests)."""

    def __init__(
        self,
        *,
        scenes: Mapping[str, SceneStreams],
        config: PolicyConfig,
        mimo: MimoDecisionClient | None = None,
        audit: AuditLog | None = None,
        publisher: DecisionPublisher | None = None,
        live_streams: Callable[[str], PerceptionStreams | None] | None = None,
    ) -> None:
        self._scenes = dict(scenes)
        self._config = config
        self._mimo = mimo
        self._audit = audit
        self._publisher = publisher
        self._live_streams = live_streams
        self._lock = threading.Lock()
        self._runtimes: dict[str, _SceneRuntime] = {}
        self._replays: dict[str, tuple[CareDecision, ...]] = {}
        if config.demo_mode is DemoMode.RECORD:
            self._load_replays()

    # -- public API ---------------------------------------------------------

    def scene_ids(self) -> tuple[str, ...]:
        return tuple(sorted(self._scenes))

    @property
    def demo_mode(self) -> DemoMode:
        return self._config.demo_mode

    def reset_all_scenes(self) -> None:
        """Invalidate every episode and in-flight MiMo call (session switches).

        The epoch bump makes every outstanding CAS snapshot stale, so a MiMo
        result computed for the previous session can never commit or be
        published under the new one (Codex review P1).
        """

        with self._lock:
            for scene_id, runtime in list(self._runtimes.items()):
                self._runtimes[scene_id] = _SceneRuntime(
                    session=SessionState(scene_id=scene_id),
                    sequence=runtime.sequence,
                    epoch=runtime.epoch + 1,
                )

    def scene_streams(self, scene_id: str) -> SceneStreams:
        """Bundle-backed streams only (assets/health); live scenes raise."""

        try:
            return self._scenes[scene_id]
        except KeyError as exc:
            raise UnknownSceneError(scene_id) from exc

    def get_decision(self, *, scene_id: str, timestamp_ms: float) -> CareDecision:
        """Evaluate the scene at one video timestamp and return the live decision."""

        streams = self._streams(scene_id)
        if self._config.demo_mode is DemoMode.RECORD:
            return self._replay_current(scene_id)
        context = build_decision_context(
            streams, timestamp_ms=timestamp_ms, transition_grace_ms=5000.0
        )
        with self._lock:
            runtime = self._runtime(scene_id)
            previous_id = None if runtime.pending is None else runtime.pending.decision_id
            directive = on_tick(runtime.session, context, config=self._config.trigger)
            outcome = self._commit_rule_directive(runtime, directive, timestamp_ms)
            if outcome is None:
                snapshot = (runtime.epoch, runtime.session)
        if outcome is not None:
            self._publish(outcome, previous_id)
            return outcome
        decision = self._run_mimo_transition(
            scene_id,
            directive,
            timestamp_ms,
            snapshot,
            elder_text=None,
        )
        self._publish(decision, previous_id)
        return decision

    def submit_response(self, response: InteractionResponse) -> CareDecision:
        """Apply one InteractionResponse and return the next decision."""

        self._streams(response.scene_id)
        if self._config.demo_mode is DemoMode.RECORD:
            return self._replay_advance(response.scene_id, response.decision_id)
        with self._lock:
            runtime = self._runtime(response.scene_id)
            previous_id = None if runtime.pending is None else runtime.pending.decision_id
            directive = on_response(runtime.session, response, config=self._config.trigger)
            outcome = self._commit_rule_directive(runtime, directive, response.timestamp_ms)
            if outcome is None:
                snapshot = (runtime.epoch, runtime.session)
        if outcome is not None:
            self._publish(outcome, previous_id)
            return outcome
        decision = self._run_mimo_transition(
            response.scene_id,
            directive,
            response.timestamp_ms,
            snapshot,
            elder_text=response.text,
        )
        self._publish(decision, previous_id)
        return decision

    def reset_scene(self, scene_id: str) -> None:
        """Forget the episode state so the scene can replay from the top."""

        self._streams(scene_id)
        with self._lock:
            runtime = self._runtimes.get(scene_id)
            if runtime is None:
                return
            # The epoch bump invalidates every in-flight MiMo call started
            # before the reset (their CAS snapshots carry the old epoch).
            self._runtimes[scene_id] = _SceneRuntime(
                session=SessionState(scene_id=scene_id),
                sequence=runtime.sequence,
                epoch=runtime.epoch + 1,
            )
        self._audit_event(kind="scene_reset", scene_id=scene_id)

    # -- shared plumbing ----------------------------------------------------

    def _streams(self, scene_id: str) -> PerceptionStreams:
        try:
            return self._scenes[scene_id]
        except KeyError as exc:
            if self._live_streams is not None:
                live = self._live_streams(scene_id)
                if live is not None:
                    return live
            raise UnknownSceneError(scene_id) from exc

    def _publish(self, decision: CareDecision, previous_id: str | None) -> None:
        """Push a newly emitted decision to the runtime stream, best-effort.

        Duplicate pushes are possible on rare CAS races; C de-duplicates by
        decision_id (documented in the C-facing API notes).
        """

        if self._publisher is None or decision.decision_id == previous_id:
            return
        try:
            self._publisher.publish_decision(decision)
        except Exception as exc:  # noqa: BLE001 - stream must never break decisions
            print(f"warning: decision publish failed: {exc}")

    def _runtime(self, scene_id: str) -> _SceneRuntime:
        runtime = self._runtimes.get(scene_id)
        if runtime is None:
            runtime = _SceneRuntime(session=SessionState(scene_id=scene_id))
            self._runtimes[scene_id] = runtime
        return runtime

    def _commit_rule_directive(
        self, runtime: _SceneRuntime, directive: Directive, timestamp_ms: float
    ) -> CareDecision | None:
        """Handle rejections, idempotent reuse, and pure-rule emissions in-lock.

        Returns the decision to hand back, or None when a MiMo call is needed.
        """

        if directive.reject_code is not None:
            raise DecisionRejectedError(directive.reject_code)
        if directive.skeleton is None:
            # Idempotent reuse: deliberately do NOT store the clock-advanced
            # session — polling ticks must not invalidate an in-flight MiMo
            # call's CAS snapshot, and the high-water mark re-advances on the
            # next real emission anyway.
            if runtime.pending is None:
                raise DecisionRejectedError("no_pending_decision")
            return runtime.pending
        if directive.mimo_task is not None and self._mimo is not None:
            return None
        decision = self._build_decision(
            runtime,
            directive,
            timestamp_ms,
            proposal=None,
            source=DecisionSource.RULE,
        )
        self._commit_emission(runtime, directive, decision)
        self._audit_event(
            kind="decision", scene_id=decision.scene_id, decision_id=decision.decision_id
        )
        return decision

    def _run_mimo_transition(
        self,
        scene_id: str,
        directive: Directive,
        timestamp_ms: float,
        snapshot: tuple[int, SessionState],
        *,
        elder_text: str | None,
    ) -> CareDecision:
        assert directive.skeleton is not None and directive.mimo_task is not None
        assert self._mimo is not None
        task = directive.mimo_task
        proposal: MimoProposal | None = None
        latency_ms: float | None = None
        attempts: int | None = None
        failure: str | None = None
        visual = self._visual_context(scene_id)
        try:
            result = self._call_mimo(scene_id, task, directive, elder_text, visual)
            latency_ms, attempts = result.latency_ms, result.attempts
            try:
                proposal = parse_mimo_proposal(result.content, task=task)
            except MimoSchemaError:
                # B spec section 8.4: one full re-ask when a well-formed HTTP
                # response carries an invalid proposal, then degrade.
                retry = self._call_mimo(scene_id, task, directive, elder_text, visual)
                latency_ms = (latency_ms or 0.0) + retry.latency_ms
                attempts = (attempts or 0) + retry.attempts
                proposal = parse_mimo_proposal(retry.content, task=task)
        except MimoTransportError as exc:
            failure = f"transport: {exc}"
            attempts = exc.attempts
        except MimoSchemaError as exc:
            failure = f"schema: {exc}"

        snapshot_epoch, snapshot_session = snapshot
        with self._lock:
            runtime = self._runtime(scene_id)
            if runtime.epoch != snapshot_epoch or runtime.session != snapshot_session:
                self._audit_event(
                    kind="mimo_discarded",
                    scene_id=scene_id,
                    note="session moved (rule escalation or reset) while MiMo was in flight",
                )
                if runtime.pending is None:
                    raise DecisionRejectedError("no_pending_decision")
                return runtime.pending
            if proposal is None:
                decision = self._build_degraded(
                    runtime, scene_id, timestamp_ms, failure, visual=visual
                )
                self._record_capture(runtime, decision)
                self._audit_event(
                    kind="degraded",
                    scene_id=scene_id,
                    decision_id=decision.decision_id,
                    latency_ms=latency_ms,
                    mimo_attempts=attempts,
                    visual_sent=visual is not None,
                    note=failure,
                )
                return decision
            decision = self._build_decision(
                runtime,
                directive,
                timestamp_ms,
                proposal=proposal,
                source=(
                    DecisionSource.MOCK
                    if self._config.demo_mode is DemoMode.MOCK
                    else DecisionSource.MIMO
                ),
                visual=visual,
            )
            self._commit_emission(runtime, directive, decision, proposal=proposal)
            self._audit_event(
                kind="decision",
                scene_id=scene_id,
                decision_id=decision.decision_id,
                latency_ms=latency_ms,
                mimo_attempts=attempts,
                visual_sent=visual is not None,
            )
            return decision

    def _visual_context(self, scene_id: str) -> VisualContextBundle | None:
        if not self._config.visual_enabled:
            return None
        streams = self._streams(scene_id)
        if not isinstance(streams, SceneStreams):
            # Live scenes have no bundle to pre-cut from.
            return None
        asset = load_visual_asset(streams.manifest.path.parent)
        if asset is None:
            return None
        return VisualContextBundle(
            record=visual_context_record(asset), payload=visual_payload(asset)
        )

    def _call_mimo(
        self,
        scene_id: str,
        task: MimoTask,
        directive: Directive,
        elder_text: str | None,
        visual: VisualContextBundle | None,
    ) -> MimoCallResult:
        assert self._mimo is not None and directive.skeleton is not None
        streams = self._streams(scene_id)
        context = build_decision_context(
            streams, timestamp_ms=directive.next_state.context_high_water_ms
        )
        system_prompt = build_system_prompt(
            task, persona=self._config.persona, visual=visual is not None
        )
        text_body = build_user_prompt(
            task,
            perception_summary=_perception_summary(context),
            interaction_summary={
                "phase": directive.next_state.phase.value,
                "clarification_used": directive.next_state.clarification_used,
                "complaint_text": directive.next_state.complaint_text,
            },
            elder_text=elder_text,
        )
        user_content: str | list[dict[str, Any]] = text_body
        if visual is not None:
            user_content = [{"type": "text", "text": text_body}, visual.payload]
        return self._mimo.complete_task(
            scene_id=scene_id,
            task=task,
            system_prompt=system_prompt,
            user_content=user_content,
        )

    def _commit_emission(
        self,
        runtime: _SceneRuntime,
        directive: Directive,
        decision: CareDecision,
        *,
        proposal: MimoProposal | None = None,
    ) -> None:
        next_state = replace(directive.next_state, pending_decision_id=decision.decision_id)
        if proposal is not None and proposal.action_card is not None:
            draft = _bind_elder_quote(proposal.action_card, next_state.complaint_text)
            next_state = replace(next_state, card_draft=draft)
        runtime.session = next_state
        runtime.pending = decision
        self._record_capture(runtime, decision)

    def _next_decision_id(self, runtime: _SceneRuntime) -> str:
        runtime.sequence += 1
        return f"decision-{runtime.sequence:04d}"

    def _privacy_mode(self, scene_id: str) -> PrivacyMode:
        return self._config.scene_privacy.get(
            scene_id, self._config.trigger.default_privacy_mode
        )

    def _build_decision(
        self,
        runtime: _SceneRuntime,
        directive: Directive,
        timestamp_ms: float,
        *,
        proposal: MimoProposal | None,
        source: DecisionSource,
        visual: VisualContextBundle | None = None,
    ) -> CareDecision:
        skeleton = directive.skeleton
        assert skeleton is not None
        persona = self._config.persona
        template = _TEMPLATES[skeleton.template]
        elder_message = _fill(template.elder_message, persona)
        family_notification = _fill(template.family_notification, persona)
        reason_summary = template.reason_summary
        uncertainty = template.uncertainty
        dialogue_goal = skeleton.dialogue_goal
        if proposal is not None:
            reason_summary = proposal.reason_summary
            uncertainty = proposal.uncertainty
            if skeleton.need_dialogue and proposal.elder_message is not None:
                elder_message = proposal.elder_message
            if proposal.dialogue_goal is not None:
                dialogue_goal = proposal.dialogue_goal
            if (
                skeleton.action is DecisionAction.NOTIFY_FAMILY
                and proposal.family_notification is not None
            ):
                family_notification = proposal.family_notification
        card = self._resolve_card(runtime, skeleton, proposal)
        if not skeleton.need_dialogue:
            elder_message = None
        # Invariant, not policy: the machine owns state/risk and already encodes
        # legal exits from the escalated band in its next-state floor.
        if violates_risk_floor(
            skeleton.state, skeleton.risk_level, risk_floor=directive.next_state.risk_floor
        ):
            raise DecisionRejectedError("risk_floor_violation")
        return CareDecision(
            scene_id=runtime.session.scene_id,
            decision_id=self._next_decision_id(runtime),
            timestamp_ms=timestamp_ms,
            state=skeleton.state,
            risk_level=skeleton.risk_level,
            privacy_mode=self._privacy_mode(runtime.session.scene_id),
            need_dialogue=skeleton.need_dialogue,
            dialogue_goal=dialogue_goal,
            elder_message=elder_message,
            family_notification=family_notification,
            action=skeleton.action,
            reason_summary=reason_summary,
            uncertainty=uncertainty,
            fallback_used=False,
            source=source,
            demo_mode=self._config.demo_mode,
            consent_required=skeleton.consent_required,
            response_timeout_ms=skeleton.response_timeout_ms,
            action_card=card,
            visual_context=None if visual is None else visual.record,
        )

    def _resolve_card(
        self,
        runtime: _SceneRuntime,
        skeleton: DecisionSkeleton,
        proposal: MimoProposal | None,
    ) -> ActionCard | None:
        if skeleton.include_card is None:
            return None
        card = runtime.session.card_draft
        if proposal is not None and proposal.action_card is not None:
            card = proposal.action_card
        if card is None:
            return None
        # The quote shown to the family must be the elder's actual words, never
        # model-generated text (Codex review P1: fabricated-quote risk).
        card = _bind_elder_quote(card, runtime.session.complaint_text)
        if skeleton.include_card is CardStatus.CONFIRMED:
            return replace(card, status=CardStatus.CONFIRMED)
        return card

    def _build_degraded(
        self,
        runtime: _SceneRuntime,
        scene_id: str,
        timestamp_ms: float,
        failure: str | None,
        *,
        visual: VisualContextBundle | None = None,
    ) -> CareDecision:
        return CareDecision(
            scene_id=scene_id,
            decision_id=self._next_decision_id(runtime),
            timestamp_ms=timestamp_ms,
            state=DecisionState.DEGRADED,
            risk_level=runtime.session.risk_floor,
            privacy_mode=self._privacy_mode(scene_id),
            need_dialogue=False,
            dialogue_goal=None,
            elder_message=None,
            family_notification=None,
            action=DecisionAction.OBSERVE,
            reason_summary="认知服务暂不可用，已降级为持续观察，可切换演示模式后重试",
            uncertainty=Uncertainty.HIGH,
            fallback_used=True,
            source=DecisionSource.DEGRADED,
            demo_mode=self._config.demo_mode,
            visual_context=None if visual is None else visual.record,
        )

    # -- record mode --------------------------------------------------------

    def _load_replays(self) -> None:
        for scene_id, streams in self._scenes.items():
            path = streams.manifest.resolve_stream_path("recorded_decisions")
            if path is None:
                fallback = streams.manifest.path.parent / "recorded_decisions.jsonl"
                path = fallback if fallback.is_file() else None
            if path is None:
                continue
            decisions = load_recorded_decisions(path, expected_scene_id=scene_id)
            if decisions:
                self._replays[scene_id] = decisions

    def _replay_current(self, scene_id: str) -> CareDecision:
        with self._lock:
            runtime = self._runtime(scene_id)
            decisions = self._replay_decisions(scene_id)
            index = min(runtime.replay_index, len(decisions) - 1)
            return as_recorded(decisions[index])

    def _replay_advance(self, scene_id: str, response_decision_id: str) -> CareDecision:
        with self._lock:
            runtime = self._runtime(scene_id)
            decisions = self._replay_decisions(scene_id)
            current = decisions[min(runtime.replay_index, len(decisions) - 1)]
            if response_decision_id != current.decision_id:
                raise DecisionRejectedError("stale_decision")
            runtime.replay_index = min(runtime.replay_index + 1, len(decisions) - 1)
            return as_recorded(decisions[runtime.replay_index])

    def _replay_decisions(self, scene_id: str) -> tuple[CareDecision, ...]:
        decisions = self._replays.get(scene_id)
        if not decisions:
            raise DecisionRejectedError("no_recorded_decisions")
        return decisions

    # -- capture and audit --------------------------------------------------

    def _record_capture(self, runtime: _SceneRuntime, decision: CareDecision) -> None:
        if not self._config.record_capture:
            return
        if decision.state is DecisionState.DEGRADED:
            # Degraded notices are not committed session states; replaying one
            # would wedge the recorded timeline (Codex review P2).
            return
        streams = self._scenes.get(decision.scene_id)
        if streams is None:
            # Live scenes have no bundle directory to capture into.
            return
        target = streams.manifest.path.parent / "recorded_decisions.jsonl"
        try:
            append_recorded_decision(target, decision)
        except OSError as exc:
            # Observability must never block a committed care decision.
            print(f"warning: record capture failed for {decision.decision_id}: {exc}")

    def _audit_event(
        self,
        *,
        kind: str,
        scene_id: str,
        decision_id: str | None = None,
        latency_ms: float | None = None,
        mimo_attempts: int | None = None,
        visual_sent: bool = False,
        note: str | None = None,
    ) -> None:
        if self._audit is None:
            return
        self._audit.record(
            kind=kind,
            scene_id=scene_id,
            mode=self._config.demo_mode.value,
            decision_id=decision_id,
            latency_ms=latency_ms,
            mimo_attempts=mimo_attempts,
            visual_sent=visual_sent,
            note=note,
        )


def _fill(text: str | None, persona: PersonaConfig) -> str | None:
    if text is None:
        return None
    return text.replace("{name}", persona.elder_name).replace(
        "{relation}", persona.family_relation
    )


def _bind_elder_quote(card: ActionCard, complaint_text: str | None) -> ActionCard:
    if complaint_text is None or card.elder_quote == complaint_text:
        return card
    return replace(card, elder_quote=complaint_text)


def _perception_summary(context: DecisionContext) -> dict[str, object]:
    posture = context.latest_posture
    transition = context.active_transition
    return {
        "timestamp_ms": context.timestamp_ms,
        "posture": None if posture is None else posture.posture.value,
        "posture_duration_ms": None if posture is None else posture.posture_duration_ms,
        "motion_level": None if posture is None else posture.motion_level.value,
        "landmark_quality": context.input_quality.value,
        "recent_transition": None if transition is None else transition.transition.value,
    }
