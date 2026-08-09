"""Run the unified Reme backend, Relay, and frontend from one foreground command."""

from __future__ import annotations

import argparse
import ipaddress
import os
import re
import secrets
import shlex
import shutil
import signal
import socket
import ssl
import subprocess
import sys
import threading
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from types import FrameType
from typing import Any, TextIO, cast
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

DEFAULT_HOST = "127.0.0.1"
DEFAULT_BACKEND_PORT = 8770
DEFAULT_FRONTEND_PORT = 4174
DEFAULT_RELAY_PORT = 8787
DEFAULT_STARTUP_TIMEOUT_SECONDS = 30.0
DEFAULT_MIMO_ENV = Path(".env")
FRONTEND_NATIVE_CHECK = Path("scripts/check-native-deps.mjs")
RUNTIME_PROXY_PATH = "/_reme/runtime"
RELAY_PROXY_PATH = "/_reme/relay"
_ENV_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_HOSTNAME = re.compile(
    r"^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*"
    r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$"
)
SignalHandler = signal.Handlers | Callable[[int, FrameType | None], Any]


class LocalDemoError(RuntimeError):
    """Raised when the local acceptance stack cannot be started safely."""


class LocalDemoShutdown(RuntimeError):
    """Raised internally when a process signal requests orderly shutdown."""


@dataclass(frozen=True, slots=True)
class LocalDemoConfig:
    """Paths, ports, and input mode for the local application."""

    root: Path
    host: str = DEFAULT_HOST
    backend_port: int = DEFAULT_BACKEND_PORT
    frontend_port: int = DEFAULT_FRONTEND_PORT
    relay_port: int = DEFAULT_RELAY_PORT
    public_host: str | None = None
    browser_input_mode: str = "jpeg"
    startup_timeout_seconds: float = DEFAULT_STARTUP_TIMEOUT_SECONDS
    mimo_env: Path = DEFAULT_MIMO_ENV
    tls_cert: Path | None = None
    tls_key: Path | None = None
    backend_publish_token: str = field(default_factory=lambda: secrets.token_hex(32))

    @property
    def frontend_dir(self) -> Path:
        return self.root / "frontend"

    @property
    def relay_dir(self) -> Path:
        return self.root / "demo-relay"

    @property
    def client_host(self) -> str:
        if self.public_host:
            return self.public_host
        if self.host in {"0.0.0.0", "::"}:
            return "127.0.0.1"
        return self.host

    @property
    def tls_enabled(self) -> bool:
        return self.tls_cert is not None and self.tls_key is not None

    @property
    def browser_scheme(self) -> str:
        return "https" if self.tls_enabled else "http"

    @property
    def browser_ws_scheme(self) -> str:
        return "wss" if self.tls_enabled else "ws"

    @property
    def probe_host(self) -> str:
        return "127.0.0.1" if self.host in {"0.0.0.0", "::"} else self.host

    @property
    def mimo_env_path(self) -> Path:
        if self.mimo_env.is_absolute():
            return self.mimo_env
        return self.root / self.mimo_env

    def resolve_from_root(self, path: Path | None) -> Path | None:
        if path is None or path.is_absolute():
            return path
        return self.root / path

    @property
    def tls_cert_path(self) -> Path | None:
        return self.resolve_from_root(self.tls_cert)

    @property
    def tls_key_path(self) -> Path | None:
        return self.resolve_from_root(self.tls_key)

    @property
    def backend_http_url(self) -> str:
        return f"http://{self.client_host}:{self.backend_port}"

    @property
    def backend_ws_url(self) -> str:
        return f"ws://{self.client_host}:{self.backend_port}"

    @property
    def backend_probe_url(self) -> str:
        return f"http://{self.probe_host}:{self.backend_port}"

    @property
    def relay_http_url(self) -> str:
        return f"http://{self.client_host}:{self.relay_port}"

    @property
    def relay_probe_url(self) -> str:
        return f"http://{self.probe_host}:{self.relay_port}"

    @property
    def acceptance_url(self) -> str:
        return f"{self.browser_scheme}://{self.client_host}:{self.frontend_port}/"

    @property
    def frontend_probe_url(self) -> str:
        return f"{self.browser_scheme}://{self.probe_host}:{self.frontend_port}/"

    @property
    def viewer_url(self) -> str:
        return f"{self.browser_scheme}://{self.client_host}:{self.frontend_port}/viewer.html"

    @property
    def browser_runtime_url(self) -> str:
        return f"{self.browser_scheme}://{self.client_host}:{self.frontend_port}{RUNTIME_PROXY_PATH}"

    @property
    def browser_runtime_input_ws_url(self) -> str:
        return (
            f"{self.browser_ws_scheme}://{self.client_host}:{self.frontend_port}"
            f"{RUNTIME_PROXY_PATH}/ws/camera-input"
        )

    @property
    def browser_relay_url(self) -> str:
        return (
            f"{self.browser_scheme}://{self.client_host}:{self.frontend_port}"
            f"{RELAY_PROXY_PATH}/"
        )

    @property
    def allowed_origins(self) -> str:
        origins = {
            f"{self.browser_scheme}://{self.client_host}:{self.frontend_port}",
            f"{self.browser_scheme}://127.0.0.1:{self.frontend_port}",
            f"{self.browser_scheme}://localhost:{self.frontend_port}",
        }
        return ",".join(sorted(origins))


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


