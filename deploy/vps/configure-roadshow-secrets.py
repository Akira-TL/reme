#!/usr/bin/env python3
"""Create root-owned roadshow env files without printing secret values."""

from __future__ import annotations

import argparse
import ipaddress
import json
import os
import re
import secrets
import shlex
import tempfile
from pathlib import Path
from urllib.parse import urlsplit

ENV_NAME = re.compile(r"^[A-Z][A-Z0-9_]*$")
TOKEN_PATTERN = re.compile(r"^[A-Za-z0-9_-]{32,256}$")


def parse_assignment_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for line_number, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        if "=" in line:
            name, raw_value = line.split("=", 1)
        else:
            parts = line.split(None, 1)
            if len(parts) != 2:
                continue
            name, raw_value = parts
        name = name.strip()
        if ENV_NAME.fullmatch(name) is None:
            continue
        try:
            parsed = shlex.split(raw_value.strip(), comments=True, posix=True)
        except ValueError as exc:
            raise ValueError(f"{path}:{line_number}: invalid quoting") from exc
        if len(parsed) != 1:
            raise ValueError(f"{path}:{line_number}: expected one value")
        values[name] = parsed[0]
    return values


def read_coturn_secret(path: Path) -> str:
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("static-auth-secret="):
            return line.split("=", 1)[1].strip()
        if line.startswith("static-auth-secret "):
            return line.split(None, 1)[1].strip()
    raise ValueError(f"{path}: static-auth-secret is missing")


def require_secret(value: str, label: str) -> str:
    if not value or any(character in value for character in "\r\n\0"):
        raise ValueError(f"{label} is missing or invalid")
    return value


def require_https_origin(value: str) -> str:
    parsed = urlsplit(value)
    if parsed.scheme != "https" or not parsed.hostname or parsed.path not in {"", "/"}:
        raise ValueError("origin must be one HTTPS origin without a path")
    if parsed.query or parsed.fragment or parsed.username or parsed.password:
        raise ValueError("origin must not contain credentials, query, or fragment")
    return value.rstrip("/")


def dotenv(values: dict[str, str]) -> str:
    return "".join(f"{name}={json.dumps(value)}\n" for name, value in values.items())


def atomic_private_write(path: Path, content: str) -> None:
    path.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent, text=True)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        path.chmod(0o600)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def build_configs(
    *,
    mimo_env: Path,
    coturn_config: Path,
    existing_relay_env: Path,
    origin: str,
    public_ip: str,
) -> tuple[str, str]:
    mimo = parse_assignment_file(mimo_env)
    mimo_key = require_secret(mimo.get("MIMO_API_KEY", ""), "MIMO_API_KEY")
    turn_secret = require_secret(read_coturn_secret(coturn_config), "coturn REST secret")
    accepted_origin = require_https_origin(origin)
    internal_relay_origin = f"http://{urlsplit(accepted_origin).netloc}"
    accepted_ip = str(ipaddress.IPv4Address(public_ip))

    existing = parse_assignment_file(existing_relay_env) if existing_relay_env.is_file() else {}
    runtime_token = existing.get("RUNTIME_INGEST_TOKEN", "")
    if TOKEN_PATTERN.fullmatch(runtime_token) is None:
        runtime_token = secrets.token_urlsafe(48)

    backend = dotenv({
        "MIMO_API_KEY": mimo_key,
        "MIMO_BASE_URL": mimo.get("MIMO_BASE_URL", "https://api.xiaomimimo.com/v1"),
        "MIMO_MODEL": mimo.get("MIMO_MODEL", "mimo-v2.5"),
        "REME_FAMILY_RELAY_ENDPOINT": "http://reme-relay:8787/api/runtime/event",
        "REME_FAMILY_RELAY_TOKEN": runtime_token,
        "REME_HISTORY_RELAY_ENDPOINT": "http://reme-relay:8787",
        "REME_HISTORY_RELAY_TOKEN": runtime_token,
        "PYTHONUNBUFFERED": "1",
    })
    relay = dotenv({
        # Wrangler local workerd normalizes the browser Origin to the same host
        # on its plain-HTTP Docker listener after Caddy terminates TLS. Relay is
        # not published on the host, so allow only these two exact forms.
        "ALLOWED_ORIGINS": f"{accepted_origin},{internal_relay_origin}",
        "RUNTIME_INGEST_TOKEN": runtime_token,
        "REME_STUN_URLS": f"stun:{accepted_ip}:3478",
        "REME_TURN_URLS": (
            f"turn:{accepted_ip}:3478?transport=udp,"
            f"turn:{accepted_ip}:3478?transport=tcp"
        ),
        "REME_TURN_SHARED_SECRET": turn_secret,
        "REME_TURN_CREDENTIAL_TTL_SECONDS": "600",
    })
    return backend, relay


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser()
    value.add_argument("--mimo-env", type=Path, default=Path("/root/.config/reme/mimo.env"))
    value.add_argument("--coturn-config", type=Path, default=Path("/etc/turnserver.conf"))
    value.add_argument("--backend-env", type=Path, default=Path("/etc/reme/backend.env"))
    value.add_argument("--relay-env", type=Path, default=Path("/etc/reme/relay.dev.vars"))
    value.add_argument("--origin", default="https://reme.maniforld.com")
    value.add_argument("--public-ip", required=True)
    value.add_argument("--check", action="store_true")
    return value


def main() -> int:
    arguments = parser().parse_args()
    backend, relay = build_configs(
        mimo_env=arguments.mimo_env,
        coturn_config=arguments.coturn_config,
        existing_relay_env=arguments.relay_env,
        origin=arguments.origin,
        public_ip=arguments.public_ip,
    )
    if not arguments.check:
        atomic_private_write(arguments.backend_env, backend)
        atomic_private_write(arguments.relay_env, relay)
    action = "validated" if arguments.check else "written"
    print(
        f"roadshow secrets {action}: backend={arguments.backend_env} "
        f"relay={arguments.relay_env}; values not displayed"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
