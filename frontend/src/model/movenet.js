import { KEYPOINT_SCORE_THRESHOLD } from "../shared-demo/protocol.js";

const DEFAULT_MODEL_URL = "/weights/movenet_lightning_f16_v4-0fac2226.tflite";
const DEFAULT_WASM_URL = "/litert/wasm/";

const EXPECTED_INPUT = Object.freeze({
  shape: Object.freeze([1, 192, 192, 3]),
  dtype: "uint8",
});
const EXPECTED_OUTPUT = Object.freeze({
  shape: Object.freeze([1, 1, 17, 3]),
  dtype: "float32",
});

export const MOVENET_KEYPOINT_NAMES = Object.freeze([
  "nose",
  "left_eye",
  "right_eye",
  "left_ear",
  "right_ear",
  "left_shoulder",
  "right_shoulder",
  "left_elbow",
  "right_elbow",
  "left_wrist",
  "right_wrist",
  "left_hip",
  "right_hip",
  "left_knee",
  "right_knee",
  "left_ankle",
  "right_ankle",
]);

const CORE_KEYPOINT_NAMES = new Set([
  "left_shoulder",
  "right_shoulder",
  "left_hip",
  "right_hip",
  "left_knee",
  "right_knee",
  "left_ankle",
  "right_ankle",
]);
const TORSO_SHOULDERS = Object.freeze([5, 6]);
const TORSO_HIPS = Object.freeze([11, 12]);

export class MoveNetBrowserError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "MoveNetBrowserError";
  }
}

function assertPositiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new MoveNetBrowserError(`${label} must be a positive integer`);
  }
}

function assertScoreThreshold(value) {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new MoveNetBrowserError("scoreThreshold must be between 0 and 1");
  }
}

function shapeArray(shape) {
  return Array.from(shape ?? [], Number);
}

function sameShape(actual, expected) {
  return actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}

function describeTensor(detail) {
  return `${detail?.dtype ?? "unknown"} [${shapeArray(detail?.shape).join(",")}]`;
}

/**
 * Validate the exact tensor contract measured for the team-exported model.
 * This is kept pure so a Node test can reject a wrong public asset without
 * pretending that browser inference performance has been measured.
 */
export function validateMoveNetModelIO(inputDetails, outputDetails) {
  if (!Array.isArray(inputDetails) || inputDetails.length !== 1) {
    throw new MoveNetBrowserError("MoveNet model must expose exactly one input tensor");
  }
  if (!Array.isArray(outputDetails) || outputDetails.length !== 1) {
    throw new MoveNetBrowserError("MoveNet model must expose exactly one output tensor");
  }

  const input = inputDetails[0];
  const output = outputDetails[0];
  const inputShape = shapeArray(input?.shape);
  const outputShape = shapeArray(output?.shape);
  if (input?.dtype !== EXPECTED_INPUT.dtype || !sameShape(inputShape, EXPECTED_INPUT.shape)) {
    throw new MoveNetBrowserError(
      `unexpected MoveNet input tensor: ${describeTensor(input)}; expected uint8 [1,192,192,3]`,
    );
  }
  if (output?.dtype !== EXPECTED_OUTPUT.dtype || !sameShape(outputShape, EXPECTED_OUTPUT.shape)) {
    throw new MoveNetBrowserError(
      `unexpected MoveNet output tensor: ${describeTensor(output)}; expected float32 [1,1,17,3]`,
    );
  }

  return Object.freeze({
    input: Object.freeze({
      name: String(input.name ?? ""),
      dtype: input.dtype,
      shape: Object.freeze(inputShape),
    }),
    output: Object.freeze({
      name: String(output.name ?? ""),
      dtype: output.dtype,
      shape: Object.freeze(outputShape),
    }),
  });
}

/** Match Python's round() for crop boundaries, including half-to-even ties. */
export function roundHalfToEven(value) {
  if (!Number.isFinite(value)) {
    throw new MoveNetBrowserError("crop boundary must be finite");
  }
  const lower = Math.floor(value);
  const fraction = value - lower;
  if (Math.abs(fraction - 0.5) <= Number.EPSILON * Math.max(1, Math.abs(value))) {
    return lower % 2 === 0 ? lower : lower + 1;
  }
  return Math.round(value);
}

