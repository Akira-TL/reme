from reme.runtime.decision.voice_dialogue import _strip_prompt_echo


def test_strip_prompt_echo_drops_prompt_only_transcript() -> None:
    prompt = "奶奶，您还好吗？有没有摔倒？"

    assert _strip_prompt_echo("奶奶您还好吗有没有摔倒", prompt) == ""


def test_strip_prompt_echo_keeps_user_reply_after_prompt_fragment() -> None:
    prompt = "奶奶，您还好吗？有没有摔倒？"

    assert _strip_prompt_echo("奶奶您还好吗我没事", prompt) == "我没事"
    assert _strip_prompt_echo("有没有摔倒我需要帮助", prompt) == "我需要帮助"


def test_strip_prompt_echo_leaves_unrelated_user_reply_unchanged() -> None:
    prompt = "奶奶，您还好吗？有没有摔倒？"

    assert _strip_prompt_echo("我没事，不用担心", prompt) == "我没事，不用担心"
