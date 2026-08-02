from __future__ import annotations

import os
import socket
import sys
import time
from pathlib import Path

import pytest
from reme.local_demo import (
    LocalDemoConfig,
    LocalDemoError,
    assert_port_available,
    build_child_commands,
    load_env_file,
    start_process,
    stop_processes,
)


def test_load_env_file_accepts_setup_script_format(tmp_path: Path) -> None:
    env_file = tmp_path / "mimo.env"
    env_file.write_text(
        "# local secret\nexport MIMO_API_KEY='secret value'\nMIMO_BASE_URL=https://example.test/v1\n",
        encoding="utf-8",
    )

    assert load_env_file(env_file) == {
        "MIMO_API_KEY": "secret value",
        "MIMO_BASE_URL": "https://example.test/v1",
    }


def test_load_env_file_rejects_shell_commands(tmp_path: Path) -> None:
    env_file = tmp_path / "mimo.env"
    env_file.write_text("MIMO_API_KEY=$(echo unsafe)\n", encoding="utf-8")

    with pytest.raises(LocalDemoError, match="one shell word"):
        load_env_file(env_file)


def test_build_child_commands_connects_a_b_and_vite(tmp_path: Path) -> None:
    config = LocalDemoConfig(
        root=tmp_path,
        host="127.0.0.1",
        frontend_port=14174,
        perception_port=18770,
        decision_port=18100,
        browser_input_mode="landmarks",
    )

    commands = build_child_commands(config)

    assert commands["A"][-2:] == ["--browser-input-mode", "landmarks"]
    assert commands["B"][-1] == "ws://127.0.0.1:18770/ws/events"
    assert commands["C"][-3:] == ["--port", "14174", "--strictPort"]
    assert config.acceptance_url == "http://127.0.0.1:14174/typical-demo.html"


def test_assert_port_available_rejects_occupied_listener() -> None:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        port = listener.getsockname()[1]
        with pytest.raises(LocalDemoError, match="already in use"):
            assert_port_available("127.0.0.1", port)


@pytest.mark.skipif(os.name != "posix", reason="process-group supervision is POSIX-only")
def test_stop_processes_kills_spawned_process_group(tmp_path: Path) -> None:
    managed = start_process(
        "C",
        [
            sys.executable,
            "-c",
            (
                "import subprocess, sys, time; "
                "subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)']); "
                "time.sleep(60)"
            ),
        ],
        cwd=tmp_path,
        env=os.environ.copy(),
    )
    time.sleep(0.15)

    stop_processes([managed])

    with pytest.raises(ProcessLookupError):
        os.killpg(managed.process.pid, 0)
