const VIEW_MODES = Object.freeze({
  visible: "video_skeleton",
  blurred: "blurred_skeleton",
  skeleton_only: "skeleton",
  hidden: "hidden",
});

export function homePrivacyViewMode(sceneId, decision) {
  if (sceneId === "bathroom") return "skeleton";
  return VIEW_MODES[decision?.privacy_mode] || "skeleton";
}

export function privacyAllowsEventVideo(sceneId, decision) {
  return sceneId !== "bathroom"
    && decision?.privacy_mode !== "hidden";
}
