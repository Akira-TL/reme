"""Compatibility entrypoint for the A-owned pose scene-bundle module."""

from reme.pose.scene_bundle import (
    FRAME_LANDMARKS_SCHEMA_VERSION,
    MOVENET_KEYPOINT_NAMES,
    SCENE_SCHEMA_VERSION,
    FrameLandmarksSummary,
    SceneBundleError,
    SceneManifest,
    build_scene_bundle,
    load_scene_manifest,
    main,
    validate_frame_landmarks_jsonl,
)

__all__ = [
    "FRAME_LANDMARKS_SCHEMA_VERSION",
    "MOVENET_KEYPOINT_NAMES",
    "SCENE_SCHEMA_VERSION",
    "FrameLandmarksSummary",
    "SceneBundleError",
    "SceneManifest",
    "build_scene_bundle",
    "load_scene_manifest",
    "main",
    "validate_frame_landmarks_jsonl",
]


if __name__ == "__main__":
    raise SystemExit(main())
