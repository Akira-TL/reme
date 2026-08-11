#!/usr/bin/env python3
"""Idempotently append the isolated Reme roadshow Caddy site with a backup."""

from __future__ import annotations

import argparse
import shutil
import tempfile
from datetime import datetime, timezone
from pathlib import Path

START = "# BEGIN REME ROADSHOW (managed by deploy/vps)"
END = "# END REME ROADSHOW"
HOST = "reme.maniforld.com"


def managed_block(site: str) -> str:
    return f"{START}\n{site.strip()}\n{END}\n"


def install(*, caddyfile: Path, site_file: Path, check: bool = False) -> Path | None:
    current = caddyfile.read_text(encoding="utf-8")
    site = site_file.read_text(encoding="utf-8")
    block = managed_block(site)
    if START in current or END in current:
        if block.strip() not in current:
            raise ValueError("existing managed Reme block differs from the requested site")
        return None
    if HOST in current:
        raise ValueError("an unmanaged reme.maniforld.com block already exists")
    if check:
        return None

    # Ubuntu 22.04 ships Python 3.10, where datetime.UTC is unavailable.
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")  # noqa: UP017
    backup = caddyfile.with_name(f"{caddyfile.name}.before-reme-roadshow-{timestamp}")
    shutil.copy2(caddyfile, backup)
    candidate = f"{current.rstrip()}\n\n{block}"
    descriptor, temporary = tempfile.mkstemp(prefix=f".{caddyfile.name}.", dir=caddyfile.parent)
    try:
        with open(descriptor, "w", encoding="utf-8", closefd=True) as stream:
            stream.write(candidate)
            stream.flush()
        Path(temporary).replace(caddyfile)
    finally:
        Path(temporary).unlink(missing_ok=True)
    return backup


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser()
    value.add_argument("--caddyfile", type=Path, required=True)
    value.add_argument("--site-file", type=Path, required=True)
    value.add_argument("--check", action="store_true")
    return value


def main() -> int:
    arguments = parser().parse_args()
    backup = install(
        caddyfile=arguments.caddyfile,
        site_file=arguments.site_file,
        check=arguments.check,
    )
    if arguments.check:
        print("Reme Caddy site can be installed; no file changed")
    elif backup is None:
        print("Reme Caddy site already matches; no file changed")
    else:
        print(f"Reme Caddy site installed; backup={backup}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
