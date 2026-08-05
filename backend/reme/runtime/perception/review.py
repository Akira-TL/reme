# ruff: noqa: E501
"""Generate a synchronized source-video and MotionBERT Three.js review page."""

from __future__ import annotations

import argparse
import html
import json
import math
import os
import shutil
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from reme.pose.scene_bundle import SceneBundleError, load_scene_manifest

POSE_3D_SCHEMA_VERSION = "reme-keypoints-3d/v0-experiment"
MOTIONBERT_SOURCE_SCHEMA = "motionbert-h36m-17/offline-demo-v1"
THREE_VENDOR_FILES = ("three.module.js", "three.core.js", "OrbitControls.js")


class PoseReviewError(ValueError):
    """Raised when a scene bundle cannot produce a Three.js review page."""


def build_pose_review_page(
    manifest_path: str | Path,
    output_path: str | Path,
    candidate_times_ms: Sequence[float],
    *,
    poses_3d_path: str | Path | None = None,
    vendor_dir: str | Path | None = None,
) -> Path:
    """Install 3D assets and write a synchronized video/Three.js review page."""

    try:
        manifest = load_scene_manifest(manifest_path)
    except SceneBundleError as exc:
        raise PoseReviewError(str(exc)) from exc

    source_video = manifest.resolve_media_path()
    if not source_video.is_file():
        raise PoseReviewError(f"source video does not exist: {source_video}")

    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)

    if poses_3d_path is not None:
        poses_path = _install_motionbert_poses(manifest.path, Path(poses_3d_path))
        manifest = load_scene_manifest(manifest.path)
    else:
        resolved = manifest.resolve_stream_path("keypoints_3d")
        if resolved is None:
            raise PoseReviewError("manifest does not provide streams.keypoints_3d")
        poses_path = resolved
        _validate_pose_payload(
            _read_json_object(poses_path, "3D pose data"),
            scene_id=manifest.data["scene_id"],
            expected_frame_count=manifest.data["media"]["frame_count"],
        )

    if vendor_dir is not None:
        _install_three_vendor(Path(vendor_dir), output.parent / "vendor")
    else:
        _require_three_vendor(output.parent / "vendor")

    candidates = _normalize_candidate_times(candidate_times_ms)
    source_url = _relative_url(source_video, output.parent)
    poses_url = _relative_url(poses_path, output.parent)
    title = html.escape(str(manifest.data.get("title", manifest.data["scene_id"])))
    scene_id = html.escape(manifest.data["scene_id"])
    candidate_buttons = "\n".join(
        (
            '<button type="button" class="candidate" '
            f'data-time-seconds="{seconds:g}">{seconds:.3f} 秒</button>'
        )
        for seconds in (candidate / 1000.0 for candidate in candidates)
    )
    if not candidate_buttons:
        candidate_buttons = '<span class="empty">没有预设候选时间点</span>'

    output.write_text(
        _render_page(
            title=title,
            scene_id=scene_id,
            source_url=html.escape(source_url, quote=True),
            poses_url=html.escape(poses_url, quote=True),
            candidate_buttons=candidate_buttons,
        ),
        encoding="utf-8",
    )
    return output


