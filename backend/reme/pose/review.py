"""Generate a synchronized source/skeleton review page for A's visual acceptance."""

from __future__ import annotations

import argparse
import html
import os
from collections.abc import Sequence
from pathlib import Path

from reme.pose.scene_bundle import SceneBundleError, load_scene_manifest


class PoseReviewError(ValueError):
    """Raised when a scene bundle cannot produce a visual review page."""


def build_pose_review_page(
    manifest_path: str | Path,
    output_path: str | Path,
    candidate_times_ms: Sequence[float],
) -> Path:
    """Write a local HTML page that synchronizes source and skeleton videos."""

    try:
        manifest = load_scene_manifest(manifest_path)
    except SceneBundleError as exc:
        raise PoseReviewError(str(exc)) from exc

    source_video = manifest.resolve_media_path()
    if not source_video.is_file():
        raise PoseReviewError(f"source video does not exist: {source_video}")

    diagnostics = manifest.data.get("diagnostics")
    if not isinstance(diagnostics, dict):
        raise PoseReviewError("manifest diagnostics must contain skeleton_video")
    skeleton_reference = diagnostics.get("skeleton_video")
    if not isinstance(skeleton_reference, str) or not skeleton_reference:
        raise PoseReviewError("manifest diagnostics must contain skeleton_video")
    if "://" in skeleton_reference:
        raise PoseReviewError("skeleton_video must be a local reference")

    skeleton_video = manifest.path.parent / skeleton_reference
    if not skeleton_video.is_file():
        raise PoseReviewError(f"skeleton video does not exist: {skeleton_video}")

    candidates = _normalize_candidate_times(candidate_times_ms)
    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    source_url = _relative_url(source_video, output.parent)
    skeleton_url = _relative_url(skeleton_video, output.parent)
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
            skeleton_url=html.escape(skeleton_url, quote=True),
            candidate_buttons=candidate_buttons,
        ),
        encoding="utf-8",
    )
    return output


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
    skeleton_url: str,
    candidate_buttons: str,
) -> str:
    return f"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{title} — 姿态视觉验收</title>
  <style>
    :root {{ color-scheme: dark; font-family: system-ui, sans-serif; }}
    body {{ margin: 0; padding: 24px; background: #111; color: #eee; }}
    h1 {{ margin: 0 0 6px; font-size: 24px; }}
    .meta {{ color: #aaa; margin-bottom: 18px; }}
    .videos {{ display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }}
    .panel {{ background: #1b1b1b; border: 1px solid #333; border-radius: 12px; padding: 12px; }}
    .panel h2 {{ margin: 0 0 10px; font-size: 16px; }}
    video {{ display: block; width: 100%; background: #000; }}
    .controls, .candidates, .checklist {{ margin-top: 18px; }}
    button {{ margin: 4px 6px 4px 0; padding: 8px 12px; cursor: pointer; }}
    .time {{ font-variant-numeric: tabular-nums; margin-left: 10px; }}
    .checklist li {{ margin: 8px 0; }}
    .empty {{ color: #888; }}
    @media (max-width: 800px) {{ .videos {{ grid-template-columns: 1fr; }} }}
  </style>
</head>
<body>
  <h1>{title}</h1>
  <div class="meta">scene_id: <code>{scene_id}</code></div>

  <div class="videos">
    <section class="panel">
      <h2>原视频</h2>
      <video id="source" src="{source_url}" controls preload="metadata"></video>
    </section>
    <section class="panel">
      <h2>骨架视频</h2>
      <video id="skeleton" src="{skeleton_url}" controls preload="metadata"></video>
    </section>
  </div>

  <section class="controls">
    <button type="button" id="play">同步播放</button>
    <button type="button" id="pause">同步暂停</button>
    <button type="button" id="back">后退 0.5 秒</button>
    <button type="button" id="forward">前进 0.5 秒</button>
    <span class="time" id="time">0.000 秒</span>
  </section>

  <section class="candidates">
    <h2>候选检查时间点</h2>
    {candidate_buttons}
  </section>

  <section class="checklist">
    <h2>人工验收清单</h2>
    <ul>
      <li>人体离画或遮挡时，骨架是否仍被错误延续。</li>
      <li>低位动作中，髋、膝、踝连接是否符合人体结构。</li>
      <li>快速动作中，左右肢体是否互换或出现瞬时错位。</li>
      <li>明显位移来自真实动作还是模型抖动。</li>
      <li>原视频与骨架视频的时间轴是否保持同步。</li>
    </ul>
  </section>

  <script>
    const source = document.querySelector('#source');
    const skeleton = document.querySelector('#skeleton');
    const time = document.querySelector('#time');

    function seek(seconds) {{
      const target = Math.max(0, Math.min(seconds, source.duration || seconds));
      source.currentTime = target;
      skeleton.currentTime = target;
      time.textContent = `${{target.toFixed(3)}} 秒`;
    }}

    document.querySelector('#play').addEventListener('click', async () => {{
      skeleton.currentTime = source.currentTime;
      await Promise.allSettled([source.play(), skeleton.play()]);
    }});
    document.querySelector('#pause').addEventListener('click', () => {{
      source.pause();
      skeleton.pause();
    }});
    document.querySelector('#back').addEventListener(
      'click', () => seek(source.currentTime - 0.5)
    );
    document.querySelector('#forward').addEventListener(
      'click', () => seek(source.currentTime + 0.5)
    );
    document.querySelectorAll('.candidate').forEach((button) => {{
      button.addEventListener('click', () => seek(Number(button.dataset.timeSeconds)));
    }});
    source.addEventListener('timeupdate', () => {{
      time.textContent = `${{source.currentTime.toFixed(3)}} 秒`;
      if (!source.paused && Math.abs(source.currentTime - skeleton.currentTime) > 0.08) {{
        skeleton.currentTime = source.currentTime;
      }}
    }});
    source.addEventListener('seeking', () => {{ skeleton.currentTime = source.currentTime; }});
    source.addEventListener('pause', () => skeleton.pause());
  </script>
</body>
</html>
"""


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--candidate-ms", type=float, action="append", default=[])
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """Generate a synchronized visual review page."""

    args = _build_parser().parse_args(argv)
    output = args.output or args.manifest.parent / "review.html"
    try:
        result = build_pose_review_page(args.manifest, output, args.candidate_ms)
    except PoseReviewError as exc:
        print(f"error: {exc}")
        return 2
    print(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