/** Port of backend/reme/pose/movenet.py::initial_crop_region. */
export function initialCropRegion(frameHeight, frameWidth) {
  assertPositiveInteger(frameHeight, "frameHeight");
  assertPositiveInteger(frameWidth, "frameWidth");
  if (frameWidth > frameHeight) {
    const cropHeight = frameWidth / frameHeight;
    const yMin = (frameHeight / 2 - frameWidth / 2) / frameHeight;
    return {
      y_min: yMin,
      x_min: 0,
      y_max: yMin + cropHeight,
      x_max: 1,
    };
  }

  const cropWidth = frameHeight / frameWidth;
  const xMin = (frameWidth / 2 - frameHeight / 2) / frameWidth;
  return {
    y_min: 0,
    x_min: xMin,
    y_max: 1,
    x_max: xMin + cropWidth,
  };
}

function validateCropRegion(cropRegion) {
  if (!cropRegion || typeof cropRegion !== "object") {
    throw new MoveNetBrowserError("cropRegion must be an object");
  }
  for (const key of ["y_min", "x_min", "y_max", "x_max"]) {
    if (!Number.isFinite(cropRegion[key])) {
      throw new MoveNetBrowserError(`cropRegion.${key} must be finite`);
    }
  }
  if (cropRegion.y_max <= cropRegion.y_min || cropRegion.x_max <= cropRegion.x_min) {
    throw new MoveNetBrowserError("cropRegion must have a positive size");
  }
  return cropRegion;
}

/**
 * Resolve the integer crop/padding plan used before canvas resize. Exported for
 * deterministic Node verification; the returned source rectangle is clipped
 * to the source frame while the destination retains black padding.
 */
export function createCropPixelPlan(cropRegion, frameHeight, frameWidth) {
  validateCropRegion(cropRegion);
  assertPositiveInteger(frameHeight, "frameHeight");
  assertPositiveInteger(frameWidth, "frameWidth");

  const yMinPx = roundHalfToEven(cropRegion.y_min * frameHeight);
  const xMinPx = roundHalfToEven(cropRegion.x_min * frameWidth);
  const yMaxPx = roundHalfToEven(cropRegion.y_max * frameHeight);
  const xMaxPx = roundHalfToEven(cropRegion.x_max * frameWidth);
  const cropHeight = Math.max(1, yMaxPx - yMinPx);
  const cropWidth = Math.max(1, xMaxPx - xMinPx);
  const srcY0 = Math.max(0, yMinPx);
  const srcX0 = Math.max(0, xMinPx);
  const srcY1 = Math.min(frameHeight, yMaxPx);
  const srcX1 = Math.min(frameWidth, xMaxPx);

  return Object.freeze({
    y_min_px: yMinPx,
    x_min_px: xMinPx,
    y_max_px: yMaxPx,
    x_max_px: xMaxPx,
    crop_height: cropHeight,
    crop_width: cropWidth,
    src_y: srcY0,
    src_x: srcX0,
    src_height: Math.max(0, srcY1 - srcY0),
    src_width: Math.max(0, srcX1 - srcX0),
    dst_y: srcY0 - yMinPx,
    dst_x: srcX0 - xMinPx,
  });
}

function validateDecodedKeypoints(keypoints) {
  if (!Array.isArray(keypoints) || keypoints.length !== MOVENET_KEYPOINT_NAMES.length) {
    throw new MoveNetBrowserError("MoveNet keypoints must contain the ordered 17 points");
  }
  keypoints.forEach((keypoint, index) => {
    if (!keypoint || keypoint.name !== MOVENET_KEYPOINT_NAMES[index]) {
      throw new MoveNetBrowserError("MoveNet keypoints are not in canonical order");
    }
    for (const field of ["x_norm", "y_norm", "score"]) {
      if (!Number.isFinite(keypoint[field])) {
        throw new MoveNetBrowserError(`keypoints[${index}].${field} must be finite`);
      }
    }
    if (keypoint.x_norm < 0 || keypoint.x_norm > 1
      || keypoint.y_norm < 0 || keypoint.y_norm > 1
      || keypoint.score < 0 || keypoint.score > 1) {
      throw new MoveNetBrowserError(`keypoints[${index}] must be normalized between 0 and 1`);
    }
  });
  return keypoints;
}

