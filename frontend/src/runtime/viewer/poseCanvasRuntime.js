// @ts-check

import {
  interpolatePoseFrame,
  POSE_DISPLAY_INTERPOLATION_MS,
} from "../../shared-demo/poseDisplaySmoothing.js";

const EDGES = Object.freeze([
  [0, 1], [0, 2], [1, 3], [2, 4],
  [5, 6], [5, 7], [7, 9], [6, 8], [8, 10],
  [5, 11], [6, 12], [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
]);

/**
 * @param {HTMLCanvasElement | any} canvas
 * @param {any | null} frame
 * @param {number} [devicePixelRatio]
 */
export function drawPose(canvas, frame, devicePixelRatio = globalThis.devicePixelRatio || 1) {
  const bounds = canvas.getBoundingClientRect();
  const ratio = Math.min(devicePixelRatio, 2);
  const width = Math.max(1, Math.round(bounds.width * ratio));
  const height = Math.max(1, Math.round(bounds.height * ratio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, width, height);
  if (!frame?.person_detected) return;
  const points = frame.keypoints;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.strokeStyle = "#ff5a00";
  context.lineWidth = Math.max(3, width * 0.007);
  for (const [start, end] of EDGES) {
    if (points[start]?.score < 0.2 || points[end]?.score < 0.2) continue;
    context.beginPath();
    context.moveTo(points[start].x * width, points[start].y * height);
    context.lineTo(points[end].x * width, points[end].y * height);
    context.stroke();
  }
  for (const point of points) {
    if (point.score < 0.2) continue;
    context.beginPath();
    context.arc(point.x * width, point.y * height, Math.max(4, width * 0.012), 0, Math.PI * 2);
    context.fillStyle = "#ffffff";
    context.fill();
    context.lineWidth = Math.max(2, width * 0.004);
    context.strokeStyle = "#ff5a00";
    context.stroke();
  }
}

/**
 * Owns ResizeObserver and requestAnimationFrame for one Family pose canvas.
 * It only renders presentation frames and has no transport or authority API.
 *
 * @param {object} parameters
 * @param {HTMLCanvasElement | any} parameters.canvas
 * @param {(canvas: any, frame: any | null) => void} [parameters.draw]
 * @param {(callback: FrameRequestCallback | ((time: number) => void)) => number} [parameters.requestFrame]
 * @param {(handle: number) => void} [parameters.cancelFrame]
 * @param {typeof ResizeObserver | any} [parameters.ResizeObserverImpl]
 * @param {() => number} [parameters.now]
 * @param {number} [parameters.interpolationMs]
 */
export function createPoseCanvasRuntime({
  canvas,
  draw = drawPose,
  requestFrame = globalThis.requestAnimationFrame?.bind(globalThis),
  cancelFrame = globalThis.cancelAnimationFrame?.bind(globalThis),
  ResizeObserverImpl = globalThis.ResizeObserver,
  now = () => globalThis.performance?.now?.() ?? Date.now(),
  interpolationMs = POSE_DISPLAY_INTERPOLATION_MS,
}) {
  if (!canvas || typeof draw !== "function") {
    throw new TypeError("pose canvas runtime requires a canvas and draw function");
  }
  if (typeof requestFrame !== "function" || typeof cancelFrame !== "function") {
    throw new TypeError("pose canvas runtime requires requestAnimationFrame");
  }

  let disposed = false;
  /** @type {any | null} */
  let renderedPose = null;
  let animationFrame = 0;

  function cancelAnimation() {
    if (animationFrame) cancelFrame(animationFrame);
    animationFrame = 0;
  }

  function redraw() {
    if (!disposed) draw(canvas, renderedPose);
  }

  const observer = typeof ResizeObserverImpl === "function"
    ? new ResizeObserverImpl(redraw)
    : null;
  observer?.observe(canvas);

  return Object.freeze({
    /** @param {any | null} frame */
    render(frame) {
      if (disposed) return false;
      cancelAnimation();
      if (!frame) {
        renderedPose = null;
        redraw();
        return true;
      }
      const previous = renderedPose;
      if (!previous || interpolationMs <= 0) {
        renderedPose = frame;
        redraw();
        return true;
      }

      const startedAt = now();
      /** @param {number} timestamp */
      const animate = (timestamp) => {
        if (disposed) return;
        const progress = Math.min(
          Math.max((timestamp - startedAt) / interpolationMs, 0),
          1,
        );
        renderedPose = interpolatePoseFrame(previous, frame, progress);
        redraw();
        animationFrame = progress < 1 ? requestFrame(animate) : 0;
      };
      animationFrame = requestFrame(animate);
      return true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimation();
      observer?.disconnect();
      renderedPose = null;
      draw(canvas, null);
    },
    snapshot() {
      return Object.freeze({ disposed, renderedPose, animationPending: animationFrame !== 0 });
    },
  });
}
