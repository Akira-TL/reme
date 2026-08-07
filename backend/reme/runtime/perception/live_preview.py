# ruff: noqa: E501
"""Run a local camera, Three.js skeleton, and posture-classification preview."""

from __future__ import annotations

import argparse
import json
import mimetypes
import threading
import time
from collections.abc import Sequence
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from reme.runtime.perception.camera import (
    CameraConfig,
    LiveMoveNetStream,
    OpenCVCameraSource,
)
from reme.runtime.perception.movenet import MoveNetEstimator
from reme.runtime.perception.posture import StaticPostureModel
from reme.runtime.perception.posture_runtime import (
    PostureRuntimeConfig,
    RealtimePostureTracker,
)
from reme.runtime.perception.review import THREE_VENDOR_FILES
from reme.runtime.perception.runtime import RuntimeEvent

DEFAULT_MOVENET_MODEL = Path(
    "models/runtime/movenet/movenet_lightning_f16_v4.tflite"
)
DEFAULT_POSTURE_MODEL = Path(
    "models/trained/posture/posture-sweep-20260801/seed-42-lr-0.04/model.json"
)
DEFAULT_VENDOR_DIR = Path("data/reference/pose/video_148703662/vendor")


class LivePreviewError(RuntimeError):
    """Raised when the local preview cannot start or serve data."""


class PreviewCameraSource(OpenCVCameraSource):
    """OpenCV source that exposes the most recently captured in-memory frame."""

    def __init__(self, config: CameraConfig) -> None:
        super().__init__(config)
        self.latest_frame: object | None = None

    def read(self) -> object:
        frame = super().read()
        self.latest_frame = frame
        return frame

    def close(self) -> None:
        self.latest_frame = None
        super().close()


class PreviewState:
    """Thread-safe latest-frame state shared by the worker and HTTP clients."""

    def __init__(self, *, session_id: str, scene_id: str) -> None:
        self.session_id = session_id
        self.scene_id = scene_id
        self.started_at = time.time()
        self._condition = threading.Condition()
        self._frame_version = 0
        self._jpeg: bytes | None = None
        self._frame_event: RuntimeEvent | None = None
        self._posture_event: RuntimeEvent | None = None
        self._error: str | None = None
        self._stopped = False

    def publish(
        self,
        *,
        jpeg: bytes,
        frame_event: RuntimeEvent,
        posture_event: RuntimeEvent | None,
    ) -> None:
        with self._condition:
            self._jpeg = jpeg
            self._frame_event = frame_event
            if posture_event is not None:
                self._posture_event = posture_event
            self._frame_version += 1
            self._condition.notify_all()

    def fail(self, message: str) -> None:
        with self._condition:
            self._error = message
            self._condition.notify_all()

    def stop(self) -> None:
        with self._condition:
            self._stopped = True
            self._condition.notify_all()

    def wait_for_frame(
        self, previous_version: int, *, timeout: float = 2.0
    ) -> tuple[int, bytes | None, bool]:
        with self._condition:
            self._condition.wait_for(
                lambda: self._frame_version > previous_version or self._stopped,
                timeout=timeout,
            )
            return self._frame_version, self._jpeg, self._stopped

    def snapshot(self) -> dict[str, object]:
        with self._condition:
            frame_payload = (
                dict(self._frame_event.payload) if self._frame_event is not None else None
            )
            posture_payload = (
                dict(self._posture_event.payload)
                if self._posture_event is not None
                else None
            )
            return {
                "schema_version": "reme-live-preview/v0-experiment",
                "session_id": self.session_id,
                "scene_id": self.scene_id,
                "started_at_unix": self.started_at,
                "frame_version": self._frame_version,
                "frame": frame_payload,
                "posture": posture_payload,
                "error": self._error,
                "stopped": self._stopped,
            }


