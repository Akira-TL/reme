import * as THREE from "three";
import { OrbitControls } from "/vendor/OrbitControls.js";

const video = document.querySelector("#source-video");
const canvas = document.querySelector("#pose-canvas");
const sceneWrap = document.querySelector("#scene-wrap");
const loading = document.querySelector("#loading");
const playToggle = document.querySelector("#play-toggle");
const timeline = document.querySelector("#timeline");
const timeText = document.querySelector("#time-text");
const frameText = document.querySelector("#frame-text");
const speedSelect = document.querySelector("#speed");
const gridToggle = document.querySelector("#grid-toggle");
const roomToggle = document.querySelector("#room-toggle");
const rotateToggle = document.querySelector("#rotate-toggle");
const poseStatus = document.querySelector("#pose-status");
const runtimeBadge = document.querySelector("#runtime-badge");
const metricFrame = document.querySelector("#metric-frame");
const metricScore = document.querySelector("#metric-score");
const metricDevice = document.querySelector("#metric-device");

const LEFT = new Set([4, 5, 6, 11, 12, 13]);
const RIGHT = new Set([1, 2, 3, 14, 15, 16]);
const CENTER_COLOR = 0x8fe9b9;
const LEFT_COLOR = 0x68d6ff;
const RIGHT_COLOR = 0xf2b85d;

let poseData = null;
let currentFrame = -1;
let skeletonGroup = null;
let joints = [];
let bones = [];

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x041017, 0.055);

const camera = new THREE.PerspectiveCamera(42, 16 / 9, 0.05, 100);
camera.position.set(3.3, 2.35, 4.5);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.07;
controls.target.set(0, 0.95, 0);
controls.minDistance = 2.2;
controls.maxDistance = 9;
controls.maxPolarAngle = Math.PI * 0.96;
controls.update();

scene.add(new THREE.HemisphereLight(0xc9f7ff, 0x061014, 2.2));
const keyLight = new THREE.DirectionalLight(0xffffff, 3.4);
keyLight.position.set(3, 5, 4);
scene.add(keyLight);
const rimLight = new THREE.DirectionalLight(0x5de4ef, 2.1);
rimLight.position.set(-4, 2, -3);
scene.add(rimLight);

const floorMaterial = new THREE.MeshStandardMaterial({
  color: 0x0b2028,
  roughness: 0.9,
  metalness: 0.05,
  transparent: true,
  opacity: 0.75,
});
const floor = new THREE.Mesh(new THREE.PlaneGeometry(8, 8), floorMaterial);
floor.rotation.x = -Math.PI / 2;
floor.position.y = -0.012;
scene.add(floor);

const grid = new THREE.GridHelper(8, 24, 0x5de4ef, 0x173844);
grid.material.transparent = true;
grid.material.opacity = 0.34;
scene.add(grid);

const room = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.BoxGeometry(5.4, 2.8, 5.4)),
  new THREE.LineBasicMaterial({ color: 0x5de4ef, transparent: true, opacity: 0.14 }),
);
room.position.y = 1.4;
scene.add(room);

const axis = new THREE.AxesHelper(0.65);
axis.position.set(-2.35, 0.015, 2.35);
scene.add(axis);

function jointColor(index) {
  if (LEFT.has(index)) return LEFT_COLOR;
  if (RIGHT.has(index)) return RIGHT_COLOR;
  return CENTER_COLOR;
}

function createSkeleton() {
  skeletonGroup = new THREE.Group();
  scene.add(skeletonGroup);

  const sphereGeometry = new THREE.SphereGeometry(0.055, 18, 12);
  joints = poseData.joint_names.map((_, index) => {
    const material = new THREE.MeshStandardMaterial({
      color: jointColor(index),
      emissive: jointColor(index),
      emissiveIntensity: 0.18,
      roughness: 0.36,
      metalness: 0.08,
      transparent: true,
    });
    const mesh = new THREE.Mesh(sphereGeometry, material);
    skeletonGroup.add(mesh);
    return mesh;
  });

  const cylinderGeometry = new THREE.CylinderGeometry(0.028, 0.028, 1, 10, 1, false);
  bones = poseData.edges.map(([start, end]) => {
    const material = new THREE.MeshStandardMaterial({
      color: jointColor(start === 0 || start === 7 || start === 8 ? start : end),
      emissive: jointColor(end),
      emissiveIntensity: 0.11,
      roughness: 0.42,
      metalness: 0.04,
      transparent: true,
    });
    const mesh = new THREE.Mesh(cylinderGeometry, material);
    skeletonGroup.add(mesh);
    return { start, end, mesh };
  });
}

const up = new THREE.Vector3(0, 1, 0);
const startVector = new THREE.Vector3();
const endVector = new THREE.Vector3();
const middleVector = new THREE.Vector3();
const directionVector = new THREE.Vector3();