def _install_motionbert_poses(manifest_path: Path, source_path: Path) -> Path:
    manifest_data = _read_json_object(manifest_path, "scene manifest")
    source_payload = _read_json_object(source_path, "MotionBERT pose data")
    if source_payload.get("schema") != MOTIONBERT_SOURCE_SCHEMA:
        raise PoseReviewError(
            f"MotionBERT schema must be {MOTIONBERT_SOURCE_SCHEMA!r}, "
            f"got {source_payload.get('schema')!r}"
        )

    scene_id = manifest_data.get("scene_id")
    media = manifest_data.get("media")
    if not isinstance(scene_id, str) or not isinstance(media, dict):
        raise PoseReviewError("scene manifest is missing scene_id or media")
    expected_frame_count = media.get("frame_count")
    if not isinstance(expected_frame_count, int):
        raise PoseReviewError("scene manifest media.frame_count must be an integer")

    converted = {
        "schema_version": POSE_3D_SCHEMA_VERSION,
        "scene_id": scene_id,
        "source_schema": MOTIONBERT_SOURCE_SCHEMA,
        "model": source_payload.get("model"),
        "video": _without_source_frame_indices(source_payload.get("video")),
        "coordinate_system": source_payload.get("coordinate_system"),
        "joint_names": source_payload.get("joint_names"),
        "edges": source_payload.get("edges"),
        "frames": source_payload.get("frames"),
        "scores": source_payload.get("scores"),
        "runtime": source_payload.get("runtime"),
        "warning": source_payload.get("warning"),
    }
    _validate_pose_payload(
        converted,
        scene_id=scene_id,
        expected_frame_count=expected_frame_count,
    )

    destination = manifest_path.parent / "derived" / "poses3d.json"
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(
        json.dumps(converted, ensure_ascii=False, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )

    streams = manifest_data.get("streams")
    if not isinstance(streams, dict):
        raise PoseReviewError("scene manifest streams must be an object")
    streams["keypoints_3d"] = "derived/poses3d.json"
    manifest_path.write_text(
        json.dumps(manifest_data, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return destination


def _without_source_frame_indices(video: object) -> object:
    if not isinstance(video, dict):
        return video
    result = dict(video)
    result.pop("source_frame_indices", None)
    return result


def _validate_pose_payload(
    payload: dict[str, Any], *, scene_id: str, expected_frame_count: int
) -> None:
    if payload.get("schema_version") != POSE_3D_SCHEMA_VERSION:
        raise PoseReviewError(f"3D pose schema_version must be {POSE_3D_SCHEMA_VERSION!r}")
    if payload.get("scene_id") != scene_id:
        raise PoseReviewError(f"3D pose scene_id must be {scene_id!r}")

    video = payload.get("video")
    if not isinstance(video, dict) or video.get("frame_count") != expected_frame_count:
        raise PoseReviewError(
            "3D pose frame_count must match scene manifest: "
            f"expected {expected_frame_count}, got "
            f"{video.get('frame_count') if isinstance(video, dict) else None}"
        )

    joint_names = payload.get("joint_names")
    if not isinstance(joint_names, list) or len(joint_names) != 17:
        raise PoseReviewError("3D pose joint_names must contain 17 names")
    if any(not isinstance(name, str) or not name for name in joint_names):
        raise PoseReviewError("3D pose joint_names must be non-empty strings")

    edges = payload.get("edges")
    if not isinstance(edges, list) or not edges:
        raise PoseReviewError("3D pose edges must be a non-empty list")
    for edge in edges:
        if (
            not isinstance(edge, list)
            or len(edge) != 2
            or any(not isinstance(index, int) or not 0 <= index < 17 for index in edge)
        ):
            raise PoseReviewError("3D pose edges must reference valid joint indices")

    frames = payload.get("frames")
    if not isinstance(frames, list) or len(frames) != expected_frame_count:
        raise PoseReviewError(
            "3D pose frames length must match frame_count: "
            f"expected {expected_frame_count}, got "
            f"{len(frames) if isinstance(frames, list) else None}"
        )
    for frame_index, frame in enumerate(frames):
        if not isinstance(frame, list) or len(frame) != 17:
            raise PoseReviewError(f"3D pose frame {frame_index} must contain 17 joints")
        for point in frame:
            if (
                not isinstance(point, list)
                or len(point) != 3
                or any(
                    isinstance(value, bool)
                    or not isinstance(value, int | float)
                    or not math.isfinite(float(value))
                    for value in point
                )
            ):
                raise PoseReviewError(
                    f"3D pose frame {frame_index} contains an invalid coordinate"
                )

    scores = payload.get("scores")
    if scores is not None:
        if not isinstance(scores, list) or len(scores) != expected_frame_count:
            raise PoseReviewError("3D pose scores length must match frame_count")
        for frame_scores in scores:
            if not isinstance(frame_scores, list) or len(frame_scores) != 17:
                raise PoseReviewError("each 3D pose score frame must contain 17 values")


def _install_three_vendor(source_dir: Path, destination_dir: Path) -> None:
    _require_three_vendor(source_dir)
    destination_dir.mkdir(parents=True, exist_ok=True)
    for filename in THREE_VENDOR_FILES:
        shutil.copy2(source_dir / filename, destination_dir / filename)


def _require_three_vendor(vendor_dir: Path) -> None:
    missing = [filename for filename in THREE_VENDOR_FILES if not (vendor_dir / filename).is_file()]
    if missing:
        raise PoseReviewError(
            f"Three.js vendor files are missing from {vendor_dir}: {', '.join(missing)}"
        )


def _read_json_object(path: Path, label: str) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise PoseReviewError(f"cannot read {label}: {exc}") from exc
    if not isinstance(payload, dict):
        raise PoseReviewError(f"{label} must be a JSON object")
    return payload


def _normalize_candidate_times(candidate_times_ms: Sequence[float]) -> tuple[float, ...]:
    normalized: set[float] = set()
    for value in candidate_times_ms:
        if isinstance(value, bool) or not isinstance(value, int | float) or value < 0:
            raise PoseReviewError("candidate times must be non-negative milliseconds")
        normalized.add(float(value))
    return tuple(sorted(normalized))


def _relative_url(path: Path, base_dir: Path) -> str:
    return Path(os.path.relpath(path, base_dir)).as_posix()


def _render_page(
    *,
    title: str,
    scene_id: str,
    source_url: str,
    poses_url: str,
    candidate_buttons: str,
) -> str:
    return f"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>{title} — 三维姿态视觉验收</title>
  <script type="importmap">
    {{"imports": {{"three": "./vendor/three.module.js"}}}}
  </script>
  <style>
    :root {{ color-scheme: dark; font-family: Inter, system-ui, sans-serif; }}
    * {{ box-sizing: border-box; }}
    body {{ margin: 0; padding: 22px; background: #071117; color: #edf9fb; }}
    h1 {{ margin: 0 0 6px; font-size: 24px; }}
    h2 {{ margin: 0; font-size: 16px; }}
    .meta {{ color: #8ba5ad; margin-bottom: 16px; }}
    .stage {{ display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }}
    .panel {{ overflow: hidden; background: #0c1a21; border: 1px solid #1c3a45; border-radius: 14px; }}
    .heading {{ display: flex; justify-content: space-between; padding: 12px 14px; }}
    .status {{ color: #70e1c0; font-size: 13px; }}
    .media-wrap, .scene-wrap {{ position: relative; width: 100%; aspect-ratio: 16 / 9; background: #020709; }}
    video, canvas {{ display: block; width: 100%; height: 100%; object-fit: contain; }}
    .scene-tip {{ position: absolute; right: 10px; bottom: 8px; color: #83a2aa; font-size: 12px; }}
    .controls, .candidates, .checklist, .boundary {{ margin-top: 16px; padding: 14px; background: #0c1a21; border: 1px solid #1c3a45; border-radius: 12px; }}
    button {{ margin: 4px 6px 4px 0; padding: 8px 12px; color: #eafcff; background: #12303b; border: 1px solid #285565; border-radius: 8px; cursor: pointer; }}
    button:hover {{ background: #194454; }}
    .time {{ font-variant-numeric: tabular-nums; margin-left: 8px; }}
    .checklist li {{ margin: 7px 0; }}
    .empty {{ color: #78929a; }}
    .error {{ display: none; padding: 10px; color: #ffb4b4; background: #3a1515; }}
    @media (max-width: 900px) {{ .stage {{ grid-template-columns: 1fr; }} }}
  </style>
</head>
<body>
  <h1>{title}</h1>
  <div class="meta">scene_id: <code>{scene_id}</code> · 左侧原视频 / 右侧 MotionBERT 三维骨架</div>

  <div class="stage">
    <section class="panel">
      <div class="heading"><h2>原视频</h2><span class="status">本机读取</span></div>
      <div class="media-wrap">
        <video id="source" controls preload="metadata" playsinline>
          <source src="{source_url}" type="video/mp4">
        </video>
      </div>
    </section>
    <section class="panel">
      <div class="heading"><h2>Three.js 三维骨架</h2><span id="pose-status" class="status">载入中</span></div>
      <div id="scene-wrap" class="scene-wrap">
        <canvas id="pose-canvas" aria-label="MotionBERT 三维人体骨架"></canvas>
        <div class="scene-tip">拖动旋转 · 滚轮缩放</div>
      </div>
      <div id="error" class="error"></div>
    </section>
  </div>

  <section class="controls">
    <button type="button" id="play">播放 / 暂停</button>
    <button type="button" id="back">后退 0.5 秒</button>
    <button type="button" id="forward">前进 0.5 秒</button>
    <button type="button" data-view="front">正视</button>
    <button type="button" data-view="side">侧视</button>
    <button type="button" data-view="top">俯视</button>
    <button type="button" data-view="reset">重置视角</button>
    <span class="time" id="time">0.000 秒 · Frame 0</span>
  </section>

  <section class="candidates">
    <h2>候选检查时间点</h2>
    {candidate_buttons}
  </section>

  <section class="checklist">
    <h2>人工验收清单</h2>
    <ul>
      <li>原视频与三维骨架的动作时序是否一致。</li>
      <li>低位动作中，髋、膝、踝连接是否符合人体结构。</li>
      <li>快速动作中，左右肢体是否互换或出现瞬时错位。</li>
      <li>明显位移来自真实动作、2D 抖动还是 3D 恢复误差。</li>
      <li>旋转视角后，深度方向是否出现明显不合理折叠。</li>
    </ul>
  </section>

  <section class="boundary">
    <strong>能力边界：</strong>右侧为单目、根节点相对的三维姿态估计，不是房间绝对坐标，也不是医学级空间测量。
  </section>

  <script type="module">
    import * as THREE from "three";
    import {{ OrbitControls }} from "./vendor/OrbitControls.js";

    const POSES_URL = {json.dumps(poses_url)};
    const video = document.querySelector('#source');
    const canvas = document.querySelector('#pose-canvas');
    const sceneWrap = document.querySelector('#scene-wrap');
    const timeText = document.querySelector('#time');
    const poseStatus = document.querySelector('#pose-status');
    const errorBox = document.querySelector('#error');

    const LEFT = new Set([4, 5, 6, 11, 12, 13]);
    const RIGHT = new Set([1, 2, 3, 14, 15, 16]);
    const CENTER_COLOR = 0x8fe9b9;
    const LEFT_COLOR = 0x68d6ff;
    const RIGHT_COLOR = 0xf2b85d;

    let poseData = null;
    let currentFrame = -1;
    let joints = [];
    let bones = [];

    const renderer = new THREE.WebGLRenderer({{ canvas, antialias: true, alpha: true }});
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x041017, 0.055);
    const camera = new THREE.PerspectiveCamera(42, 16 / 9, 0.05, 100);
    camera.position.set(3.3, 2.35, 4.5);
    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.target.set(0, 0.95, 0);
    controls.minDistance = 2.2;
    controls.maxDistance = 9;
    controls.update();

    scene.add(new THREE.HemisphereLight(0xc9f7ff, 0x061014, 2.2));
    const keyLight = new THREE.DirectionalLight(0xffffff, 3.4);
    keyLight.position.set(3, 5, 4);
    scene.add(keyLight);
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(8, 8),
      new THREE.MeshStandardMaterial({{ color: 0x0b2028, roughness: 0.9 }})
    );
    floor.rotation.x = -Math.PI / 2;
    scene.add(floor);
    const grid = new THREE.GridHelper(8, 24, 0x5de4ef, 0x173844);
    grid.material.transparent = true;
    grid.material.opacity = 0.34;
    scene.add(grid);

    function jointColor(index) {{
      if (LEFT.has(index)) return LEFT_COLOR;
      if (RIGHT.has(index)) return RIGHT_COLOR;
      return CENTER_COLOR;
    }}

    function createSkeleton() {{
      const group = new THREE.Group();
      scene.add(group);
      const sphere = new THREE.SphereGeometry(0.055, 18, 12);
      joints = poseData.joint_names.map((_, index) => {{
        const color = jointColor(index);
        const mesh = new THREE.Mesh(
          sphere,
          new THREE.MeshStandardMaterial({{
            color,
            emissive: color,
            emissiveIntensity: 0.18,
            transparent: true,
          }})
        );
        group.add(mesh);
        return mesh;
      }});
      const cylinder = new THREE.CylinderGeometry(0.028, 0.028, 1, 10);
      bones = poseData.edges.map(([start, end]) => {{
        const mesh = new THREE.Mesh(
          cylinder,
          new THREE.MeshStandardMaterial({{
            color: jointColor(end),
            emissive: jointColor(end),
            emissiveIntensity: 0.1,
            transparent: true,
          }})
        );
        group.add(mesh);
        return {{ start, end, mesh }};
      }});
    }}

    const up = new THREE.Vector3(0, 1, 0);
    const startVector = new THREE.Vector3();
    const endVector = new THREE.Vector3();
    const middleVector = new THREE.Vector3();
    const directionVector = new THREE.Vector3();

    function updateSkeleton(frameIndex) {{
      if (!poseData || frameIndex === currentFrame) return;
      currentFrame = frameIndex;
      const frame = poseData.frames[frameIndex];
      const scores = poseData.scores?.[frameIndex] || [];
      frame.forEach((point, index) => {{
        joints[index].position.set(point[0], point[1], point[2]);
        joints[index].material.opacity = THREE.MathUtils.clamp(0.3 + (scores[index] ?? 1), 0.35, 1);
      }});
      bones.forEach(({{ start, end, mesh }}) => {{
        startVector.set(...frame[start]);
        endVector.set(...frame[end]);
        directionVector.subVectors(endVector, startVector);
        const length = directionVector.length();
        middleVector.addVectors(startVector, endVector).multiplyScalar(0.5);
        mesh.position.copy(middleVector);
        mesh.scale.set(1, Math.max(length, 0.0001), 1);
        mesh.quaternion.setFromUnitVectors(up, directionVector.normalize());
      }});
      timeText.textContent = `${{video.currentTime.toFixed(3)}} 秒 · Frame ${{frameIndex + 1}} / ${{poseData.video.frame_count}}`;
    }}

    function updateFromVideo() {{
      if (!poseData) return;
      const frame = Math.min(
        poseData.video.frame_count - 1,
        Math.max(0, Math.round(video.currentTime * poseData.video.fps))
      );
      updateSkeleton(frame);
    }}

    function seek(seconds) {{
      video.currentTime = Math.max(0, Math.min(seconds, video.duration || seconds));
      updateFromVideo();
    }}

    function resize() {{
      const width = Math.max(sceneWrap.clientWidth, 1);
      const height = Math.max(sceneWrap.clientHeight, 1);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    }}

    function setView(view) {{
      if (view === 'front') camera.position.set(0, 1.65, 4.8);
      else if (view === 'side') camera.position.set(4.8, 1.65, 0);
      else if (view === 'top') camera.position.set(0.05, 6.2, 0.05);
      else camera.position.set(3.3, 2.35, 4.5);
      controls.target.set(0, 0.95, 0);
      controls.update();
    }}

    async function boot() {{
      const response = await fetch(POSES_URL, {{ cache: 'no-store' }});
      if (!response.ok) throw new Error(`3D 数据载入失败：${{response.status}}`);
      poseData = await response.json();
      createSkeleton();
      updateSkeleton(0);
      poseStatus.textContent = `${{poseData.video.frame_count}} 帧已载入`;
      resize();
    }}

    document.querySelector('#play').addEventListener('click', async () => {{
      if (video.paused) await video.play();
      else video.pause();
    }});
    document.querySelector('#back').addEventListener('click', () => seek(video.currentTime - 0.5));
    document.querySelector('#forward').addEventListener('click', () => seek(video.currentTime + 0.5));
    document.querySelectorAll('.candidate').forEach((button) => {{
      button.addEventListener('click', () => seek(Number(button.dataset.timeSeconds)));
    }});
    document.querySelectorAll('[data-view]').forEach((button) => {{
      button.addEventListener('click', () => setView(button.dataset.view));
    }});
    video.addEventListener('timeupdate', updateFromVideo);
    video.addEventListener('seeked', updateFromVideo);
    new ResizeObserver(resize).observe(sceneWrap);

    function animate() {{
      requestAnimationFrame(animate);
      controls.update();
      updateFromVideo();
      renderer.render(scene, camera);
    }}

    boot().catch((error) => {{
      console.error(error);
      poseStatus.textContent = '载入失败';
      errorBox.style.display = 'block';
      errorBox.textContent = error.message;
    }});
    animate();
  </script>
</body>
</html>
"""


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--poses-3d", type=Path)
    parser.add_argument("--vendor-dir", type=Path)
    parser.add_argument("--candidate-ms", type=float, action="append", default=[])
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """Generate a synchronized source-video and Three.js review page."""

    args = _build_parser().parse_args(argv)
    output = args.output or args.manifest.parent / "review.html"
    try:
        result = build_pose_review_page(
            args.manifest,
            output,
            args.candidate_ms,
            poses_3d_path=args.poses_3d,
            vendor_dir=args.vendor_dir,
        )
    except PoseReviewError as exc:
        print(f"error: {exc}")
        return 2
    print(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
