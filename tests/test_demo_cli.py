import json
import socket
from pathlib import Path

from experiments.legacy_motion_demo.demo import main


def test_demo_cli_runs_without_network_or_raw_media_artifacts(
    tmp_path: Path,
    monkeypatch,
    capsys,
) -> None:
    monkeypatch.chdir(tmp_path)

    def forbid_network(*args, **kwargs):
        raise AssertionError("the motion-data demo must not open a network socket")

    monkeypatch.setattr(socket, "socket", forbid_network)

    exit_code = main(["--scenario", "fall-no-response"])

    assert exit_code == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["status"] == "family_notified"
    assert [decision["action"] for decision in payload["decisions"]] == [
        "local_check_in",
        "family_notification",
    ]
    assert payload["audit"] == {
        "adapter": "synthetic:fall-no-response",
        "heuristic_is_clinically_validated": False,
        "input_kind": "motion_data",
        "network_access": False,
        "raw_media_in_core_pipeline": False,
        "raw_media_persisted": False,
    }
    assert list(tmp_path.iterdir()) == []