def validate_config(config: LocalDemoConfig) -> None:
    """Reject ambiguous bind/public URL and incomplete TLS configurations."""

    for option, value in (("--host", config.host), ("--public-host", config.public_host)):
        if value is None:
            continue
        if ":" in value:
            raise LocalDemoError("IPv6 hosts are not supported by the local demo launcher")
        try:
            address = ipaddress.ip_address(value)
        except ValueError:
            if _HOSTNAME.fullmatch(value) is None:
                raise LocalDemoError(
                    f"{option} must be a hostname or IPv4 address without a port"
                ) from None
        else:
            if address.version != 4:
                raise LocalDemoError("IPv6 hosts are not supported by the local demo launcher")
            if option == "--public-host" and address.is_unspecified:
                raise LocalDemoError("--public-host must be a browser-reachable address")
    if config.public_host is not None and config.host != "0.0.0.0":
        raise LocalDemoError("--public-host requires --host 0.0.0.0")
    if (config.tls_cert is None) != (config.tls_key is None):
        raise LocalDemoError("--tls-cert and --tls-key must be provided together")
    for option, path in (
        ("--tls-cert", config.tls_cert_path),
        ("--tls-key", config.tls_key_path),
    ):
        if path is not None and not path.is_file():
            raise LocalDemoError(f"{option} file not found: {path}")


def build_child_env(
    config: LocalDemoConfig,
    inherited: dict[str, str] | None = None,
) -> dict[str, str]:
    """Build one environment; Vite only bundles the explicitly public VITE_* subset."""

    env = dict(os.environ if inherited is None else inherited)
    for name, value in load_env_file(config.mimo_env_path).items():
        env.setdefault(name, value)
    env["PYTHONUNBUFFERED"] = "1"

    # Browser traffic stays on the Vite origin. In TLS mode this prevents mixed
    # content while Vite proxies to the two loopback HTTP services.
    env["VITE_REME_PERCEPTION_HTTP_URL"] = config.browser_runtime_url
    env["VITE_REME_PERCEPTION_INPUT_WS_URL"] = config.browser_runtime_input_ws_url
    env["VITE_REME_DECISION_HTTP_URL"] = config.browser_runtime_url
    env["VITE_REME_RELAY_URL"] = config.browser_relay_url
    env["VITE_REME_MIMO_MODEL"] = env.get("MIMO_MODEL", "mimo-v2.5")
    env["VITE_REME_MIMO_CONFIGURED"] = "true" if env.get("MIMO_API_KEY") else "false"

    env["REME_VITE_BACKEND_PROXY_TARGET"] = config.backend_probe_url
    env["REME_VITE_RELAY_PROXY_TARGET"] = config.relay_probe_url
    env["REME_VITE_PUBLIC_HOST"] = config.client_host
    env["REME_FAMILY_RELAY_URL"] = config.relay_probe_url
    env["REME_FAMILY_RELAY_PUBLISH_TOKEN"] = config.backend_publish_token
    if config.tls_enabled:
        assert config.tls_cert_path is not None
        assert config.tls_key_path is not None
        env["REME_VITE_TLS_CERT"] = str(config.tls_cert_path)
        env["REME_VITE_TLS_KEY"] = str(config.tls_key_path)
    else:
        env.pop("REME_VITE_TLS_CERT", None)
        env.pop("REME_VITE_TLS_KEY", None)
    return env


