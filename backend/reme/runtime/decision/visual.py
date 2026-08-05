"""ADR-0003 visual context: an offline pre-cut CLI plus runtime file readers.

The demo host never extracts frames at request time — scenes are pre-recorded,
so the minimal clip is cut once (ffmpeg, developer machine) into the bundle's
``derived/`` directory together with a small metadata file. At runtime B only
reads those files, keeps the sampling window, and reports it truthfully in
``CareDecision.visual_context``.
"""

from __future__ import annotations

import argparse
import json
import subprocess
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from reme.decision.mimo.adapter import build_video_part
from reme.decision.records import VisualContext, VisualContextType
from reme.pose.scene_bundle import SceneBundleError, load_scene_manifest

VISUAL_CLIP_NAME = "visual_context.mp4"
VISUAL_META_NAME = "visual_context.json"
DEFAULT_SHORT_EDGE = 384


class VisualAssetError(ValueError):
    """Raised when a bundle's pre-cut visual context is unusable."""


@dataclass(frozen=True, slots=True)
class VisualAsset:
    """One pre-cut clip and the window it was sampled from."""

    clip_path: Path
    start_ms: float
    end_ms: float


def load_visual_asset(bundle_dir: str | Path) -> VisualAsset | None:
    """Return the bundle's pre-cut visual context, or None when absent."""

    derived = Path(bundle_dir) / "derived"
    clip_path = derived / VISUAL_CLIP_NAME
    meta_path = derived / VISUAL_META_NAME
    if not clip_path.is_file() or not meta_path.is_file():
        return None
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise VisualAssetError(f"cannot read visual metadata: {exc}") from exc
    start_ms = meta.get("start_ms") if isinstance(meta, dict) else None
    end_ms = meta.get("end_ms") if isinstance(meta, dict) else None
    for label, value in (("start_ms", start_ms), ("end_ms", end_ms)):
        if isinstance(value, bool) or not isinstance(value, int | float) or value < 0:
            raise VisualAssetError(f"visual metadata {label} must be a non-negative number")
    assert isinstance(start_ms, int | float) and isinstance(end_ms, int | float)
    if end_ms < start_ms:
        raise VisualAssetError("visual metadata end_ms must be >= start_ms")
    return VisualAsset(clip_path=clip_path, start_ms=float(start_ms), end_ms=float(end_ms))


def visual_payload(asset: VisualAsset, *, fps: int = 1) -> dict[str, Any]:
    """Read the clip and wrap it as a MiMo video content part."""

    return build_video_part(asset.clip_path.read_bytes(), fps=fps)


def visual_context_record(asset: VisualAsset) -> VisualContext:
    """The truthful wire record for a clip that is being sent."""

    return VisualContext(
        sent_to_mimo=True,
        type=VisualContextType.CLIP,
        start_ms=asset.start_ms,
        end_ms=asset.end_ms,
    )


def ffmpeg_args(
    source: Path,
    output: Path,
    *,
    start_ms: float,
    end_ms: float,
    short_edge: int = DEFAULT_SHORT_EDGE,
) -> list[str]:
    """Deterministic ffmpeg invocation for the pre-cut (pure, testable)."""

    scale = f"scale='if(gt(iw,ih),-2,{short_edge})':'if(gt(iw,ih),{short_edge},-2)'"
    return [
        "ffmpeg",
        "-loglevel",
        "error",
        "-y",
        "-ss",
        f"{start_ms / 1000:.3f}",
        "-to",
        f"{end_ms / 1000:.3f}",
        "-i",
        str(source),
        "-vf",
        scale,
        "-an",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        str(output),
    ]


def precut(
    manifest_path: str | Path,
    *,
    start_ms: float,
    end_ms: float,
    short_edge: int = DEFAULT_SHORT_EDGE,
) -> VisualAsset:
    """Cut the minimal clip into the bundle's derived/ directory."""

    if end_ms <= start_ms:
        raise VisualAssetError("end_ms must be greater than start_ms")
    manifest = load_scene_manifest(manifest_path)
    source = manifest.resolve_media_path()
    if not source.is_file():
        raise VisualAssetError(f"bundle media does not exist: {source}")
    derived = manifest.path.parent / "derived"
    derived.mkdir(parents=True, exist_ok=True)
    clip_path = derived / VISUAL_CLIP_NAME
    command = ffmpeg_args(
        source, clip_path, start_ms=start_ms, end_ms=end_ms, short_edge=short_edge
    )
    completed = subprocess.run(command, capture_output=True, text=True, check=False)
    if completed.returncode != 0 or not clip_path.is_file():
        raise VisualAssetError(f"ffmpeg failed: {completed.stderr.strip()[:300]}")
    meta = {"start_ms": start_ms, "end_ms": end_ms, "short_edge": short_edge}
    (derived / VISUAL_META_NAME).write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
    return VisualAsset(clip_path=clip_path, start_ms=start_ms, end_ms=end_ms)


def main(argv: Sequence[str] | None = None) -> int:
    """CLI: pre-cut one bundle's minimal visual context."""

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--start-ms", type=float, required=True)
    parser.add_argument("--end-ms", type=float, required=True)
    parser.add_argument("--short-edge", type=int, default=DEFAULT_SHORT_EDGE)
    args = parser.parse_args(argv)
    try:
        asset = precut(
            args.manifest,
            start_ms=args.start_ms,
            end_ms=args.end_ms,
            short_edge=args.short_edge,
        )
    except (VisualAssetError, SceneBundleError) as exc:
        print(f"error: {exc}")
        return 2
    print(f"visual context written: {asset.clip_path} ({asset.start_ms}-{asset.end_ms}ms)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
