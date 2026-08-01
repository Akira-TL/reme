"""Pre-authored MiMo payloads for the four pre-recorded demo scenes.

Payloads cover only the MiMo call sites; deterministic steps (fall check-in,
timeout escalation, consent bookkeeping, receipts) come from rules and need no
scripted answer. The fall scene therefore ships an empty script — running the
whole loop offline is contract behaviour, not a gap.
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

SCENE_NORMAL = "normal_daily_01"
SCENE_PRIVACY = "privacy_mode_01"
SCENE_NEED_LOOP = "toothache_loop_01"
SCENE_FALL_SILENT = "fall_no_response_01"

_SCRIPTS: dict[str, list[dict[str, Any]]] = {
    SCENE_NORMAL: [
        {
            "state": "normal",
            "risk_level": 0,
            "privacy_mode": "skeleton_only",
            "need_dialogue": False,
            "dialogue_goal": None,
            "elder_message": None,
            "family_notification": None,
            "consent_required": False,
            "action": "none",
            "reason_summary": "静坐时长与日间作息基线一致，无需介入。",
            "uncertainty": "low",
        }
    ],
    SCENE_PRIVACY: [
        {
            "state": "observe",
            "risk_level": 1,
            "privacy_mode": "hidden",
            "need_dialogue": False,
            "dialogue_goal": None,
            "elder_message": None,
            "family_notification": None,
            "consent_required": False,
            "action": "observe",
            "reason_summary": "识别到隐私敏感情境，画面转为隐藏，仅保留状态观察。",
            "uncertainty": "medium",
        }
    ],
    SCENE_NEED_LOOP: [
        {
            "state": "check_in_required",
            "risk_level": 1,
            "privacy_mode": "skeleton_only",
            "need_dialogue": True,
            "dialogue_goal": "确认长时间静坐原因，留意饮食情况",
            "elder_message": "今天午饭吃得还顺口吗？",
            "family_notification": None,
            "consent_required": False,
            "action": "ask_elder",
            "reason_summary": "午间长时间静坐且未见进食动作，与基线不符。",
            "uncertainty": "medium",
        },
        {
            "state": "consent_required",
            "risk_level": 2,
            "privacy_mode": "skeleton_only",
            "need_dialogue": True,
            "dialogue_goal": "request_consent",
            "elder_message": "牙口不舒服要紧，需要我把这件事告诉家人，帮您安排看牙吗？",
            "family_notification": None,
            "consent_required": True,
            "action": "ask_elder",
            "reason_summary": "老人主诉牙疼影响进食，属需要家人协助的普通需求。",
            "uncertainty": "low",
            "action_card": {
                "event": "长时间静坐 + 主诉牙疼",
                "elder_quote": "牙疼，饭咬不动。",
                "system_judgment": "疑似口腔问题影响进食，非紧急",
                "suggested_action": "本周内预约口腔科检查",
                "time_window": "3 天内",
                "status": "pending",
            },
        },
    ],
    SCENE_FALL_SILENT: [],
}


def scene_ids() -> tuple[str, ...]:
    return tuple(_SCRIPTS)


def scripted_payloads(scene_id: str) -> Iterator[dict[str, Any]]:
    """Yield the scripted MiMo payloads for a scene, in call order."""

    if scene_id not in _SCRIPTS:
        raise KeyError(f"unknown mock scene {scene_id!r}; known: {sorted(_SCRIPTS)}")
    return iter(_SCRIPTS[scene_id])
