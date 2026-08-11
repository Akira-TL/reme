#!/usr/bin/env python3
"""Idempotently append the isolated Reme roadshow Caddy site with a backup."""

from __future__ import annotations

import argparse
import os
import shutil
import tempfile
from datetime import datetime, timezone
from pathlib import Path

START = "# BEGIN REME ROADSHOW (managed by deploy/vps)"
END = "# END REME ROADSHOW"
HOST = "reme.maniforld.com"


def managed_block(site: str) -> str:
    return f"{START}\n{site.strip()}\n{END}\n"


def install(
    *,
    caddyfile: Path,
    site_file: Path,
    check: bool = False,
    update_managed: bool = False,
) -> Path | None:
    current = caddyfile.read_text(encoding="utf-8")
    site = site_file.read_text(encoding="utf-8")
    block = managed_block(site)
    has_start = START in current
    has_end = END in current
    if has_start != has_end or current.count(START) > 1 or current.count(END) > 1:
        raise ValueError("managed Reme block markers are incomplete or duplicated")
    if has_start:
        if block.strip() not in current:
            if not update_managed:
                raise ValueError("existing managed Reme block differs from the requested site")
        else:
            return None
    elif HOST in current:
        raise ValueError("an unmanaged reme.maniforld.com block already exists")
    if check:
        return None

    # Ubuntu 22.04 ships Python 3.10, where datetime.UTC is unavailable.
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")  # noqa: UP017
    backup = caddyfile.with_name(f"{caddyfile.name}.before-reme-roadshow-{timestamp}")
    shutil.copy2(caddyfile, backup)
    if has_start:
        start_index = current.index(START)
        marker_end = current.index(END, start_index) + len(END)
        line_end = current.find("\n", marker_end)
        end_index = len(current) if line_end == -1 else line_end + 1
        candidate = f"{current[:start_index]}{block}{current[end_index:]}"
    else:
        candidate = f"{current.rstrip()}\n\n{block}"
    descriptor, temporary = tempfile.mkstemp(prefix=f".{caddyfile.name}.", dir=caddyfile.parent)
    try:
        with open(descriptor, "w", encoding="utf-8", closefd=True) as stream:
            stream.write(candidate)
            stream.flush()
            os.fsync(stream.fileno())

        # Preserve the Caddyfile inode. Docker bind-mounts a single file by
        # inode, so atomically replacing the host path leaves an already
        # running Caddy container attached to the old file. Stage the complete
        # candidate first, then copy it into the existing inode in place.
        with Path(temporary).open("rb") as source, caddyfile.open("wb") as target:
            shutil.copyfileobj(source, target)
            target.flush()
            os.fsync(target.fileno())
    finally:
        Path(temporary).unlink(missing_ok=True)
    return backup


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser()
    value.add_argument("--caddyfile", type=Path, required=True)
    value.add_argument("--site-file", type=Path, required=True)
    value.add_argument("--check", action="store_true")
    value.add_argument(
        "--update-managed",
        action="store_true",
        help="replace a differing block only when it is enclosed by the managed markers",
    )
    return value


def main() -> int:
    arguments = parser().parse_args()
    backup = install(
        caddyfile=arguments.caddyfile,
        site_file=arguments.site_file,
        check=arguments.check,
        update_managed=arguments.update_managed,
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