def install_shutdown_signal_handlers(
    shutdown_event: threading.Event,
) -> dict[signal.Signals, SignalHandler]:
    """Turn supervisor termination signals into an orderly launcher shutdown."""

    previous: dict[signal.Signals, SignalHandler] = {}

    def request_shutdown(_signum: int, _frame: FrameType | None) -> None:
        shutdown_event.set()

    for signum in (signal.SIGTERM, signal.SIGHUP):
        previous[signum] = cast(SignalHandler, signal.signal(signum, request_shutdown))
    return previous


def restore_signal_handlers(previous: dict[signal.Signals, SignalHandler]) -> None:
    for signum, handler in previous.items():
        signal.signal(signum, handler)


def assert_port_available(host: str, port: int) -> None:
    """Fail only when a listener is actually accepting connections on the port."""

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.settimeout(0.25)
        if probe.connect_ex((host, port)) == 0:
            raise LocalDemoError(f"{host}:{port} is already in use")


def build_child_commands(config: LocalDemoConfig) -> dict[str, list[str]]:
    """Return the unified backend, public Relay, and frontend commands."""

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
        "RELAY": [
            "npm",
            "run",
            "dev",
            "--",
            "--ip",
            config.host,
            "--port",
            str(config.relay_port),
            "--var",
            f"ALLOWED_ORIGINS:{config.allowed_origins}",
            "--var",
            f"BACKEND_PUBLISH_TOKEN:{config.backend_publish_token}",
            "--var",
            "TURN_KEY_ID:local-disabled",
            "--var",
            "TURN_KEY_API_TOKEN:local-disabled",
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
    shutdown_event: threading.Event | None = None,
    tls_context: ssl.SSLContext | None = None,
) -> None:
    """Wait until one child answers HTTP, failing early if the child exits."""

    deadline = time.monotonic() + timeout_seconds
    request = Request(url, headers={"User-Agent": "reme-launcher/0.2"})
    last_error: BaseException | None = None
    while time.monotonic() < deadline:
        if shutdown_event is not None and shutdown_event.is_set():
            raise LocalDemoShutdown
        return_code = component.process.poll()
        if return_code is not None:
            raise LocalDemoError(f"{component.label} exited during startup (code {return_code})")
        try:
            with urlopen(  # noqa: S310 - launcher probes only its configured local service
                request,
                timeout=0.8,
                context=tls_context,
            ) as response:
                if 200 <= response.status < 400:
                    return
        except (HTTPError, URLError, TimeoutError, OSError) as exc:
            last_error = exc
        time.sleep(0.15)
    detail = "" if last_error is None else f": {last_error}"
    raise LocalDemoError(f"{component.label} did not become ready at {url}{detail}")


def loopback_tls_context() -> ssl.SSLContext:
    """Create an unverified context only for the launcher's loopback readiness probe."""

    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE
    return context


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


def relay_dependencies_ready(config: LocalDemoConfig) -> bool:
    """Return whether the local Worker runtime is installed."""

    return (config.relay_dir / "node_modules" / ".bin" / "wrangler").is_file()


def ensure_relay_dependencies(config: LocalDemoConfig, env: dict[str, str]) -> None:
    """Install the pinned local Relay dependencies when absent."""

    if shutil.which("npm") is None or shutil.which("node") is None:
        raise LocalDemoError("npm and node are required for the local Relay")
    if relay_dependencies_ready(config):
        return
    print("[RELAY] dependencies missing; running npm ci", flush=True)
    try:
        subprocess.run(  # noqa: S603 - fixed local package command
            ["npm", "ci"],
            cwd=config.relay_dir,
            env=env,
            check=True,
        )
    except subprocess.CalledProcessError as exc:
        raise LocalDemoError("Relay npm ci failed") from exc
    if not relay_dependencies_ready(config):
        raise LocalDemoError("Relay dependencies are unavailable after npm ci")


