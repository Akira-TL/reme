"""Chinese prompt assembly for B's three MiMo tasks.

Design notes from the 2026-08-01 live smoke: pin the elder's appellation from
config (the model drifts otherwise), disable thinking, demand a bare JSON
object, and enumerate every field with its legal values. The "rather silent
than wrong" principle keeps hallucinated escalations out; hard escalations are
rule-owned and the model is told it cannot touch them.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass

from reme.decision.state_machine import MimoTask


@dataclass(frozen=True, slots=True)
class PersonaConfig:
    """Fixed appellations injected into every prompt."""

    elder_name: str = "王奶奶"
    family_relation: str = "家人"


_TASK_DUTY = {
    MimoTask.COMPOSE_CHECK_IN: "根据感知摘要，为一次不惊扰的主动问候拟一句开场白。",
    MimoTask.COMPOSE_KITCHEN_SHARE: (
        "当前已确认看到奶奶在厨房包包子。用自然口语询问她是否愿意把这个生活片段分享给孩子；"
        "必须等待老人明确回复，不能声称已经分享，也不能替老人做决定。"
    ),
    MimoTask.INTERPRET_RESPONSE: (
        "根据感知摘要和老人的回话，理解老人的需求，判断下一步是澄清、征求授权，还是需要家人协助。"
    ),
    MimoTask.COMPOSE_CARD: "老人已同意告知家人。把老人的诉求整理成一张给家人的行动卡和一条通知。",
}

_TASK_STATES = {
    MimoTask.COMPOSE_CHECK_IN: '"check_in_required"',
    MimoTask.COMPOSE_KITCHEN_SHARE: '"consent_required"',
    MimoTask.INTERPRET_RESPONSE: (
        '"check_in_required" | "consent_required" | "family_notification_required"'
    ),
    MimoTask.COMPOSE_CARD: '"family_notification_required"',
}

_TASK_EXAMPLE = {
    MimoTask.COMPOSE_CHECK_IN: (
        '{"state":"check_in_required","risk_level":2,"need_dialogue":true,'
        '"dialogue_goal":"understand_need","elder_message":"{name}，坐了挺久啦，今天午饭吃得还顺口吗？",'
        '"family_notification":null,"consent_required":false,'
        '"reason_summary":"长时间静坐，例行轻量问候","uncertainty":"medium",'
        '"privacy_mode":null,"action_card":null}'
    ),
    MimoTask.COMPOSE_KITCHEN_SHARE: (
        '{"state":"consent_required","risk_level":2,"need_dialogue":true,'
        '"dialogue_goal":"request_consent","elder_message":"{name}，我看到您在包包子。要不要把这个生活片段分享给{relation}看看？",'
        '"family_notification":null,"consent_required":true,'
        '"reason_summary":"看到厨房包包子场景，先征求老人分享授权","uncertainty":"low",'
        '"privacy_mode":null,"action_card":null}'
    ),
    MimoTask.INTERPRET_RESPONSE: (
        '{"state":"consent_required","risk_level":2,"need_dialogue":true,'
        '"dialogue_goal":"request_consent","elder_message":"{name}，要不要把牙疼的事告诉{relation}，让他们帮您约个牙科？",'
        '"family_notification":null,"consent_required":true,'
        '"reason_summary":"主诉牙疼影响进食，非紧急，先征求授权","uncertainty":"medium",'
        '"privacy_mode":null,"action_card":null}'
    ),
    MimoTask.COMPOSE_CARD: (
        '{"state":"family_notification_required","risk_level":3,"need_dialogue":true,'
        '"dialogue_goal":null,"elder_message":"{name}，好的，我已经把这件事告诉{relation}了。",'
        '"family_notification":"老人主诉牙疼、进食困难，已同意告知家人，请尽快帮忙安排口腔科检查。",'
        '"consent_required":false,'
        '"reason_summary":"老人已授权，生成家人行动卡","uncertainty":"low","privacy_mode":null,'
        '"action_card":{"event":"长时间静坐 + 主诉牙疼","elder_quote":"牙疼，饭咬不动。",'
        '"system_judgment":"疑似口腔问题影响进食，非紧急","suggested_action":"本周内预约口腔科检查",'
        '"time_window":"3 天内","status":"pending"}}'
    ),
}

_VISUAL_ADDENDUM = (
    "\n随附的画面仅用于判断大体身体状态与隐私展示档位，"
    "不得识别身份、描述外貌，也不得描述画面中与本次判断无关的家庭环境细节。"
)


_CONTEXT_ADDENDUM = (
    "\n6. 附加的【行为特征】【长期记忆】【居家上下文】是系统整理的既定观察："
    "用它们判断行为目的与轻重缓急，可自然延续记忆中的关怀话题，"
    "但不得罗列监控细节，不得据此下诊断或编造记忆里没有的事。"
)


def build_system_prompt(
    task: MimoTask, *, persona: PersonaConfig, visual: bool = False, context_aware: bool = False
) -> str:
    """Assemble the per-task system prompt."""

    example = _TASK_EXAMPLE[task].replace("{name}", persona.elder_name)
    example = example.replace("{relation}", persona.family_relation)
    sections = [
        f"你是「Reme 居家关怀」系统的决策助手。服务对象是独居老人{persona.elder_name}——"
        f"对老人说话时称呼固定用「{persona.elder_name}」，不得更换，不得猜测性别或年龄；"
        f"家人一律称「{persona.family_relation}」。",
        f"本次任务：{_TASK_DUTY[task]}你不是医生，不做诊断。",
        "判断守则：\n"
        '1. 证据不足时宁可少判：拿不准就把 uncertainty 设为 "high" 并选保守 state，'
        "不得编造画面里没有的跌倒、病名或情绪。\n"
        "2. 单次躺卧不等于跌倒。跌倒与超时相关的升级由本地规则负责；"
        "你不得升级、降低或撤销本地规则已经做出的任何告警。\n"
        "3. 把老人的具体情况告诉家人之前，必须先征得老人同意。\n"
        "4. 你不能声称已经联系了任何人；实际通知由系统执行。\n"
        "5. 只输出一个 JSON 对象：字段一个不多一个不少，枚举只取给定值，"
        "可空字段没有内容时用 null（不是空字符串），不要输出任何解释文字或代码块围栏。",
        "输出字段定义：\n"
        f"- state: {_TASK_STATES[task]}\n"
        '- risk_level: 0..4 的整数（state 为 "consent_required" 时必须为 2）\n'
        "- need_dialogue: true | false\n"
        '- dialogue_goal: "confirm_safety" | "understand_need" | "request_consent" | null\n'
        f"- elder_message: 对老人说的一句话（口语、简短、以「{persona.elder_name}」开头）| null\n"
        "- family_notification: 给家人的通知文本 | null\n"
        "- consent_required: true | false\n"
        "- reason_summary: 40 字以内的判断依据\n"
        '- uncertainty: "low" | "medium" | "high" | "unknown"\n'
        '- privacy_mode: "visible" | "blurred" | "skeleton_only" | "hidden" | null'
        "（拿不准给 null）\n"
        "- action_card: null 或 {event, elder_quote, system_judgment, suggested_action, "
        'time_window, status}；六项必须全部非空，status 固定 "pending"，'
        "elder_quote 必须逐字取自老人原话，不得改写或虚构",
        f"输出示例：\n{example}",
    ]
    if visual:
        sections[2] += _VISUAL_ADDENDUM
    if context_aware:
        sections[2] += _CONTEXT_ADDENDUM
    return "\n\n".join(sections)


# Context sections may echo remembered elder speech; collapsing whitespace and
# capping length keeps a crafted complaint from smuggling extra 【标签】 lines
# or walls of text into the prompt structure (Codex R3).
_SECTION_MAX_CHARS = 300


def _sanitize_section(text: str) -> str:
    collapsed = " ".join(text.split())
    return collapsed[:_SECTION_MAX_CHARS]


def build_user_prompt(
    task: MimoTask,
    *,
    perception_summary: Mapping[str, object],
    interaction_summary: Mapping[str, object],
    elder_text: str | None,
    context_sections: Mapping[str, str] | None = None,
) -> str:
    """Assemble the structured user message body.

    ``context_sections`` carries the optional cognition layers (ADR-0006):
    each ``title -> content`` pair renders as one ``【title】content`` line in
    the caller-given order, between the interaction state and the elder's
    words.  ``None`` or empty keeps the v1 body byte-identical.
    """

    lines = [
        f"【任务】{_TASK_DUTY[task]}",
        f"【感知摘要】{json.dumps(dict(perception_summary), ensure_ascii=False)}",
        f"【交互状态】{json.dumps(dict(interaction_summary), ensure_ascii=False)}",
    ]
    if context_sections:
        lines.extend(
            f"【{_sanitize_section(title)}】{_sanitize_section(content)}"
            for title, content in context_sections.items()
        )
    if elder_text is not None:
        lines.append(f"【老人回话】{json.dumps(elder_text, ensure_ascii=False)}")
    lines.append("只输出 JSON 对象。")
    return "\n".join(lines)