class LivePreviewWorker:
    """Capture one camera and publish synchronized frame/posture state."""

    def __init__(
        self,
        *,
        state: PreviewState,
        stop_event: threading.Event,
        camera_config: CameraConfig,
        movenet_model: Path,
        posture_model: Path,
        posture_hz: float,
        score_threshold: float,
        jpeg_quality: int,
    ) -> None:
        if not 40 <= jpeg_quality <= 95:
            raise LivePreviewError("jpeg_quality must be between 40 and 95")
        self.state = state
        self.stop_event = stop_event
        self.camera_config = camera_config
        self.movenet_model = movenet_model
        self.posture_model = posture_model
        self.posture_hz = posture_hz
        self.score_threshold = score_threshold
        self.jpeg_quality = jpeg_quality
        self.thread = threading.Thread(
            target=self._run,
            name="reme-live-preview",
            daemon=True,
        )

    def start(self) -> None:
        self.thread.start()

    def join(self, timeout: float = 4.0) -> None:
        self.thread.join(timeout=timeout)

    def _run(self) -> None:
        try:
            import cv2

            cv2_module: Any = cv2
            source = PreviewCameraSource(self.camera_config)
            estimator = MoveNetEstimator(
                self.movenet_model,
                score_threshold=self.score_threshold,
                num_threads=4,
                warmup_runs=3,
            )
            model = StaticPostureModel.load(self.posture_model)
            tracker = RealtimePostureTracker(
                session_id=self.state.session_id,
                predictor=model,
                config=PostureRuntimeConfig(
                    output_hz=self.posture_hz,
                    score_threshold=self.score_threshold,
                ),
            )
            stream = LiveMoveNetStream(
                session_id=self.state.session_id,
                scene_id=self.state.scene_id,
                frame_source=source,
                estimator=estimator,
                is_session_active=lambda _session_id: not self.stop_event.is_set(),
            )
            for frame_event in stream.iter_events():
                frame = source.latest_frame
                if frame is None:
                    continue
                ok, encoded = cv2_module.imencode(
                    ".jpg",
                    frame,
                    [cv2_module.IMWRITE_JPEG_QUALITY, self.jpeg_quality],
                )
                if not ok:
                    raise LivePreviewError("OpenCV could not encode the camera frame")
                posture_event = tracker.process_frame_event(frame_event)
                self.state.publish(
                    jpeg=bytes(encoded),
                    frame_event=frame_event,
                    posture_event=posture_event,
                )
        except Exception as exc:  # pragma: no cover - hardware adapter boundary
            self.state.fail(f"{type(exc).__name__}: {exc}")
        finally:
            self.state.stop()


class PreviewHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def build_preview_handler(
    *,
    state: PreviewState,
    stop_event: threading.Event,
    vendor_dir: Path,
) -> type[BaseHTTPRequestHandler]:
    """Create the local-only HTTP handler for one preview session."""

    resolved_vendor = vendor_dir.expanduser().resolve()
    missing = [
        filename
        for filename in THREE_VENDOR_FILES
        if not (resolved_vendor / filename).is_file()
    ]
    if missing:
        raise LivePreviewError(
            f"Three.js vendor files missing from {resolved_vendor}: {', '.join(missing)}"
        )
    page = _render_live_page().encode("utf-8")

    class PreviewHandler(BaseHTTPRequestHandler):
        server_version = "RemeLivePreview/0"

        def do_GET(self) -> None:  # noqa: N802
            request_path = urlparse(self.path).path
            if request_path in ("/", "/live"):
                self._send_bytes(page, "text/html; charset=utf-8")
                return
            if request_path == "/api/state":
                payload = json.dumps(
                    state.snapshot(), ensure_ascii=False, separators=(",", ":")
                ).encode("utf-8")
                self._send_bytes(payload, "application/json; charset=utf-8")
                return
            if request_path == "/api/health":
                snapshot = state.snapshot()
                status = HTTPStatus.OK if snapshot["error"] is None else HTTPStatus.SERVICE_UNAVAILABLE
                payload = json.dumps(
                    {
                        "ok": snapshot["error"] is None,
                        "error": snapshot["error"],
                        "frame_version": snapshot["frame_version"],
                    },
                    ensure_ascii=False,
                ).encode("utf-8")
                self._send_bytes(payload, "application/json; charset=utf-8", status=status)
                return
            if request_path == "/stream.mjpg":
                self._stream_mjpeg()
                return
            if request_path.startswith("/vendor/"):
                self._send_vendor(request_path.removeprefix("/vendor/"))
                return
            if request_path == "/favicon.ico":
                self.send_response(HTTPStatus.NO_CONTENT)
                self.end_headers()
                return
            self.send_error(HTTPStatus.NOT_FOUND)

        def _send_bytes(
            self,
            data: bytes,
            content_type: str,
            *,
            status: HTTPStatus = HTTPStatus.OK,
        ) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            try:
                self.wfile.write(data)
            except (BrokenPipeError, ConnectionResetError):
                return

        def _send_vendor(self, filename: str) -> None:
            if filename not in THREE_VENDOR_FILES:
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            path = resolved_vendor / filename
            data = path.read_bytes()
            content_type = mimetypes.guess_type(filename)[0] or "text/javascript"
            self._send_bytes(data, content_type)

        def _stream_mjpeg(self) -> None:
            boundary = b"reme-frame"
            self.send_response(HTTPStatus.OK)
            self.send_header(
                "Content-Type",
                "multipart/x-mixed-replace; boundary=reme-frame",
            )
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
            self.send_header("Pragma", "no-cache")
            self.end_headers()
            version = -1
            try:
                while not stop_event.is_set():
                    version, jpeg, stopped = state.wait_for_frame(version)
                    if jpeg is None:
                        if stopped:
                            return
                        continue
                    self.wfile.write(b"--" + boundary + b"\r\n")
                    self.wfile.write(b"Content-Type: image/jpeg\r\n")
                    self.wfile.write(
                        f"Content-Length: {len(jpeg)}\r\n\r\n".encode("ascii")
                    )
                    self.wfile.write(jpeg)
                    self.wfile.write(b"\r\n")
                    self.wfile.flush()
                    if stopped:
                        return
            except (BrokenPipeError, ConnectionResetError):
                return

        def log_message(self, format_string: str, *args: object) -> None:
            return

    return PreviewHandler


