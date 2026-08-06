from __future__ import annotations

import os
import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest
import reme.runtime.launcher as local_demo_module
from reme.runtime.launcher import (
    LocalDemoConfig,
    LocalDemoError,
    assert_port_available,
    build_child_commands,
    build_parser,
    ensure_frontend_dependencies,
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


def test_launcher_defaults_to_browser_gpu_landmarks() -> None:
    assert LocalDemoConfig(root=Path("/tmp/reme")).browser_input_mode == "landmarks"
    assert build_parser().parse_args([]).browser_input_mode == "landmarks"


def test_build_child_commands_uses_unified_backend_and_vite(tmp_path: Path) -> None:
    config = LocalDemoConfig(
        root=tmp_path,
        host="127.0.0.1",
        backend_port=18770,
        frontend_port=14174,
        browser_input_mode="landmarks",
    )

    commands = build_child_commands(config)

    assert commands["BACKEND"][1:3] == ["-m", "reme.runtime.server"]
    assert commands["BACKEND"][-2:] == ["--browser-input-mode", "landmarks"]
    assert "--a-events-url" not in commands["BACKEND"]
    assert commands["FRONTEND"][-3:] == ["--port", "14174", "--strictPort"]
    assert config.backend_http_url == "http://127.0.0.1:18770"
    assert config.acceptance_url == "http://127.0.0.1:14174/"
    assert config.mimo_env_path == tmp_path / ".env"


def test_assert_port_available_rejects_occupied_listener() -> None:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        port = listener.getsockname()[1]
        with pytest.raises(LocalDemoError, match="already in use"):
            assert_port_available("127.0.0.1", port)


def _write_frontend_dependency_markers(root: Path) -> LocalDemoConfig:
    frontend = root / "frontend"
    (frontend / "node_modules" / ".bin").mkdir(parents=True)
    (frontend / "node_modules" / ".bin" / "vite").write_text("", encoding="utf-8")
    (frontend / "scripts").mkdir()
    (frontend / "scripts" / "check-native-deps.mjs").write_text("", encoding="utf-8")
    (frontend / "package-lock.json").write_text("{}", encoding="utf-8")
    return LocalDemoConfig(root=root)


def test_ensure_frontend_dependencies_keeps_compatible_install(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config = _write_frontend_dependency_markers(tmp_path)
    calls: list[list[str]] = []

    monkeypatch.setattr(local_demo_module.shutil, "which", lambda command: f"/bin/{command}")

    def fake_run(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
        calls.append(command)
        return subprocess.CompletedProcess(command, 0)

    monkeypatch.setattr(local_demo_module.subprocess, "run", fake_run)

    ensure_frontend_dependencies(config, {})

    assert calls == [["node", "scripts/check-native-deps.mjs"]]


def test_ensure_frontend_dependencies_reinstalls_cross_platform_copy(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config = _write_frontend_dependency_markers(tmp_path)
    return_codes = iter([1, 0, 0])
    calls: list[list[str]] = []

    monkeypatch.setattr(local_demo_module.shutil, "which", lambda command: f"/bin/{command}")

    def fake_run(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
        calls.append(command)
        return subprocess.CompletedProcess(command, next(return_codes))

    monkeypatch.setattr(local_demo_module.subprocess, "run", fake_run)

    ensure_frontend_dependencies(config, {})

    assert calls == [
        ["node", "scripts/check-native-deps.mjs"],
        ["npm", "ci"],
        ["node", "scripts/check-native-deps.mjs"],
    ]


@pytest.mark.skipif(os.name != "posix", reason="process-group supervision is POSIX-only")
def test_stop_processes_kills_spawned_process_group(tmp_path: Path) -> None:
    managed = start_process(
        "FRONTEND",
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