/** Decode [y, x, score] crop coordinates back into normalized full-frame coordinates. */
export function decodeMoveNetOutput(rawOutput, cropRegion) {
  validateCropRegion(cropRegion);
  if (!rawOutput || typeof rawOutput.length !== "number") {
    throw new MoveNetBrowserError("MoveNet output must be an array-like value");
  }
  const expectedValues = MOVENET_KEYPOINT_NAMES.length * 3;
  if (rawOutput.length !== expectedValues) {
    throw new MoveNetBrowserError(
      `unexpected MoveNet output length: ${rawOutput.length}; expected ${expectedValues}`,
    );
  }

  const cropHeight = cropRegion.y_max - cropRegion.y_min;
  const cropWidth = cropRegion.x_max - cropRegion.x_min;
  const keypoints = MOVENET_KEYPOINT_NAMES.map((name, index) => {
    const y = Number(rawOutput[index * 3]);
    const x = Number(rawOutput[index * 3 + 1]);
    const score = Number(rawOutput[index * 3 + 2]);
    if (![y, x, score].every(Number.isFinite)) {
      throw new MoveNetBrowserError(`MoveNet output keypoint ${index} contains a non-finite value`);
    }
    if (score < 0 || score > 1) {
      throw new MoveNetBrowserError(`MoveNet output score ${index} must be between 0 and 1`);
    }
    return Object.freeze({
      name,
      x_norm: Math.min(1, Math.max(0, cropRegion.x_min + x * cropWidth)),
      y_norm: Math.min(1, Math.max(0, cropRegion.y_min + y * cropHeight)),
      score,
    });
  });
  return Object.freeze(keypoints);
}

/** Port of the Python adapter's torso visibility rule. */
export function torsoDetected(keypoints, scoreThreshold = KEYPOINT_SCORE_THRESHOLD) {
  validateDecodedKeypoints(keypoints);
  assertScoreThreshold(scoreThreshold);
  const shoulderVisible = TORSO_SHOULDERS.some(
    (index) => keypoints[index].score >= scoreThreshold,
  );
  const hipVisible = TORSO_HIPS.some(
    (index) => keypoints[index].score >= scoreThreshold,
  );
  return shoulderVisible && hipVisible;
}

/** Port of the Python adapter's usable/degraded/unavailable quality contract. */
export function deriveLandmarkQuality(
  keypoints,
  personDetected,
  scoreThreshold = KEYPOINT_SCORE_THRESHOLD,
) {
  validateDecodedKeypoints(keypoints);
  assertScoreThreshold(scoreThreshold);
  if (!personDetected) return "unavailable";
  const scores = new Map(keypoints.map((keypoint) => [keypoint.name, keypoint.score]));
  return [...CORE_KEYPOINT_NAMES].every((name) => scores.get(name) >= scoreThreshold)
    ? "usable"
    : "degraded";
}

/** Port of backend/reme/pose/movenet.py::determine_next_crop_region. */
export function determineNextCropRegion(
  keypoints,
  frameHeight,
  frameWidth,
  scoreThreshold = KEYPOINT_SCORE_THRESHOLD,
) {
  validateDecodedKeypoints(keypoints);
  assertPositiveInteger(frameHeight, "frameHeight");
  assertPositiveInteger(frameWidth, "frameWidth");
  assertScoreThreshold(scoreThreshold);

  const shouldersVisible = TORSO_SHOULDERS.every(
    (index) => keypoints[index].score >= scoreThreshold,
  );
  const hipsVisible = TORSO_HIPS.every(
    (index) => keypoints[index].score >= scoreThreshold,
  );
  if (!shouldersVisible && !hipsVisible) {
    return initialCropRegion(frameHeight, frameWidth);
  }

  const centerY = (keypoints[11].y_norm + keypoints[12].y_norm) * 0.5 * frameHeight;
  const centerX = (keypoints[11].x_norm + keypoints[12].x_norm) * 0.5 * frameWidth;
  let torsoXRange = 0;
  let torsoYRange = 0;
  for (const index of [...TORSO_SHOULDERS, ...TORSO_HIPS]) {
    torsoXRange = Math.max(
      torsoXRange,
      Math.abs(keypoints[index].x_norm * frameWidth - centerX),
    );
    torsoYRange = Math.max(
      torsoYRange,
      Math.abs(keypoints[index].y_norm * frameHeight - centerY),
    );
  }

  let bodyXRange = 0;
  let bodyYRange = 0;
  for (const keypoint of keypoints) {
    if (keypoint.score < scoreThreshold) continue;
    bodyXRange = Math.max(
      bodyXRange,
      Math.abs(keypoint.x_norm * frameWidth - centerX),
    );
    bodyYRange = Math.max(
      bodyYRange,
      Math.abs(keypoint.y_norm * frameHeight - centerY),
    );
  }

  let cropHalf = Math.max(
    torsoXRange * 1.9,
    torsoYRange * 1.9,
    bodyXRange * 1.2,
    bodyYRange * 1.2,
  );
  cropHalf = Math.min(
    cropHalf,
    Math.max(
      centerX,
      frameWidth - centerX,
      centerY,
      frameHeight - centerY,
    ),
  );
  const cropLength = cropHalf * 2;
  if (cropLength <= 1 || cropLength > Math.max(frameWidth, frameHeight)) {
    return initialCropRegion(frameHeight, frameWidth);
  }

  return {
    y_min: (centerY - cropHalf) / frameHeight,
    x_min: (centerX - cropHalf) / frameWidth,
    y_max: (centerY + cropHalf) / frameHeight,
    x_max: (centerX + cropHalf) / frameWidth,
  };
}

