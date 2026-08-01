"""Prompt assembly for MiMo decision calls (structured path).

Only structured facts and dialogue text leave the device on this path; the
system prompt pins the persona, the output contract, and the safety rule that
deterministic escalation is never MiMo's to cancel. Address terms come from
configuration, never from model guesses (G-01 observation #2).
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

_SYSTEM_PROMPT = """你是 Reme 的居家关怀决策助手，负责判断是否需要以及如何轻量介入老人当下的状态。

硬性规则：
1. 只依据给出的结构化事实与对话内容判断，不臆测画面细节，不输出医疗诊断。
2. 高风险升级由系统确定性规则负责，你不能取消或降低已触发的家属告警，只能补充解释。
3. 对老人的称呼固定使用「{address_term}」，不要自行猜测或更换称呼。
4. 普通需求必须先征得老人同意（consent_required=true）才能通知家属。
5. 语气自然、简短、有温度，一次只问一件事。

你必须只输出一个 JSON 对象，不含任何其他文字，字段如下：
{{"state": "normal|observe|check_in_required|consent_required|\
family_notification_required|urgent_attention|resolved|degraded 之一",
"risk_level": 0 到 4 的整数,
"privacy_mode": "visible|blurred|skeleton_only|hidden 之一",
"need_dialogue": true 或 false,
"dialogue_goal": 字符串或 null,
"elder_message": 给老人的话或 null（need_dialogue=false 时必须为 null）,
"family_notification": 给家属的通知文本或 null,
"consent_required": true 或 false,
"action": "none|observe|ask_elder|notify_family|show_urgent_attention|mark_resolved 之一",
"reason_summary": 一句话判断依据,
"uncertainty": "low|medium|high|unknown 之一",
"action_card": null 或 {{"event": "...", "elder_quote": "...", "system_judgment": "...", \
"suggested_action": "...", "time_window": "...", "status": "pending"}}}}"""


@dataclass
class DecisionContext:
    """Structured facts accumulated for one scene, consumed by prompt assembly."""

    scene_id: str
    address_term: str = "叔叔"
    baseline_summary: str | None = None
    time_context: str | None = None
    observations: list[dict[str, Any]] = field(default_factory=list)
    transitions: list[dict[str, Any]] = field(default_factory=list)
    dialogue: list[dict[str, str]] = field(default_factory=list)
    max_observations: int = 5

    def add_observation(self, observation: dict[str, Any]) -> None:
        self.observations.append(observation)
        if len(self.observations) > self.max_observations:
            self.observations.pop(0)

    def add_transition(self, event: dict[str, Any]) -> None:
        self.transitions.append(event)

    def add_dialogue(self, role: str, text: str) -> None:
        self.dialogue.append({"role": role, "text": text})


def build_messages(context: DecisionContext, instruction: str) -> list[dict[str, Any]]:
    """Compose chat messages: pinned system prompt + facts + task instruction."""

    facts: dict[str, Any] = {
        "scene_id": context.scene_id,
        "time_context": context.time_context,
        "baseline_summary": context.baseline_summary,
        "recent_posture_observations": context.observations,
        "recent_transition_events": context.transitions,
        "dialogue_history": context.dialogue,
    }
    user_content = (
        "当前结构化事实：\n"
        + json.dumps(facts, ensure_ascii=False, indent=1)
        + "\n\n任务：\n"
        + instruction
    )
    return [
        {"role": "system", "content": _SYSTEM_PROMPT.format(address_term=context.address_term)},
        {"role": "user", "content": user_content},
    ]
