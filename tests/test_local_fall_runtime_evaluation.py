from scripts.training.evaluate_local_fall_runtime import CaseResult, summarize


def _result(
    case_id: str,
    *,
    split: str,
    label: str,
    triggered: bool,
    duplicate: bool = False,
) -> CaseResult:
    return CaseResult(
        case_id=case_id,
        split=split,
        label=label,
        category="test",
        sampled_frames=10,
        person_detected_frames=10,
        transition_counts={"fall_like_transition": 1} if triggered else {},
        fall_event_count=2 if duplicate else int(triggered),
        fall_triggered=triggered,
        duplicate_fall_events=duplicate,
        first_fall_event_end_ms=1000.0 if triggered else None,
        fall_events=(),
        elapsed_seconds=0.1,
        mean_inference_ms=2.0,
        p95_inference_ms=2.5,
    )


def test_demo_gate_passes_only_with_high_fall_coverage_and_low_false_alerts() -> None:
    results = [
        *[
            _result(f"fall-{index}", split="test", label="fall", triggered=True)
            for index in range(8)
        ],
        *[
            _result(f"normal-{index}", split="test", label="normal", triggered=False)
            for index in range(20)
        ],
    ]
    report = summarize(results)
    assert report["engineering_gate"]["passed"] is True
    assert report["heldout"]["fall_trigger_rate"] == 1.0
    assert report["heldout"]["normal_alert_rate"] == 0.0


def test_demo_gate_fails_for_low_fall_coverage() -> None:
    results = [
        _result("fall-hit", split="val", label="fall", triggered=True),
        _result("fall-miss", split="test", label="fall", triggered=False),
        _result("normal", split="test", label="normal", triggered=False),
    ]
    report = summarize(results)
    assert report["engineering_gate"]["passed"] is False
    assert report["heldout"]["fall_trigger_rate"] == 0.5


def test_demo_gate_fails_for_false_alert_or_duplicate_event() -> None:
    results = [
        _result("fall", split="test", label="fall", triggered=True, duplicate=True),
        _result("normal-alert", split="test", label="normal", triggered=True),
    ]
    report = summarize(results)
    assert report["engineering_gate"]["passed"] is False
    assert report["heldout"]["normal_alert_rate"] == 1.0
    assert report["heldout"]["duplicate_rate"] == 0.5