def _render_live_page() -> str:
    return """<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>Reme 实时姿态预览</title>
  <script type="importmap">{"imports":{"three":"/vendor/three.module.js"}}</script>
  <style>
    :root { color-scheme: dark; font-family: Inter, "Noto Sans SC", system-ui, sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: #061117; color: #eefbff; }
    header { display: flex; align-items: center; justify-content: space-between; padding: 18px 24px; border-bottom: 1px solid #1b3742; background: rgba(8, 24, 32, .96); }
    h1 { margin: 0; font-size: 22px; }
    .sub { color: #8ea7af; font-size: 13px; margin-top: 4px; }
    .live { display: flex; align-items: center; gap: 8px; color: #70e1c0; font-weight: 700; }
    .dot { width: 10px; height: 10px; border-radius: 50%; background: currentColor; box-shadow: 0 0 14px currentColor; }
    main { padding: 18px; }
    .stage { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
    .panel { overflow: hidden; border: 1px solid #1d3a45; border-radius: 14px; background: #0b1920; }
    .heading { display: flex; justify-content: space-between; align-items: center; padding: 12px 14px; }
    h2 { margin: 0; font-size: 15px; }
    .badge { color: #82d7ee; font-size: 12px; }
    .visual { position: relative; width: 100%; aspect-ratio: 16 / 9; background: #020709; overflow: hidden; }
    #camera-stream, canvas { width: 100%; height: 100%; display: block; object-fit: contain; }
    .tip { position: absolute; right: 10px; bottom: 8px; color: #78969f; font-size: 12px; }
    .cards { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 12px; margin-top: 16px; }
    .card { min-height: 88px; padding: 13px; border: 1px solid #1d3a45; border-radius: 12px; background: #0b1920; }
    .label { color: #88a4ad; font-size: 12px; }
    .value { margin-top: 8px; font-size: 20px; font-weight: 760; font-variant-numeric: tabular-nums; word-break: break-word; }
    .value.small { font-size: 15px; }
    .unknown { color: #f3c36d; }
    .healthy { color: #70e1c0; }
    .error { display: none; margin-top: 16px; padding: 12px 14px; border-radius: 10px; color: #ffc3c3; background: #3b1717; border: 1px solid #703030; }
    .boundary { margin-top: 16px; color: #8ea7af; font-size: 13px; }
    @media (max-width: 960px) { .stage { grid-template-columns: 1fr; } .cards { grid-template-columns: repeat(2, 1fr); } }
  </style>
</head>
<body>
  <header>
    <div><h1>Reme 实时姿态预览</h1><div class="sub">左侧摄像头 · 右侧 2D关键点三维可视化 · 实时姿态分类</div></div>
    <div id="live-state" class="live"><span class="dot"></span><span>连接中</span></div>
  </header>
  <main>
    <div class="stage">
      <section class="panel">
        <div class="heading"><h2>原始摄像头画面</h2><span class="badge">仅本机内存</span></div>
        <div class="visual"><img id="camera-stream" src="/stream.mjpg" alt="实时摄像头"></div>
      </section>
      <section class="panel">
        <div class="heading"><h2>Three.js 节点骨架</h2><span class="badge">展示型3D</span></div>
        <div id="scene-wrap" class="visual">
          <canvas id="pose-canvas" aria-label="实时人体节点骨架"></canvas>
          <div class="tip">拖动旋转 · 滚轮缩放</div>
        </div>
      </section>
    </div>
    <section class="cards">
      <div class="card"><div class="label">姿态</div><div id="posture" class="value unknown">等待</div></div>
      <div class="card"><div class="label">置信度</div><div id="confidence" class="value">—</div></div>
      <div class="card"><div class="label">持续时间</div><div id="duration" class="value">—</div></div>
      <div class="card"><div class="label">运动等级</div><div id="motion" class="value small">—</div></div>
      <div class="card"><div class="label">关键点质量</div><div id="quality" class="value small">—</div></div>
      <div class="card"><div class="label">帧 / 会话</div><div id="frame" class="value small">—</div></div>
    </section>
    <div id="error" class="error"></div>
    <div class="boundary">右侧不是实时 MotionBERT 3D 推断，而是将实时 MoveNet 2D关键点映射到可旋转的浅深度空间。分类模型来自动画参考视频弱标签训练，当前用于接口联调，不代表真人最终准确率。</div>
  </main>
  <script type="module">
    import * as THREE from "three";
    import { OrbitControls } from "/vendor/OrbitControls.js";

    const names = ["nose","left_eye","right_eye","left_ear","right_ear","left_shoulder","right_shoulder","left_elbow","right_elbow","left_wrist","right_wrist","left_hip","right_hip","left_knee","right_knee","left_ankle","right_ankle"];
    const edges = [[0,5],[0,6],[5,6],[5,7],[7,9],[6,8],[8,10],[5,11],[6,12],[11,12],[11,13],[13,15],[12,14],[14,16]];
    const left = new Set([1,3,5,7,9,11,13,15]);
    const right = new Set([2,4,6,8,10,12,14,16]);
    const postureNames = {standing:"站立",sitting:"坐姿",lying:"躺卧",bending_or_crouching:"弯腰/下蹲",unknown:"未知/拒判"};
    const motionNames = {still:"静止",low:"低",medium:"中",high:"高",unknown:"未知"};
    const qualityNames = {usable:"可用",degraded:"降级",unavailable:"不可用"};

    const canvas = document.querySelector('#pose-canvas');
    const wrap = document.querySelector('#scene-wrap');
    const renderer = new THREE.WebGLRenderer({canvas, antialias: true, alpha: true});
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x041017, .06);
    const camera = new THREE.PerspectiveCamera(42, 16 / 9, .05, 100);
    camera.position.set(3.2, 2.2, 4.4);
    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.target.set(0, .9, 0);
    controls.minDistance = 2;
    controls.maxDistance = 8;
    scene.add(new THREE.HemisphereLight(0xcdf8ff, 0x061014, 2.2));
    const keyLight = new THREE.DirectionalLight(0xffffff, 3.2);
    keyLight.position.set(3, 5, 4);
    scene.add(keyLight);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(8, 8), new THREE.MeshStandardMaterial({color:0x0b2028,roughness:.9}));
    floor.rotation.x = -Math.PI / 2;
    scene.add(floor);
    const grid = new THREE.GridHelper(8, 24, 0x5de4ef, 0x173844);
    grid.material.transparent = true;
    grid.material.opacity = .34;
    scene.add(grid);

    function color(index) { return left.has(index) ? 0x68d6ff : right.has(index) ? 0xf2b85d : 0x8fe9b9; }
    const group = new THREE.Group();
    scene.add(group);
    const sphere = new THREE.SphereGeometry(.055, 16, 10);
    const joints = names.map((_, index) => {
      const material = new THREE.MeshStandardMaterial({color:color(index),emissive:color(index),emissiveIntensity:.18,transparent:true});
      const mesh = new THREE.Mesh(sphere, material);
      group.add(mesh);
      return mesh;
    });
    const cylinder = new THREE.CylinderGeometry(.026, .026, 1, 9);
    const bones = edges.map(([start,end]) => {
      const material = new THREE.MeshStandardMaterial({color:color(end),emissive:color(end),emissiveIntensity:.1,transparent:true});
      const mesh = new THREE.Mesh(cylinder, material);
      group.add(mesh);
      return {start,end,mesh};
    });
    const up = new THREE.Vector3(0,1,0);
    const a = new THREE.Vector3(), b = new THREE.Vector3(), mid = new THREE.Vector3(), direction = new THREE.Vector3();

    function mapPoints(keypoints) {
      const hip = [(keypoints[11].x_norm + keypoints[12].x_norm) / 2, (keypoints[11].y_norm + keypoints[12].y_norm) / 2];
      const shoulder = [(keypoints[5].x_norm + keypoints[6].x_norm) / 2, (keypoints[5].y_norm + keypoints[6].y_norm) / 2];
      const torso = Math.max(Math.hypot(shoulder[0]-hip[0], shoulder[1]-hip[1]), .08);
      return keypoints.map((point, index) => {
        const sideDepth = left.has(index) ? -.10 : right.has(index) ? .10 : 0;
        const x = (point.x_norm - hip[0]) / torso;
        const y = (hip[1] - point.y_norm) / torso + .95;
        return [x, y, sideDepth];
      });
    }

    function updateSkeleton(frame) {
      if (!frame?.keypoints?.length) return;
      const points = mapPoints(frame.keypoints);
      points.forEach((point,index) => {
        const score = frame.keypoints[index].score ?? 0;
        joints[index].position.set(...point);
        joints[index].visible = score >= .12;
        joints[index].material.opacity = Math.max(.25, Math.min(1, score + .2));
      });
      bones.forEach(({start,end,mesh}) => {
        const startScore = frame.keypoints[start].score ?? 0;
        const endScore = frame.keypoints[end].score ?? 0;
        mesh.visible = startScore >= .12 && endScore >= .12;
        if (!mesh.visible) return;
        a.set(...points[start]); b.set(...points[end]);
        direction.subVectors(b,a);
        const length = direction.length();
        mid.addVectors(a,b).multiplyScalar(.5);
        mesh.position.copy(mid);
        mesh.scale.set(1, Math.max(length,.0001), 1);
        mesh.quaternion.setFromUnitVectors(up, direction.normalize());
        mesh.material.opacity = Math.max(.25, Math.min(1, Math.min(startScore,endScore)+.2));
      });
    }

    function resize() {
      const width = Math.max(wrap.clientWidth, 1), height = Math.max(wrap.clientHeight, 1);
      renderer.setSize(width,height,false); camera.aspect = width/height; camera.updateProjectionMatrix();
    }
    new ResizeObserver(resize).observe(wrap); resize();
    function animate() { requestAnimationFrame(animate); controls.update(); renderer.render(scene,camera); }
    animate();

    function setText(id, value) { document.querySelector(id).textContent = value; }
    async function poll() {
      try {
        const response = await fetch('/api/state', {cache:'no-store'});
        if (!response.ok) throw new Error(`状态请求失败：${response.status}`);
        const state = await response.json();
        if (state.error) throw new Error(state.error);
        updateSkeleton(state.frame);
        const posture = state.posture;
        const live = document.querySelector('#live-state');
        live.querySelector('span:last-child').textContent = state.stopped ? '已停止' : '实时运行';
        if (posture) {
          const postureElement = document.querySelector('#posture');
          postureElement.textContent = postureNames[posture.posture] || posture.posture;
          postureElement.className = `value ${posture.posture === 'unknown' ? 'unknown' : 'healthy'}`;
          setText('#confidence', `${(posture.posture_confidence * 100).toFixed(1)}%`);
          setText('#duration', `${(posture.posture_duration_ms / 1000).toFixed(1)}s`);
          setText('#motion', motionNames[posture.motion_level] || posture.motion_level);
          setText('#quality', qualityNames[posture.landmark_quality] || posture.landmark_quality);
        }
        if (state.frame) setText('#frame', `${state.frame.frame_index} · ${state.session_id}`);
        document.querySelector('#error').style.display = 'none';
      } catch (error) {
        const box = document.querySelector('#error');
        box.style.display = 'block'; box.textContent = error.message;
        document.querySelector('#live-state span:last-child').textContent = '异常';
      } finally { window.setTimeout(poll, 120); }
    }
    poll();
  </script>
</body>
</html>
"""


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--camera", type=int, default=0)
    parser.add_argument("--width", type=int, default=1280)
    parser.add_argument("--height", type=int, default=720)
    parser.add_argument("--fps", type=float, default=30.0)
    parser.add_argument("--score-threshold", type=float, default=0.2)
    parser.add_argument("--posture-hz", type=float, default=7.5)
    parser.add_argument("--jpeg-quality", type=int, default=78)
    parser.add_argument("--movenet-model", type=Path, default=DEFAULT_MOVENET_MODEL)
    parser.add_argument("--posture-model", type=Path, default=DEFAULT_POSTURE_MODEL)
    parser.add_argument("--vendor-dir", type=Path, default=DEFAULT_VENDOR_DIR)
    parser.add_argument("--session-id")
    parser.add_argument("--scene-id", default="live-camera-001")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """Start the local preview until interrupted."""

    args = _build_parser().parse_args(argv)
    session_id = args.session_id or f"live-preview-{int(time.time())}"
    state = PreviewState(session_id=session_id, scene_id=args.scene_id)
    stop_event = threading.Event()
    try:
        handler = build_preview_handler(
            state=state,
            stop_event=stop_event,
            vendor_dir=args.vendor_dir,
        )
        worker = LivePreviewWorker(
            state=state,
            stop_event=stop_event,
            camera_config=CameraConfig(
                device_index=args.camera,
                width=args.width,
                height=args.height,
                fps=args.fps,
            ),
            movenet_model=args.movenet_model,
            posture_model=args.posture_model,
            posture_hz=args.posture_hz,
            score_threshold=args.score_threshold,
            jpeg_quality=args.jpeg_quality,
        )
        server = PreviewHTTPServer((args.host, args.port), handler)
    except (LivePreviewError, OSError, ValueError) as exc:
        print(f"error: {exc}")
        return 2

    worker.start()
    print(f"Reme live pose preview: http://{args.host}:{args.port}/live")
    print(f"session_id: {session_id}")
    print("Press Ctrl+C to stop.")
    try:
        server.serve_forever(poll_interval=0.2)
    except KeyboardInterrupt:
        print("\nStopping...")
    finally:
        stop_event.set()
        state.stop()
        server.server_close()
        worker.join()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
