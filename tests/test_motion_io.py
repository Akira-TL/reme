import json
from pathlib import Path

import pytest
from reme.motion_io import MotionDataError, load_motion_jsonl


def test_load_motion_jsonl_reads_normalized_observations(tmp_path: Path) -> None:
    path = tmp_path / "motion.jsonl"
    path.write_text(
        "\n".join(
            [
                json.dumps(
                    {
                        "offset_ms": 0,
                        "torso_angle_deg": 10.0,
                        "center_y": 0.40,
                        "visibility": 0.95,
                    }
                ),
                json.dumps(
                    {
                        "offset_ms": 500,
                        "torso_angle_deg": 72.0,
                        "center_y": 0.70,
                        "visibility": 0.91,
                    }
                ),
            ]
        ),
        encoding="utf-8",
    )

    observations = load_motion_jsonl(path)

    assert [observation.offset_ms for observation in observations] == [0, 500]
    assert observations[1].torso_angle_deg == 72.0


def test_load_motion_jsonl_reports_the_invalid_line(tmp_path: Path) -> None:
    path = tmp_path / "motion.jsonl"
    path.write_text('{"offset_ms": 0}\n', encoding="utf-8")

    with pytest.raises(MotionDataError, match="line 1"):
        load_motion_jsonl(path)
