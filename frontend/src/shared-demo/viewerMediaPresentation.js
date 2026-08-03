export function selectViewerMediaStage({ grant, status, stream } = {}) {
  if (!grant) {
    return Object.freeze({
      kind: "none",
      videoVisible: false,
      neutralBackdrop: false,
    });
  }
  if (status === "live" && stream) {
    return Object.freeze({
      kind: "live",
      videoVisible: true,
      neutralBackdrop: false,
    });
  }
  return Object.freeze({
    kind: status === "failed" ? "failed" : "pending",
    videoVisible: false,
    neutralBackdrop: true,
  });
}
