export const SOURCE_INDEXES = [0, 2, 5, 7, 8, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];

export const CONNECTIONS = [
  [0, 1], [0, 2], [1, 3], [2, 4],
  [5, 6], [5, 7], [7, 9], [6, 8], [8, 10],
  [5, 11], [6, 12], [11, 12],
  [11, 13], [13, 15], [12, 14], [14, 16],
];

export function mapLandmarks(source) {
  return SOURCE_INDEXES.map((sourceIndex) => {
    const point = source[sourceIndex];
    return {
      x: Number(point.x || 0),
      y: Number(point.y || 0),
      score: Number(point.visibility ?? 1),
    };
  });
}

export function createDemoLandmarks(now) {
  const t = now / 1000;
  const sway = Math.sin(t * 1.4) * 0.018;
  const wave = Math.sin(t * 2) * 0.045;
  return [
    [0.50 + sway, 0.22], [0.485 + sway, 0.21], [0.515 + sway, 0.21], [0.47 + sway, 0.22], [0.53 + sway, 0.22],
    [0.42 + sway, 0.35], [0.58 + sway, 0.35], [0.37 + sway, 0.49], [0.63 + sway, 0.47 - wave],
    [0.34 + sway, 0.63], [0.70 + sway, 0.39 - wave], [0.45 + sway, 0.58], [0.55 + sway, 0.58],
    [0.44 + sway, 0.75], [0.56 + sway, 0.75], [0.43 + sway, 0.91], [0.58 + sway, 0.91],
  ].map(([x, y]) => ({ x, y, score: 0.99 }));
}

export function resizeCanvas(canvas) {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const pixelWidth = Math.max(1, Math.round(rect.width * dpr));
  const pixelHeight = Math.max(1, Math.round(rect.height * dpr));

  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }

  const context = canvas.getContext("2d");
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { context, width: rect.width, height: rect.height };
}

export function drawSkeleton(context, points, width, height, video, color = "#ff5a00") {
  if (points.length !== 17) return;

  const videoWidth = video?.videoWidth || 1280;
  const videoHeight = video?.videoHeight || 720;
  const scale = Math.max(width / videoWidth, height / videoHeight);
  const drawWidth = videoWidth * scale;
  const drawHeight = videoHeight * scale;
  const offsetX = (width - drawWidth) / 2;
  const offsetY = (height - drawHeight) / 2;
  const mapped = points.map((point) => ({
    x: (1 - point.x) * drawWidth + offsetX,
    y: point.y * drawHeight + offsetY,
    score: point.score,
  }));

  context.save();
  context.lineCap = "round";
  context.lineJoin = "round";
  context.shadowColor = color;
  context.shadowBlur = 10;

  CONNECTIONS.forEach(([aIndex, bIndex]) => {
    const a = mapped[aIndex];
    const b = mapped[bIndex];
    if (!a || !b || a.score < 0.35 || b.score < 0.35) return;
    context.beginPath();
    context.moveTo(a.x, a.y);
    context.lineTo(b.x, b.y);
    context.strokeStyle = color;
    context.lineWidth = Math.max(2.6, width / 115);
    context.stroke();
  });

  const shoulderWidth = Math.abs(mapped[5].x - mapped[6].x);
  const headRadius = Math.max(11, Math.min(25, shoulderWidth * 0.25));
  context.beginPath();
  context.arc(mapped[0].x, mapped[0].y - headRadius * 0.18, headRadius, 0, Math.PI * 2);
  context.strokeStyle = color;
  context.lineWidth = Math.max(2.6, width / 130);
  context.stroke();

  mapped.forEach((point) => {
    if (point.score < 0.35) return;
    const radius = Math.max(3.3, width / 110);
    context.beginPath();
    context.arc(point.x, point.y, radius, 0, Math.PI * 2);
    context.fillStyle = color;
    context.fill();
    context.shadowBlur = 0;
    context.beginPath();
    context.arc(point.x, point.y, radius * 0.55, 0, Math.PI * 2);
    context.fillStyle = "#fff";
    context.fill();
    context.shadowBlur = 10;
  });
  context.restore();
}
