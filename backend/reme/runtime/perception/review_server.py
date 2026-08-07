"""Serve the local Three.js pose review with browser-safe video range requests."""

from __future__ import annotations

import argparse
import mimetypes
import os
import re
from collections.abc import Sequence
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from socket import socket
from socketserver import BaseServer
from urllib.parse import urlparse

from reme.runtime.perception.scene_bundle import SceneBundleError, load_scene_manifest


class PoseReviewServerError(ValueError):
    """Raised when a pose review bundle cannot be served."""


def build_review_handler(
    *,
    bundle_dir: Path,
    video_reference: str,
) -> type[SimpleHTTPRequestHandler]:
    """Create a handler that serves static assets and byte-range video responses."""

    root = bundle_dir.resolve()
    video_path = (root / video_reference).resolve()
    try:
        video_path.relative_to(root)
    except ValueError as exc:
        raise PoseReviewServerError("video reference must remain inside the bundle") from exc

    class ReviewHandler(SimpleHTTPRequestHandler):
        def __init__(
            self,
            request: socket | tuple[bytes, socket],
            client_address: tuple[str, int],
            server: BaseServer,
        ) -> None:
            super().__init__(request, client_address, server, directory=str(root))

        def do_HEAD(self) -> None:  # noqa: N802
            request_path = urlparse(self.path).path
            if request_path == "/favicon.ico":
                self.send_response(HTTPStatus.NO_CONTENT)
                self.end_headers()
                return
            if request_path == f"/{video_reference}":
                self._send_file(video_path, allow_range=True, send_body=False)
                return
            if request_path in ("/", "/review"):
                self.path = "/review.html"
            super().do_HEAD()

        def do_GET(self) -> None:  # noqa: N802
            request_path = urlparse(self.path).path
            if request_path == "/favicon.ico":
                self.send_response(HTTPStatus.NO_CONTENT)
                self.end_headers()
                return
            if request_path == f"/{video_reference}":
                self._send_file(video_path, allow_range=True)
                return
            if request_path in ("/", "/review"):
                self.path = "/review.html"
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
                    if count <= 0:
                        self.send_error(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                        return
                    start = max(0, size - count)
                else:
                    self.send_error(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                    return
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

    return ReviewHandler


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """Serve one generated pose review page."""

    args = _build_parser().parse_args(argv)
    try:
        manifest = load_scene_manifest(args.manifest)
    except SceneBundleError as exc:
        print(f"error: {exc}")
        return 2

    review_page = manifest.path.parent / "review.html"
    if not review_page.is_file():
        print(f"error: review page does not exist: {review_page}")
        return 2

    video_reference = manifest.data["media"]["local_path"]
    if not isinstance(video_reference, str):
        print("error: manifest media.local_path must be a string")
        return 2

    try:
        handler = build_review_handler(
            bundle_dir=manifest.path.parent,
            video_reference=video_reference,
        )
    except PoseReviewServerError as exc:
        print(f"error: {exc}")
        return 2

    server = ThreadingHTTPServer((args.host, args.port), handler)
    url = f"http://{args.host}:{args.port}/review"
    print(f"Reme 3D pose review: {url}")
    print(f"Scene bundle: {manifest.path.parent}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
