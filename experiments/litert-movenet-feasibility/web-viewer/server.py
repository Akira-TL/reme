#!/usr/bin/env python3
"""Serve the throwaway Reme pose-viewer prototype.

The server exposes only derived keypoint data. It never serves the raw source
video. Three.js assets are cached locally on first run so the browser does not
need a CDN connection during the demo.
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
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
    "OrbitControls.js": (
        f"https://cdn.jsdelivr.net/npm/three@{THREE_VERSION}/examples/jsm/controls/OrbitControls.js"
    ),
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Serve the Reme 3D pose-viewer prototype.")
    parser.add_argument(
        "--keypoints",
        type=Path,
        default=Path("/tmp/reme-litert-lightning-f16-tracking-full/keypoints.jsonl"),
        help="Derived pose JSONL file to visualize",
    )
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument(
        "--vendor-dir",
        type=Path,
        default=Path(tempfile.gettempdir()) / f"reme-pose-viewer-three-{THREE_VERSION}",
        help="Local cache for Three.js browser modules",
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
            with urllib.request.urlopen(url, timeout=30) as response:
                target.write_bytes(response.read())
        except (OSError, urllib.error.URLError) as exc:
            raise SystemExit(
                f"Could not download {filename}. Connect once to the internet and rerun: {exc}"
            ) from exc


def read_metadata(keypoints_path: Path) -> dict[str, object]:
    frame_count = 0
    first_timestamp: float | None = None
    last_timestamp: float | None = None
    schema: str | None = None
    coordinate_mode = "2d"

    with keypoints_path.open("r", encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            record = json.loads(line)
            frame_count += 1
            timestamp = float(record.get("timestamp_ms", 0.0))
            if first_timestamp is None:
                first_timestamp = timestamp
                schema = str(record.get("schema", "unknown"))
            last_timestamp = timestamp
            for keypoint in record.get("keypoints", []):
                if any(
                    key in keypoint
                    for key in ("z", "z_norm", "z_world", "world_z")
                ):
                    coordinate_mode = "3d"
                    break

    duration_ms = 0.0
    if first_timestamp is not None and last_timestamp is not None:
        duration_ms = max(0.0, last_timestamp - first_timestamp)

    return {
        "schema": schema,
        "frame_count": frame_count,
        "duration_ms": round(duration_ms, 3),
        "coordinate_mode": coordinate_mode,
        "source": keypoints_path.name,
        "three_version": THREE_VERSION,
    }


def build_handler(
    *,
    static_dir: Path,
    vendor_dir: Path,
    keypoints_path: Path,
    metadata: dict[str, object],
) -> type[SimpleHTTPRequestHandler]:
    class PoseViewerHandler(SimpleHTTPRequestHandler):
        def __init__(self, *args: object, **kwargs: object) -> None:
            super().__init__(*args, directory=str(static_dir), **kwargs)

        def do_GET(self) -> None:  # noqa: N802
            path = urlparse(self.path).path
            if path == "/api/keypoints":
                self._send_file(keypoints_path, "application/x-ndjson; charset=utf-8")
                return
            if path == "/api/meta":
                payload = json.dumps(metadata, ensure_ascii=False).encode("utf-8")
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(payload)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(payload)
                return
            if path == "/health":
                payload = b'{"status":"ok"}'
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                return
            if path.startswith("/vendor/"):
                filename = Path(path).name
                vendor_file = vendor_dir / filename
                if filename not in VENDOR_URLS or not vendor_file.is_file():
                    self.send_error(HTTPStatus.NOT_FOUND)
                    return
                self._send_file(vendor_file, "text/javascript; charset=utf-8")
                return
            if path in ("/", "/prototype/pose-viewer"):
                self.path = "/index.html"
            super().do_GET()

        def _send_file(self, path: Path, content_type: str | None = None) -> None:
            try:
                size = path.stat().st_size
                self.send_response(HTTPStatus.OK)
                self.send_header(
                    "Content-Type",
                    content_type
                    or mimetypes.guess_type(path.name)[0]
                    or "application/octet-stream",
                )
                self.send_header("Content-Length", str(size))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                with path.open("rb") as handle:
                    while chunk := handle.read(1024 * 256):
                        self.wfile.write(chunk)
            except BrokenPipeError:
                return

        def log_message(self, format_string: str, *args: object) -> None:
            if os.environ.get("REME_VIEWER_QUIET") == "1":
                return
            super().log_message(format_string, *args)

    return PoseViewerHandler


def main() -> int:
    args = parse_args()
    keypoints_path = args.keypoints.expanduser().resolve()
    if not keypoints_path.is_file():
        raise SystemExit(f"Keypoint JSONL not found: {keypoints_path}")

    static_dir = Path(__file__).resolve().parent
    vendor_dir = args.vendor_dir.expanduser().resolve()
    ensure_vendor(vendor_dir)
    metadata = read_metadata(keypoints_path)

    handler = build_handler(
        static_dir=static_dir,
        vendor_dir=vendor_dir,
        keypoints_path=keypoints_path,
        metadata=metadata,
    )
    server = ThreadingHTTPServer((args.host, args.port), handler)
    url = f"http://{args.host}:{args.port}/prototype/pose-viewer?variant=A"
    print(f"Reme pose viewer: {url}")
    print(f"Keypoints: {keypoints_path}")
    print("Raw video is not exposed by this server.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
