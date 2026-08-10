from __future__ import annotations

import os
import signal
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path
from types import SimpleNamespace

import pytest
import reme.runtime.launcher as local_demo_module
from reme.runtime.launcher import (
    LocalDemoConfig,
    LocalDemoError,
    assert_port_available,
    build_child_commands,
    build_child_env,
    build_parser,
    ensure_frontend_dependencies,
    ensure_relay_dependencies,
    install_shutdown_signal_handlers,
    load_env_file,
    preload_demo_history,
    restore_signal_handlers,
    run_local_demo,
    start_process,
    stop_processes,
    validate_config,
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


def test_launcher_defaults_to_backend_jpeg_inference() -> None:
    assert LocalDemoConfig(root=Path("/tmp/reme")).browser_input_mode == "jpeg"
    assert build_parser().parse_args([]).browser_input_mode == "jpeg"


def test_build_child_commands_uses_unified_backend_and_vite(tmp_path: Path) -> None:
    config = LocalDemoConfig(
        root=tmp_path,
        host="127.0.0.1",
        backend_port=18770,
        frontend_port=14174,
        relay_port=18787,
        browser_input_mode="jpeg",
    )

    commands = build_child_commands(config, relay_node="/usr/bin/node")

    assert commands["BACKEND"][1:3] == ["-m", "reme.runtime.server"]
    assert commands["BACKEND"][-2:] == ["--browser-input-mode", "jpeg"]
    assert "--a-events-url" not in commands["BACKEND"]
    assert commands["FRONTEND"][-3:] == ["--port", "14174", "--strictPort"]
    assert commands["RELAY"][:4] == [
        "/usr/bin/node",
        "node_modules/wrangler/bin/wrangler.js",
        "dev",
        "--local",
    ]
    assert "--ip" not in commands["RELAY"]
    assert commands["RELAY"][-6:] == [
        "--port",
        "18787",
        "--var",
        "ALLOWED_ORIGINS:http://127.0.0.1:14174,http://localhost:14174",
        "--var",
        f"RUNTIME_INGEST_TOKEN:{config.runtime_ingest_token}",
    ]
    assert config.backend_http_url == "http://127.0.0.1:18770"
    assert config.acceptance_url == "http://127.0.0.1:14174/"
    assert config.viewer_url == "http://127.0.0.1:14174/viewer.html"
    assert config.relay_http_url == "http://127.0.0.1:18787"
    assert config.mimo_env_path == tmp_path / ".env"


def test_wildcard_bind_uses_explicit_public_host_for_phone_urls(tmp_path: Path) -> None:
    config = LocalDemoConfig(
        root=tmp_path,
        host="0.0.0.0",
        public_host="192.168.1.42",
    )

    assert config.probe_host == "127.0.0.1"
    assert config.acceptance_url == "http://192.168.1.42:4174/"
    assert config.backend_http_url == "http://192.168.1.42:8770"
    assert "http://192.168.1.42:4174" in config.allowed_origins
    relay_command = build_child_commands(config)["RELAY"]
    ip_index = relay_command.index("--ip")
    assert relay_command[ip_index : ip_index + 2] == ["--ip", "0.0.0.0"]


def test_public_host_requires_wildcard_bind(tmp_path: Path) -> None:
    config = LocalDemoConfig(root=tmp_path, public_host="192.168.1.42")

    with pytest.raises(LocalDemoError, match="requires --host 0.0.0.0"):
        validate_config(config)


@pytest.mark.parametrize("public_host", ["0.0.0.0", "demo host", "demo.local/path", "a,b"])
def test_public_host_must_be_a_browser_reachable_host(
    tmp_path: Path,
    public_host: str,
) -> None:
    with pytest.raises(LocalDemoError, match="public-host"):
        validate_config(
            LocalDemoConfig(root=tmp_path, host="0.0.0.0", public_host=public_host)
        )


@pytest.mark.parametrize(
    ("host", "public_host"),
    [("::", None), ("0.0.0.0", "fe80::1")],
)
def test_launcher_rejects_unsupported_ipv6_hosts(
    tmp_path: Path,
    host: str,
    public_host: str | None,
) -> None:
    with pytest.raises(LocalDemoError, match="IPv6"):
        validate_config(LocalDemoConfig(root=tmp_path, host=host, public_host=public_host))


def test_tls_uses_same_origin_runtime_and_relay_proxies(tmp_path: Path) -> None:
    cert = tmp_path / "demo-cert.pem"
    key = tmp_path / "demo-key.pem"
    cert.write_text("test certificate", encoding="utf-8")
    key.write_text("test key", encoding="utf-8")
    config = LocalDemoConfig(
        root=tmp_path,
        host="0.0.0.0",
        public_host="192.168.1.42",
        tls_cert=cert,
        tls_key=key,
    )

    validate_config(config)
    env = build_child_env(config, {})
    commands = build_child_commands(config)

    assert config.acceptance_url == "https://192.168.1.42:4174/"
    assert env["VITE_REME_PERCEPTION_HTTP_URL"] == (
        "https://192.168.1.42:4174/_reme/runtime"
    )
    assert env["VITE_REME_PERCEPTION_INPUT_WS_URL"] == (
        "wss://192.168.1.42:4174/_reme/runtime/ws/camera-input"
    )
    assert env["VITE_REME_DECISION_HTTP_URL"] == env["VITE_REME_PERCEPTION_HTTP_URL"]
    assert env["VITE_REME_RELAY_URL"] == "https://192.168.1.42:4174/_reme/relay/"
    assert env["REME_VITE_BACKEND_PROXY_TARGET"] == "http://127.0.0.1:8770"
    assert env["REME_VITE_RELAY_PROXY_TARGET"] == "http://127.0.0.1:8787"
    assert env["REME_VITE_TLS_CERT"] == str(cert)
    assert env["REME_VITE_TLS_KEY"] == str(key)
    assert env["REME_FAMILY_RELAY_ENDPOINT"] == "http://127.0.0.1:8787/api/runtime/event"
    assert env["REME_FAMILY_RELAY_TOKEN"] == config.runtime_ingest_token
    assert env["REME_HISTORY_RELAY_ENDPOINT"] == "http://127.0.0.1:8787"
    assert env["REME_HISTORY_RELAY_TOKEN"] == config.runtime_ingest_token
    assert any(item.startswith("ALLOWED_ORIGINS:https://") for item in commands["RELAY"])


def test_tls_certificate_and_key_are_required_as_a_pair(tmp_path: Path) -> None:
    cert = tmp_path / "demo-cert.pem"
    cert.write_text("test certificate", encoding="utf-8")

    with pytest.raises(LocalDemoError, match="provided together"):
        validate_config(LocalDemoConfig(root=tmp_path, tls_cert=cert))


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


def test_ensure_relay_dependencies_installs_pinned_worker_runtime(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    relay = tmp_path / "demo-relay"
    relay.mkdir()
    calls: list[list[str]] = []

    monkeypatch.setattr(local_demo_module.shutil, "which", lambda command: f"/bin/{command}")

    def fake_run(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
        calls.append(command)
        wrangler = relay / "node_modules" / ".bin" / "wrangler"
        wrangler.parent.mkdir(parents=True)
        wrangler.write_text("", encoding="utf-8")
        return subprocess.CompletedProcess(command, 0)

    monkeypatch.setattr(local_demo_module.subprocess, "run", fake_run)

    ensure_relay_dependencies(LocalDemoConfig(root=tmp_path), {})

    assert calls == [["npm", "ci"]]


def test_preload_demo_history_uses_backend_loader_without_mimo_summary(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config = LocalDemoConfig(root=tmp_path, relay_port=18787)
    calls: list[tuple[list[str], Path, dict[str, str]]] = []

    def fake_run(
        command: list[str], *, cwd: Path, env: dict[str, str], check: bool
    ) -> subprocess.CompletedProcess[str]:
        assert check is True
        calls.append((command, cwd, env))
        return subprocess.CompletedProcess(command, 0)

    monkeypatch.setattr(local_demo_module.subprocess, "run", fake_run)
    preload_demo_history(config, {"TEST": "1"})

    assert calls == [(
        [
            sys.executable,
            "-m",
            "reme.runtime.history.demo_loader",
            "--relay-url",
            "http://127.0.0.1:18787",
            "--token",
            config.runtime_ingest_token,
            "--skip-summaries",
        ],
        tmp_path,
        {"TEST": "1"},
    )]


def test_termination_signal_sets_shutdown_event_and_restores_handlers(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    installed: dict[signal.Signals, object] = {}
    calls: list[tuple[signal.Signals, object]] = []

    def fake_signal(signum: signal.Signals, handler: object) -> signal.Handlers:
        calls.append((signum, handler))
        installed[signum] = handler
        return signal.SIG_DFL

    monkeypatch.setattr(local_demo_module.signal, "signal", fake_signal)
    shutdown_event = threading.Event()

    previous = install_shutdown_signal_handlers(shutdown_event)
    handler = installed[signal.SIGTERM]
    assert callable(handler)
    handler(signal.SIGTERM, None)
    assert shutdown_event.is_set()

    restore_signal_handlers(previous)
    assert calls[-2:] == [
        (signal.SIGTERM, signal.SIG_DFL),
        (signal.SIGHUP, signal.SIG_DFL),
    ]


def test_shutdown_event_stops_all_started_services(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    (tmp_path / "frontend").mkdir()
    (tmp_path / "demo-relay").mkdir()
    shutdown_event = threading.Event()
    started: list[str] = []
    stopped: list[str] = []
    readiness_checks = 0

    monkeypatch.setattr(local_demo_module, "assert_port_available", lambda *_args: None)
    monkeypatch.setattr(local_demo_module, "ensure_frontend_dependencies", lambda *_args: None)
    monkeypatch.setattr(local_demo_module, "ensure_relay_dependencies", lambda *_args: None)
    monkeypatch.setattr(local_demo_module, "preload_demo_history", lambda *_args: None)
    monkeypatch.setattr(local_demo_module, "resolve_relay_node", lambda: "/usr/bin/node")

    def fake_start(label: str, *_args: object, **_kwargs: object) -> object:
        started.append(label)
        return SimpleNamespace(label=label)

    def fake_wait(*_args: object, **_kwargs: object) -> None:
        nonlocal readiness_checks
        readiness_checks += 1
        if readiness_checks == 3:
            shutdown_event.set()

    def fake_stop(processes: list[object]) -> None:
        stopped.extend(process.label for process in processes)

    monkeypatch.setattr(local_demo_module, "start_process", fake_start)
    monkeypatch.setattr(local_demo_module, "wait_for_http", fake_wait)
    monkeypatch.setattr(local_demo_module, "stop_processes", fake_stop)

    result = run_local_demo(
        LocalDemoConfig(root=tmp_path),
        shutdown_event=shutdown_event,
    )

    assert result == 0
    assert started == ["BACKEND", "RELAY", "FRONTEND"]
    assert stopped == started


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
