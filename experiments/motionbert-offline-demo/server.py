#!/usr/bin/env python3
"""Serve the local Reme split-screen MotionBERT demo.

The source video and derived 3D JSON are served only from the local machine.
MP4 byte ranges are supported so seeking works reliably in Chromium browsers.
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import re
import tempfile
import urllib.error
import urllib.request
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

THREE_VERSION = "0.184.0"
VENDOR_URLS = {
    "three.module.js": (
        f"https://cdn.jsdelivr.net/npm/three@{THREE_VERSION}/build/three.module.js"
    ),
    "three.core.js": (
        f"https://cdn.jsdelivr.net/npm/three@{THREE_VERSION}/build/three.core.js"
    ),
    "OrbitControls.js": (
        f"https://cdn.jsdelivr.net/npm/three@{THREE_VERSION}/examples/jsm/controls/OrbitControls.js"
    ),
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Serve the MotionBERT offline Web demo.")
    parser.add_argument("--video", type=Path, required=True)
    parser.add_argument("--poses", type=Path, required=True)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument(
        "--vendor-dir",
        type=Path,
        default=Path(tempfile.gettempdir()) / f"reme-motionbert-three-{THREE_VERSION}",
    )
    return parser.parse_args()


def ensure_vendor(vendor_dir: Path) -> None:
    vendor_dir.mkdir(parents=True, exist_ok=True)
    for filename, url in VENDOR_URLS.items():
        target = vendor_dir / filename
        if target.is_file() and target.stat().st_size > 10_000:
            continue
        try:
            print(f"Downloading {filename} ({THREE_VERSION}) ...")
            with urllib.request.urlopen(url, timeout=60) as response:
                target.write_bytes(response.read())
        except (OSError, urllib.error.URLError) as exc:
            raise SystemExit(
                f"Could not cache {filename}. Connect once and rerun: {exc}"
            ) from exc


def read_pose_meta(poses_path: Path) -> dict[str, object]:
    with poses_path.open("r", encoding="utf-8") as handle:
        payload = json.load(handle)
    video_meta = dict(payload.get("video") or {})
    video_meta.pop("source_frame_indices", None)
    return {
        "schema": payload.get("schema"),
        "model": payload.get("model"),
        "video": video_meta,
        "coordinate_system": payload.get("coordinate_system"),
        "runtime": payload.get("runtime"),
        "warning": payload.get("warning"),
        "three_version": THREE_VERSION,
    }


def build_handler(
    *,
    static_dir: Path,
    vendor_dir: Path,
    video_path: Path,
    poses_path: Path,
    metadata: dict[str, object],
) -> type[SimpleHTTPRequestHandler]:
    class DemoHandler(SimpleHTTPRequestHandler):
        def __init__(self, *args: object, **kwargs: object) -> None:
            super().__init__(*args, directory=str(static_dir), **kwargs)

        def do_HEAD(self) -> None:  # noqa: N802
            path = urlparse(self.path).path
            if path == "/favicon.ico":
                self.send_response(HTTPStatus.NO_CONTENT)
                self.end_headers()
                return
            if path == "/media/source.mp4":
                self._send_file(video_path, allow_range=True, send_body=False)
                return
            if path == "/api/poses":
                self._send_file(poses_path, allow_range=False, send_body=False)
                return
            if path.startswith("/vendor/"):
                filename = Path(path).name
                target = vendor_dir / filename
                if filename not in VENDOR_URLS or not target.is_file():
                    self.send_error(HTTPStatus.NOT_FOUND)
                    return
                self._send_file(target, allow_range=False, send_body=False)
                return
            super().do_HEAD()

        def do_GET(self) -> None:  # noqa: N802
            path = urlparse(self.path).path
            if path == "/favicon.ico":
                self.send_response(HTTPStatus.NO_CONTENT)
                self.end_headers()
                return
            if path == "/api/meta":
                body = json.dumps(metadata, ensure_ascii=False).encode("utf-8")
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(body)
                return
            if path == "/api/poses":
                self._send_file(poses_path, allow_range=False)
                return
            if path == "/media/source.mp4":
                self._send_file(video_path, allow_range=True)
                return
            if path == "/health":
                body = b'{"status":"ok"}'
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            if path.startswith("/vendor/"):
                filename = Path(path).name
                target = vendor_dir / filename
                if filename not in VENDOR_URLS or not target.is_file():
                    self.send_error(HTTPStatus.NOT_FOUND)
                    return
                self._send_file(target, allow_range=False)
                return
            if path in ("/", "/demo", "/prototype/motionbert"):
                self.path = "/index.html"
            super().do_GET()

        def _send_file(
            self,
            path: Path,
            *,
            allow_range: bool,
            send_body: bool = True,
        ) -> None:
            if not path.is_file():
                self.send_error(HTTPStatus.NOT_FOUND)
                return

            size = path.stat().st_size
            start = 0
            end = size - 1
            status = HTTPStatus.OK
            range_header = self.headers.get("Range") if allow_range else None
            if range_header:
                match = re.fullmatch(r"bytes=(\d*)-(\d*)", range_header.strip())
                if match is None:
                    self.send_error(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                    return
                first, last = match.groups()
                if first:
                    start = int(first)
                    end = int(last) if last else size - 1
                elif last:
                    count = int(last)
                    start = max(0, size - count)
                if start >= size or start > end:
                    self.send_error(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                    return
                end = min(end, size - 1)
                status = HTTPStatus.PARTIAL_CONTENT

            length = end - start + 1
            content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(length))
            self.send_header("Cache-Control", "no-store")
            if allow_range:
                self.send_header("Accept-Ranges", "bytes")
            if status == HTTPStatus.PARTIAL_CONTENT:
                self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            self.end_headers()
            if not send_body:
                return

            try:
                with path.open("rb") as handle:
                    handle.seek(start)
                    remaining = length
                    while remaining > 0:
                        chunk = handle.read(min(1024 * 1024, remaining))
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                        remaining -= len(chunk)
            except (BrokenPipeError, ConnectionResetError):
                return

        def log_message(self, format_string: str, *args: object) -> None:
            if os.environ.get("REME_DEMO_QUIET") == "1":
                return
            super().log_message(format_string, *args)

    return DemoHandler


def main() -> int:
    args = parse_args()
    video_path = args.video.expanduser().resolve()
    poses_path = args.poses.expanduser().resolve()
    if not video_path.is_file():
        raise SystemExit(f"video not found: {video_path}")
    if not poses_path.is_file():
        raise SystemExit(f"pose JSON not found: {poses_path}")

    static_dir = Path(__file__).resolve().parent
    vendor_dir = args.vendor_dir.expanduser().resolve()
    ensure_vendor(vendor_dir)
    metadata = read_pose_meta(poses_path)
    handler = build_handler(
        static_dir=static_dir,
        vendor_dir=vendor_dir,
        video_path=video_path,
        poses_path=poses_path,
        metadata=metadata,
    )
    server = ThreadingHTTPServer((args.host, args.port), handler)
    url = f"http://{args.host}:{args.port}/prototype/motionbert"
    print(f"Reme MotionBERT demo: {url}")
    print(f"Video: {video_path}")
    print(f"3D poses: {poses_path}")
    print("Both files are served locally; no cloud upload is used.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
