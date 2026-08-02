import { useEffect, useRef } from "react";
import { containedContentRect, mapPointIntoContainedContent } from "./geometry.js";
import { KEYPOINT_SCORE_THRESHOLD } from "./protocol.js";

const CONNECTIONS = [
  [0, 1], [0, 2], [1, 3], [2, 4],
  [5, 6], [5, 7], [7, 9], [6, 8], [8, 10],
  [5, 11], [6, 12], [11, 12],
  [11, 13], [13, 15], [12, 14], [14, 16],
];

function draw(canvas, frame, color) {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, rect.width);
  const height = Math.max(1, rect.height);
  const pixelWidth = Math.round(width * dpr);
  const pixelHeight = Math.round(height * dpr);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  const context = canvas.getContext("2d");
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, width, height);
  if (!frame?.person_detected || !frame?.keypoints?.length) return;

  const contentRect = containedContentRect(
    frame.source_width,
    frame.source_height,
    width,
    height,
  );
  if (!contentRect) return;
  const points = frame.keypoints.map((point) =>
    mapPointIntoContainedContent(point, contentRect));
  context.save();
  context.lineCap = "round";
  context.lineJoin = "round";
  context.shadowColor = color;
  context.shadowBlur = 14;
  context.strokeStyle = color;
  context.lineWidth = Math.max(2.4, width / 180);
  for (const [from, to] of CONNECTIONS) {
    const a = points[from];
    const b = points[to];
    if (a.score < KEYPOINT_SCORE_THRESHOLD || b.score < KEYPOINT_SCORE_THRESHOLD) continue;
    context.beginPath();
    context.moveTo(a.x, a.y);
    context.lineTo(b.x, b.y);
    context.stroke();
  }
  for (const point of points) {
    if (point.score < KEYPOINT_SCORE_THRESHOLD) continue;
    context.beginPath();
    context.arc(point.x, point.y, Math.max(3, width / 150), 0, Math.PI * 2);
    context.fillStyle = color;
    context.fill();
  }
  context.restore();
}

export function SkeletonStage({ frame, color = "#ff5a00", className = "" }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const paint = () => draw(canvas, frame, color);
    paint();
    const observer = new ResizeObserver(paint);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [color, frame]);

  return <canvas ref={canvasRef} className={`demo-skeleton ${className}`} aria-hidden="true" />;
}
