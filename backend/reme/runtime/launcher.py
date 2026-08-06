"""Run the unified Reme backend and frontend from one foreground command."""

from __future__ import annotations

import argparse
import os
import re
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import TextIO
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

DEFAULT_HOST = "127.0.0.1"
DEFAULT_BACKEND_PORT = 8770
DEFAULT_FRONTEND_PORT = 4174
DEFAULT_STARTUP_TIMEOUT_SECONDS = 30.0
DEFAULT_MIMO_ENV = Path(".env")
FRONTEND_NATIVE_CHECK = Path("scripts/check-native-deps.mjs")
_ENV_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


class LocalDemoError(RuntimeError):
    """Raised when the local acceptance stack cannot be started safely."""


@dataclass(frozen=True, slots=True)
class LocalDemoConfig:
    """Paths, ports, and input mode for the local application."""

    root: Path
    host: str = DEFAULT_HOST
    backend_port: int = DEFAULT_BACKEND_PORT
    frontend_port: int = DEFAULT_FRONTEND_PORT
    browser_input_mode: str = "landmarks"
    startup_timeout_seconds: float = DEFAULT_STARTUP_TIMEOUT_SECONDS
    mimo_env: Path = DEFAULT_MIMO_ENV

    @property
    def frontend_dir(self) -> Path:
        return self.root / "frontend"

    @property
    def mimo_env_path(self) -> Path:
        if self.mimo_env.is_absolute():
            return self.mimo_env
        return self.root / self.mimo_env

    @property
    def backend_http_url(self) -> str:
        return f"http://{self.host}:{self.backend_port}"

    @property
    def backend_ws_url(self) -> str:
        return f"ws://{self.host}:{self.backend_port}"

    @property
    def acceptance_url(self) -> str:
        return f"http://{self.host}:{self.frontend_port}/"


@dataclass(slots=True)
class ManagedProcess:
    """One child process plus the thread forwarding its output."""

    label: str
    process: subprocess.Popen[str]
    output_thread: threading.Thread


def load_env_file(path: Path) -> dict[str, str]:
    """Read the simple ``KEY=value`` form written by setup-mimo-env.sh."""

    if not path.is_file():
        return {}
    loaded: dict[str, str] = {}
    for line_number, raw_line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        if "=" not in line:
            raise LocalDemoError(f"{path}:{line_number}: expected KEY=value")
        name, raw_value = line.split("=", 1)
        name = name.strip()
        if _ENV_NAME.fullmatch(name) is None:
            raise LocalDemoError(f"{path}:{line_number}: invalid environment variable name")
        if not raw_value.strip():
            value = ""
        else:
            try:
                parts = shlex.split(raw_value, comments=True, posix=True)
            except ValueError as exc:
                raise LocalDemoError(f"{path}:{line_number}: invalid shell quoting") from exc
            if len(parts) != 1:
                raise LocalDemoError(f"{path}:{line_number}: value must be one shell word")
            value = parts[0]
        loaded[name] = value
    return loaded


def assert_port_available(host: str, port: int) -> None:
    """Fail only when a listener is actually accepting connections on the port."""

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.settimeout(0.25)
        if probe.connect_ex((host, port)) == 0:
            raise LocalDemoError(f"{host}:{port} is already in use")


def build_child_commands(config: LocalDemoConfig) -> dict[str, list[str]]:
    """Return the unified backend and frontend commands."""

    return {
        "BACKEND": [
            sys.executable,
            "-m",
            "reme.runtime.server",
            "--host",
            config.host,
            "--port",
            str(config.backend_port),
            "--input-adapter",
            "c_ws_server",
            "--browser-input-mode",
            config.browser_input_mode,
        ],
        "FRONTEND": [
            "npm",
            "run",
            "dev",
            "--",
            "--host",
            config.host,
            "--port",
            str(config.frontend_port),
            "--strictPort",
        ],
    }


def _forward_output(label: str, stream: TextIO) -> None:
    for line in stream:
        print(f"[{label}] {line}", end="", flush=True)