function updateSkeleton(frameIndex) {
  if (!poseData || frameIndex === currentFrame) return;
  currentFrame = frameIndex;
  const frame = poseData.frames[frameIndex];
  const scores = poseData.scores?.[frameIndex] || [];

  frame.forEach((point, index) => {
    const mesh = joints[index];
    mesh.position.set(point[0], point[1], point[2]);
    const score = scores[index] ?? 1;
    mesh.material.opacity = THREE.MathUtils.clamp(0.32 + score, 0.35, 1);
    mesh.scale.setScalar(0.85 + score * 0.22);
  });

  bones.forEach(({ start, end, mesh }) => {
    startVector.set(...frame[start]);
    endVector.set(...frame[end]);
    directionVector.subVectors(endVector, startVector);
    const length = directionVector.length();
    middleVector.addVectors(startVector, endVector).multiplyScalar(0.5);
    mesh.position.copy(middleVector);
    mesh.scale.set(1, Math.max(length, 0.0001), 1);
    mesh.quaternion.setFromUnitVectors(up, directionVector.normalize());
    const score = Math.min(scores[start] ?? 1, scores[end] ?? 1);
    mesh.material.opacity = THREE.MathUtils.clamp(0.24 + score, 0.3, 1);
  });

  const meanScore = scores.length
    ? scores.reduce((sum, score) => sum + score, 0) / scores.length
    : 1;
  frameText.textContent = `Frame ${frameIndex + 1} / ${poseData.video.frame_count}`;
  metricFrame.textContent = `${frameIndex + 1} / ${poseData.video.frame_count}`;
  metricScore.textContent = meanScore.toFixed(3);
}

function formatTime(seconds) {
  const safe = Number.isFinite(seconds) ? Math.max(seconds, 0) : 0;
  const minutes = Math.floor(safe / 60);
  const secs = Math.floor(safe % 60);
  const millis = Math.floor((safe - Math.floor(safe)) * 1000);
  return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

function updateTransport() {
  if (!poseData) return;
  const duration = Number.isFinite(video.duration)
    ? video.duration
    : poseData.video.duration_seconds;
  const frame = Math.min(
    poseData.video.frame_count - 1,
    Math.max(0, Math.round(video.currentTime * poseData.video.fps)),
  );
  updateSkeleton(frame);
  timeline.value = duration > 0 ? String(Math.round((video.currentTime / duration) * 1000)) : "0";
  timeText.textContent = `${formatTime(video.currentTime)} / ${formatTime(duration)}`;
  playToggle.textContent = video.paused ? "播放" : "暂停";
}

function resize() {
  const width = Math.max(sceneWrap.clientWidth, 1);
  const height = Math.max(sceneWrap.clientHeight, 1);
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}

function setView(view) {
  if (view === "front") camera.position.set(0, 1.65, 4.8);
  else if (view === "side") camera.position.set(4.8, 1.65, 0);
  else if (view === "top") camera.position.set(0.05, 6.2, 0.05);
  else camera.position.set(3.3, 2.35, 4.5);
  controls.target.set(0, 0.95, 0);
  controls.update();
}

async function boot() {
  const [metaResponse, poseResponse] = await Promise.all([
    fetch("/api/meta", { cache: "no-store" }),
    fetch("/api/poses", { cache: "no-store" }),
  ]);
  if (!metaResponse.ok || !poseResponse.ok) {
    throw new Error(`数据载入失败：meta=${metaResponse.status}, poses=${poseResponse.status}`);
  }
  const metadata = await metaResponse.json();
  poseData = await poseResponse.json();
  createSkeleton();
  updateSkeleton(0);

  runtimeBadge.textContent = `${metadata.runtime?.device || "CUDA"} · ${metadata.runtime?.effective_output_fps || "—"} FPS`;
  poseStatus.innerHTML = `<i></i> ${poseData.video.frame_count} 帧已载入`;
  metricDevice.textContent = metadata.runtime?.device || "—";
  document.querySelector("#app").setAttribute("aria-busy", "false");
  loading.classList.add("hidden");
  resize();
}

playToggle.addEventListener("click", async () => {
  if (video.paused) await video.play();
  else video.pause();
});

timeline.addEventListener("input", () => {
  const duration = Number.isFinite(video.duration)
    ? video.duration
    : poseData?.video.duration_seconds || 0;
  video.currentTime = (Number(timeline.value) / 1000) * duration;
  updateTransport();
});

speedSelect.addEventListener("change", () => {
  video.playbackRate = Number(speedSelect.value);
});

gridToggle.addEventListener("change", () => {
  grid.visible = gridToggle.checked;
  floor.visible = gridToggle.checked;
  axis.visible = gridToggle.checked;
});
roomToggle.addEventListener("change", () => { room.visible = roomToggle.checked; });
rotateToggle.addEventListener("change", () => { controls.autoRotate = rotateToggle.checked; });

document.querySelectorAll("[data-view]").forEach((button) => {
  button.addEventListener("click", () => setView(button.dataset.view));
});

video.addEventListener("loadedmetadata", updateTransport);
video.addEventListener("play", updateTransport);
video.addEventListener("pause", updateTransport);
video.addEventListener("seeked", updateTransport);
video.addEventListener("ratechange", updateTransport);

window.addEventListener("keydown", async (event) => {
  if (event.target.matches("input, select, button")) return;
  if (event.code === "Space") {
    event.preventDefault();
    if (video.paused) await video.play();
    else video.pause();
  } else if (event.code === "ArrowLeft") {
    video.currentTime = Math.max(0, video.currentTime - 2);
  } else if (event.code === "ArrowRight") {
    video.currentTime = Math.min(video.duration || Infinity, video.currentTime + 2);
  }
});

new ResizeObserver(resize).observe(sceneWrap);

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  updateTransport();
  renderer.render(scene, camera);
}

boot().catch((error) => {
  console.error(error);
  loading.querySelector("strong").textContent = "Demo 载入失败";
  loading.querySelector("span").textContent = error.message;
  poseStatus.textContent = "载入失败";
});
animate();