function getSourceDimensions(source) {
  if (!source || typeof source !== "object") {
    throw new MoveNetBrowserError("infer(source) requires a browser image source");
  }
  const width = Number(
    source.videoWidth
      ?? source.naturalWidth
      ?? source.displayWidth
      ?? source.width,
  );
  const height = Number(
    source.videoHeight
      ?? source.naturalHeight
      ?? source.displayHeight
      ?? source.height,
  );
  assertPositiveInteger(width, "source width");
  assertPositiveInteger(height, "source height");
  return { width, height };
}

function createCanvas(width, height) {
  let canvas;
  if (typeof OffscreenCanvas !== "undefined") {
    canvas = new OffscreenCanvas(width, height);
  } else if (typeof document !== "undefined") {
    canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
  } else {
    throw new MoveNetBrowserError("Canvas is unavailable in this runtime");
  }
  return canvas;
}

function resizeCanvas(canvas, width, height) {
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
}

function get2dContext(canvas) {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new MoveNetBrowserError("Canvas 2D context is unavailable");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "low";
  return context;
}

function prepareRgbInput(source, cropRegion, frameHeight, frameWidth, canvases) {
  const plan = createCropPixelPlan(cropRegion, frameHeight, frameWidth);
  resizeCanvas(canvases.crop, plan.crop_width, plan.crop_height);
  const cropContext = get2dContext(canvases.crop);
  cropContext.fillStyle = "#000";
  cropContext.fillRect(0, 0, plan.crop_width, plan.crop_height);
  if (plan.src_width > 0 && plan.src_height > 0) {
    try {
      cropContext.drawImage(
        source,
        plan.src_x,
        plan.src_y,
        plan.src_width,
        plan.src_height,
        plan.dst_x,
        plan.dst_y,
        plan.src_width,
        plan.src_height,
      );
    } catch (error) {
      throw new MoveNetBrowserError("source cannot be drawn into an RGB canvas", { cause: error });
    }
  }

  resizeCanvas(canvases.input, EXPECTED_INPUT.shape[2], EXPECTED_INPUT.shape[1]);
  const inputContext = get2dContext(canvases.input);
  inputContext.fillStyle = "#000";
  inputContext.fillRect(0, 0, EXPECTED_INPUT.shape[2], EXPECTED_INPUT.shape[1]);
  inputContext.drawImage(
    canvases.crop,
    0,
    0,
    plan.crop_width,
    plan.crop_height,
    0,
    0,
    EXPECTED_INPUT.shape[2],
    EXPECTED_INPUT.shape[1],
  );
  const rgba = inputContext.getImageData(
    0,
    0,
    EXPECTED_INPUT.shape[2],
    EXPECTED_INPUT.shape[1],
  ).data;
  const rgb = new Uint8Array(EXPECTED_INPUT.shape[1] * EXPECTED_INPUT.shape[2] * 3);
  for (let rgbaIndex = 0, rgbIndex = 0; rgbaIndex < rgba.length; rgbaIndex += 4) {
    rgb[rgbIndex] = rgba[rgbaIndex];
    rgb[rgbIndex + 1] = rgba[rgbaIndex + 1];
    rgb[rgbIndex + 2] = rgba[rgbaIndex + 2];
    rgbIndex += 3;
  }
  return rgb;
}

