from __future__ import annotations

import threading
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from pathlib import Path

from reme.pose.review_server import build_review_handler


def test_review_server_supports_video_byte_ranges(tmp_path: Path) -> None:
    bundle = tmp_path / "bundle"
    (bundle / "media").mkdir(parents=True)
    (bundle / "media" / "source.mp4").write_bytes(b"0123456789abcdef")
    (bundle / "review.html").write_text("<html>review</html>", encoding="utf-8")

    handler = build_review_handler(
        bundle_dir=bundle,
        video_reference="media/source.mp4",
    )
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        connection = HTTPConnection("127.0.0.1", server.server_port, timeout=5)
        connection.request("GET", "/media/source.mp4", headers={"Range": "bytes=4-7"})
        response = connection.getresponse()

        assert response.status == 206
        assert response.getheader("Accept-Ranges") == "bytes"
        assert response.getheader("Content-Range") == "bytes 4-7/16"
        assert response.getheader("Content-Type") == "video/mp4"
        assert response.read() == b"4567"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def test_review_server_maps_root_to_review_page(tmp_path: Path) -> None:
    bundle = tmp_path / "bundle"
    (bundle / "media").mkdir(parents=True)
    (bundle / "media" / "source.mp4").write_bytes(b"video")
    (bundle / "review.html").write_text("<html>threejs-review</html>", encoding="utf-8")

    handler = build_review_handler(
        bundle_dir=bundle,
        video_reference="media/source.mp4",
    )
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        connection = HTTPConnection("127.0.0.1", server.server_port, timeout=5)
        connection.request("GET", "/")
        response = connection.getresponse()

        assert response.status == 200
        assert response.read() == b"<html>threejs-review</html>"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
