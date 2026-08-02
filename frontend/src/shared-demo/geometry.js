export function containedContentRect(
  sourceWidth,
  sourceHeight,
  stageWidth,
  stageHeight,
) {
  if (
    ![sourceWidth, sourceHeight, stageWidth, stageHeight].every(
      (value) => Number.isFinite(value) && value > 0,
    )
  ) {
    return null;
  }
  const sourceAspect = sourceWidth / sourceHeight;
  const stageAspect = stageWidth / stageHeight;
  const width = sourceAspect > stageAspect ? stageWidth : stageHeight * sourceAspect;
  const height = sourceAspect > stageAspect ? stageWidth / sourceAspect : stageHeight;
  return {
    x: (stageWidth - width) / 2,
    y: (stageHeight - height) / 2,
    width,
    height,
  };
}

export function mapPointIntoContainedContent(point, contentRect) {
  if (!contentRect || !point) return null;
  return {
    x: contentRect.x + point.x * contentRect.width,
    y: contentRect.y + point.y * contentRect.height,
    score: point.score,
  };
}