function monotonicNow() {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

async function ensureLiteRtLoaded(liteRt, wasmUrl) {
  const existing = liteRt.getGlobalLiteRtPromise?.();
  if (existing) {
    await existing;
    return;
  }
  await liteRt.loadLiteRt(wasmUrl);
}

/**
 * Load the team-exported MoveNet model in LiteRT.js and create a stateful,
 * video-style tracking estimator. The package is intentionally imported only
 * after the monitor user starts the camera, keeping it off the viewer path.
 */
export async function createMoveNetBrowserEstimator({
  modelUrl = DEFAULT_MODEL_URL,
  wasmUrl = DEFAULT_WASM_URL,
  accelerator = "wasm",
  scoreThreshold = KEYPOINT_SCORE_THRESHOLD,
} = {}) {
  if ((typeof modelUrl !== "string" && !(modelUrl instanceof URL)) || String(modelUrl).length === 0) {
    throw new MoveNetBrowserError("modelUrl must be a non-empty URL");
  }
  if (typeof wasmUrl !== "string" || wasmUrl.length === 0) {
    throw new MoveNetBrowserError("wasmUrl must be a non-empty directory URL");
  }
  if (!wasmUrl.endsWith("/")) {
    throw new MoveNetBrowserError("wasmUrl must be a directory URL ending in /");
  }
  if (!new Set(["wasm", "webgpu"]).has(accelerator)) {
    throw new MoveNetBrowserError("accelerator must be wasm or webgpu");
  }
  assertScoreThreshold(scoreThreshold);

  let liteRt;
  let model;
  try {
    liteRt = await import("@litertjs/core");
    await ensureLiteRtLoaded(liteRt, wasmUrl);
    model = await liteRt.loadAndCompile(modelUrl, { accelerator });
  } catch (error) {
    throw new MoveNetBrowserError("failed to load or compile the MoveNet browser model", {
      cause: error,
    });
  }

  let tensorContract;
  try {
    tensorContract = validateMoveNetModelIO(
      Array.from(model.getInputDetails()),
      Array.from(model.getOutputDetails()),
    );
  } catch (error) {
    model.delete();
    throw error;
  }

  const details = Object.freeze({
    modelUrl: String(modelUrl),
    wasmUrl,
    accelerator,
    scoreThreshold,
    input: tensorContract.input,
    output: tensorContract.output,
  });
  const canvases = {
    crop: createCanvas(1, 1),
    input: createCanvas(EXPECTED_INPUT.shape[2], EXPECTED_INPUT.shape[1]),
  };
  let cropRegion = null;
  let lastFrameSize = null;
  let closed = false;
  let inferenceQueue = Promise.resolve();
  let disposal = null;

  async function inferOne(source) {
    const { width, height } = getSourceDimensions(source);
    if (!lastFrameSize || lastFrameSize.width !== width || lastFrameSize.height !== height) {
      cropRegion = initialCropRegion(height, width);
      lastFrameSize = { width, height };
    }
    const activeCrop = cropRegion;
    const rgb = prepareRgbInput(source, activeCrop, height, width, canvases);
    const inputTensor = new liteRt.Tensor(rgb, EXPECTED_INPUT.shape);
    let outputs = [];
    let inferenceMs;
    try {
      const started = monotonicNow();
      outputs = await model.run(inputTensor);
      inferenceMs = monotonicNow() - started;
      if (!Array.isArray(outputs) || outputs.length !== 1) {
        throw new MoveNetBrowserError("MoveNet runtime returned an unexpected output collection");
      }
      const rawOutput = await outputs[0].data();
      const keypoints = decodeMoveNetOutput(rawOutput, activeCrop);
      cropRegion = determineNextCropRegion(keypoints, height, width, scoreThreshold);
      const personDetected = torsoDetected(keypoints, scoreThreshold);
      const landmarkQuality = deriveLandmarkQuality(
        keypoints,
        personDetected,
        scoreThreshold,
      );
      return Object.freeze({
        schema_version: "movenet-17/v0-experiment",
        keypoints,
        person_detected: personDetected,
        torso_detected: personDetected,
        landmark_quality: landmarkQuality,
        inference_ms: inferenceMs,
      });
    } catch (error) {
      if (error instanceof MoveNetBrowserError) throw error;
      throw new MoveNetBrowserError("MoveNet browser inference failed", { cause: error });
    } finally {
      inputTensor.delete();
      for (const output of outputs) output?.delete?.();
    }
  }

  return Object.freeze({
    details,
    infer(source) {
      if (closed) {
        return Promise.reject(new MoveNetBrowserError("MoveNet estimator is disposed"));
      }
      const inference = inferenceQueue.then(() => inferOne(source));
      inferenceQueue = inference.catch(() => undefined);
      return inference;
    },
    dispose() {
      if (disposal) return disposal;
      closed = true;
      disposal = inferenceQueue.then(() => {
        model.delete();
      });
      return disposal;
    },
  });
}