def start_process(
    label: str,
    command: Sequence[str],
    *,
    cwd: Path,
    env: dict[str, str],
) -> ManagedProcess:
    """Spawn one child and prefix every output line with its component name."""

    process = subprocess.Popen(  # noqa: S603 - commands are fixed argument vectors
        list(command),
        cwd=cwd,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        start_new_session=True,
    )
    stream = process.stdout
    if stream is None:
        process.terminate()
        raise LocalDemoError(f"{label} output pipe was not created")
    thread = threading.Thread(
        target=_forward_output,
        args=(label, stream),
        name=f"reme-launcher-{label.lower()}-output",
        daemon=True,
    )
    thread.start()
    return ManagedProcess(label=label, process=process, output_thread=thread)


def wait_for_http(
    component: ManagedProcess,
    url: str,
    *,
    timeout_seconds: float,
) -> None:
    """Wait until one child answers HTTP, failing early if the child exits."""

    deadline = time.monotonic() + timeout_seconds
    request = Request(url, headers={"User-Agent": "reme-launcher/0.2"})
    last_error: BaseException | None = None
    while time.monotonic() < deadline:
        return_code = component.process.poll()
        if return_code is not None:
            raise LocalDemoError(f"{component.label} exited during startup (code {return_code})")
        try:
            with urlopen(request, timeout=0.8) as response:  # noqa: S310 - loopback URL only
                if 200 <= response.status < 400:
                    return
        except (HTTPError, URLError, TimeoutError, OSError) as exc:
            last_error = exc
        time.sleep(0.15)
    detail = "" if last_error is None else f": {last_error}"
    raise LocalDemoError(f"{component.label} did not become ready at {url}{detail}")


def _signal_process_group(managed: ManagedProcess, sig: signal.Signals) -> bool:
    try:
        os.killpg(managed.process.pid, sig)
    except ProcessLookupError:
        return False
    return True