def run_local_demo(
    config: LocalDemoConfig,
    *,
    shutdown_event: threading.Event | None = None,
) -> int:
    """Start backend, Relay, and frontend, then supervise them until exit."""

    validate_config(config)
    if not config.frontend_dir.is_dir():
        raise LocalDemoError(f"frontend directory not found: {config.frontend_dir}")
    if not config.relay_dir.is_dir():
        raise LocalDemoError(f"Relay directory not found: {config.relay_dir}")
    for port in (config.backend_port, config.frontend_port, config.relay_port):
        assert_port_available(config.probe_host, port)

    stop_requested = shutdown_event or threading.Event()
    env = build_child_env(config)
    commands = build_child_commands(config)
    processes: list[ManagedProcess] = []
    try:
        ensure_frontend_dependencies(config, env)
        ensure_relay_dependencies(config, env)
        if stop_requested.is_set():
            raise LocalDemoShutdown

        backend = start_process("BACKEND", commands["BACKEND"], cwd=config.root, env=env)
        processes.append(backend)
        wait_for_http(
            backend,
            f"{config.backend_probe_url}/api/health",
            timeout_seconds=config.startup_timeout_seconds,
            shutdown_event=stop_requested,
        )

        relay = start_process("RELAY", commands["RELAY"], cwd=config.relay_dir, env=env)
        processes.append(relay)
        wait_for_http(
            relay,
            f"{config.relay_probe_url}/health",
            timeout_seconds=config.startup_timeout_seconds,
            shutdown_event=stop_requested,
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
            config.frontend_probe_url,
            timeout_seconds=config.startup_timeout_seconds,
            shutdown_event=stop_requested,
            tls_context=loopback_tls_context() if config.tls_enabled else None,
        )

        print("\nReme 固定公开双端演示已就绪", flush=True)
        print(f"Monitor: {config.acceptance_url}", flush=True)
        print(f"Viewer: {config.viewer_url}", flush=True)
        print(f"统一后端（浏览器同源代理）: {config.browser_runtime_url}", flush=True)
        print(f"本地 Relay（浏览器同源代理）: {config.browser_relay_url}", flush=True)
        print("姿态链路: 浏览器约 10 FPS JPEG → 本地后端 MoveNet", flush=True)
        print("内部感知 → 决策: 进程内通讯", flush=True)
        print("固定房间无身份认证，仅用于受控路演。", flush=True)
        if config.tls_enabled:
            print("手机媒体权限要求浏览器信任当前 HTTPS 证书。", flush=True)
        print("按 Ctrl+C 停止 BACKEND、RELAY 与 FRONTEND。\n", flush=True)

        while not stop_requested.wait(0.25):
            for managed in processes:
                return_code = managed.process.poll()
                if return_code is not None:
                    raise LocalDemoError(
                        f"{managed.label} stopped unexpectedly (code {return_code})"
                    )
        print("\n收到进程退出信号，正在停止 Reme 本地应用…", flush=True)
        return 0
    except (KeyboardInterrupt, LocalDemoShutdown):
        print("\n正在停止 Reme 本地应用…", flush=True)
        return 0
    finally:
        stop_processes(processes)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument("--backend-port", type=int, default=DEFAULT_BACKEND_PORT)
    parser.add_argument("--frontend-port", type=int, default=DEFAULT_FRONTEND_PORT)
    parser.add_argument("--relay-port", type=int, default=DEFAULT_RELAY_PORT)
    parser.add_argument(
        "--public-host",
        default=None,
        help="browser-visible hostname or IPv4 LAN address; requires --host 0.0.0.0",
    )
    parser.add_argument(
        "--tls-cert",
        type=Path,
        default=None,
        help="trusted PEM certificate for the Vite HTTPS endpoint",
    )
    parser.add_argument(
        "--tls-key",
        type=Path,
        default=None,
        help="PEM private key matching --tls-cert",
    )
    parser.add_argument(
        "--browser-input-mode",
        choices=("auto", "jpeg", "landmarks"),
        default="jpeg",
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
        relay_port=args.relay_port,
        public_host=args.public_host,
        browser_input_mode=args.browser_input_mode,
        startup_timeout_seconds=args.startup_timeout,
        mimo_env=args.mimo_env.expanduser(),
        tls_cert=args.tls_cert.expanduser() if args.tls_cert is not None else None,
        tls_key=args.tls_key.expanduser() if args.tls_key is not None else None,
    )
    shutdown_event = threading.Event()
    previous_handlers = install_shutdown_signal_handlers(shutdown_event)
    try:
        return run_local_demo(config, shutdown_event=shutdown_event)
    except LocalDemoError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    finally:
        restore_signal_handlers(previous_handlers)


if __name__ == "__main__":
    raise SystemExit(main())