def _process_group_alive(managed: ManagedProcess) -> bool:
    try:
        os.killpg(managed.process.pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return managed.process.poll() is None
    return True


def stop_processes(processes: Sequence[ManagedProcess]) -> None:
    """Stop every managed process group and report its final state."""

    for managed in reversed(processes):
        if _signal_process_group(managed, signal.SIGTERM):
            print(f"[{managed.label}] stopping process group", flush=True)

    deadline = time.monotonic() + 5.0
    while time.monotonic() < deadline:
        for managed in processes:
            managed.process.poll()
        if not any(_process_group_alive(managed) for managed in processes):
            break
        time.sleep(0.05)

    for managed in reversed(processes):
        if _process_group_alive(managed):
            print(f"[{managed.label}] did not stop in time; sending SIGKILL", flush=True)
            _signal_process_group(managed, signal.SIGKILL)

    for managed in reversed(processes):
        if managed.process.poll() is None:
            try:
                managed.process.wait(timeout=2.0)
            except subprocess.TimeoutExpired:
                managed.process.kill()
                managed.process.wait(timeout=2.0)
        managed.output_thread.join(timeout=1.0)
        print(f"[{managed.label}] stopped", flush=True)


def frontend_dependencies_ready(config: LocalDemoConfig, env: dict[str, str]) -> bool:
    """Return whether copied frontend dependencies match the current platform."""

    vite = config.frontend_dir / "node_modules" / ".bin" / "vite"
    checker = config.frontend_dir / FRONTEND_NATIVE_CHECK
    if not vite.is_file() or not checker.is_file():
        return False
    probe = subprocess.run(  # noqa: S603 - fixed local compatibility probe
        ["node", str(FRONTEND_NATIVE_CHECK)],
        cwd=config.frontend_dir,
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    return probe.returncode == 0


def ensure_frontend_dependencies(config: LocalDemoConfig, env: dict[str, str]) -> None:
    """Clean-install missing or cross-platform frontend dependencies."""

    if shutil.which("npm") is None:
        raise LocalDemoError("npm is not available on PATH")
    if shutil.which("node") is None:
        raise LocalDemoError("node is not available on PATH")
    if frontend_dependencies_ready(config, env):
        return
    print("[FRONTEND] dependencies missing or incompatible; running npm ci", flush=True)
    try:
        subprocess.run(  # noqa: S603 - fixed npm command
            ["npm", "ci"],
            cwd=config.frontend_dir,
            env=env,
            check=True,
        )
    except subprocess.CalledProcessError as exc:
        raise LocalDemoError("npm ci failed") from exc
    if not frontend_dependencies_ready(config, env):
        raise LocalDemoError("frontend native dependencies are incompatible after npm ci")


def run_local_demo(config: LocalDemoConfig) -> int:
    """Start backend and frontend, then supervise them until exit."""

    if not config.frontend_dir.is_dir():
        raise LocalDemoError(f"frontend directory not found: {config.frontend_dir}")
    for port in (config.backend_port, config.frontend_port):
        assert_port_available(config.host, port)

    env = os.environ.copy()
    for name, value in load_env_file(config.mimo_env_path).items():
        env.setdefault(name, value)
    env["PYTHONUNBUFFERED"] = "1"
    env["VITE_REME_PERCEPTION_HTTP_URL"] = config.backend_http_url
    env["VITE_REME_PERCEPTION_INPUT_WS_URL"] = (
        f"{config.backend_ws_url}/ws/camera-input"
    )
    env["VITE_REME_DECISION_HTTP_URL"] = config.backend_http_url
    env["VITE_REME_MIMO_MODEL"] = env.get("MIMO_MODEL", "mimo-v2.5")
    env["VITE_REME_MIMO_CONFIGURED"] = "true" if env.get("MIMO_API_KEY") else "false"

    ensure_frontend_dependencies(config, env)
    commands = build_child_commands(config)
    processes: list[ManagedProcess] = []
    try:
        backend = start_process("BACKEND", commands["BACKEND"], cwd=config.root, env=env)
        processes.append(backend)
        wait_for_http(
            backend,
            f"{config.backend_http_url}/api/health",
            timeout_seconds=config.startup_timeout_seconds,
        )

        frontend = start_process(
            "FRONTEND",
            commands["FRONTEND"],
            cwd=config.frontend_dir,
            env=env,
        )
        processes.append(frontend)
        wait_for_http(
            frontend,
            config.acceptance_url,
            timeout_seconds=config.startup_timeout_seconds,
        )

        print("\nReme 本地应用已就绪", flush=True)
        print(f"验收页面: {config.acceptance_url}", flush=True)
        print(f"统一后端: {config.backend_http_url}", flush=True)
        print("浏览器姿态推理: GPU delegate（关键点直传）", flush=True)
        print("内部感知 → 决策: 进程内通讯", flush=True)
        print("按 Ctrl+C 停止 BACKEND 与 FRONTEND。\n", flush=True)

        while True:
            for managed in processes:
                return_code = managed.process.poll()
                if return_code is not None:
                    raise LocalDemoError(
                        f"{managed.label} stopped unexpectedly (code {return_code})"
                    )
            time.sleep(0.25)
    except KeyboardInterrupt:
        print("\n正在停止 Reme 本地应用…", flush=True)
        return 0
    finally:
        stop_processes(processes)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument("--backend-port", type=int, default=DEFAULT_BACKEND_PORT)
    parser.add_argument("--frontend-port", type=int, default=DEFAULT_FRONTEND_PORT)
    parser.add_argument(
        "--browser-input-mode",
        choices=("auto", "jpeg", "landmarks"),
        default="landmarks",
    )
    parser.add_argument(
        "--startup-timeout",
        type=float,
        default=DEFAULT_STARTUP_TIMEOUT_SECONDS,
        help="seconds allowed for each local service to become ready",
    )
    parser.add_argument(
        "--mimo-env",
        type=Path,
        default=DEFAULT_MIMO_ENV,
        help="MiMo environment file; relative paths resolve from the repository root",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    root = Path(__file__).resolve().parents[3]
    config = LocalDemoConfig(
        root=root,
        host=args.host,
        backend_port=args.backend_port,
        frontend_port=args.frontend_port,
        browser_input_mode=args.browser_input_mode,
        startup_timeout_seconds=args.startup_timeout,
        mimo_env=args.mimo_env.expanduser(),
    )
    try:
        return run_local_demo(config)
    except LocalDemoError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
