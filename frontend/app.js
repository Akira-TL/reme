const MP_BUNDLE_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/vision_bundle.mjs";
const MP_WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm";
const POSE_MODEL_URL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";

const SOURCE_INDEXES = [0, 2, 5, 7, 8, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];
const CONNECTIONS = [
  [0, 1], [0, 2], [1, 3], [2, 4],
  [5, 6], [5, 7], [7, 9], [6, 8], [8, 10],
  [5, 11], [6, 12], [11, 12],
  [11, 13], [13, 15], [12, 14], [14, 16]
];

const SCENES = {
  normal: {
    name: "客厅守护",
    detail: "真实摄像头实时转为 17 节点火柴人",
    icon: "⌂",
    image: "./assets/home-normal.png",
    camera: true
  },
  cooking: {
    name: "做饭片段",
    detail: "正常生活画面，经本人授权后可分享",
    icon: "♨",
    image: "./assets/home-cooking.png",
    camera: false
  },
  privacy: {
    name: "洗澡隐私",
    detail: "敏感场景自动隐藏真人，只显示火柴人",
    icon: "♢",
    image: "./assets/home-privacy.png",
    camera: false
  },
  risk: {
    name: "异常姿态",
    detail: "低位停留触发中风险与子女紧急提醒",
    icon: "!",
    image: "./assets/home-risk.png",
    camera: false
  }
};

const elements = {
  screens: {
    home: document.getElementById("homeScreen"),
    dashboard: document.getElementById("dashboardScreen"),
    settings: document.getElementById("settingsScreen")
  },
  homeArt: document.getElementById("homeArt"),
  cameraStage: document.getElementById("cameraStage"),
  video: document.getElementById("cameraVideo"),
  canvas: document.getElementById("poseCanvas"),
  connection: document.getElementById("cameraConnection"),
  cameraMessage: document.getElementById("cameraMessage"),
  cameraMessageTitle: document.getElementById("cameraMessageTitle"),
  cameraMessageHint: document.getElementById("cameraMessageHint"),
  cameraRetryButton: document.getElementById("cameraRetryButton"),
  personBadge: document.getElementById("personBadge"),
  sceneMenuButton: document.getElementById("sceneMenuButton"),
  deviceButton: document.getElementById("deviceButton"),
  cameraPrivacyButton: document.getElementById("cameraPrivacyButton"),
  homeCardButton: document.getElementById("homeCardButton"),
  emergencyLayer: document.getElementById("emergencyLayer"),
  sheetBackdrop: document.getElementById("sheetBackdrop"),
  sheetTitle: document.getElementById("sheetTitle"),
  sheetEyebrow: document.getElementById("sheetEyebrow"),
  sheetBody: document.getElementById("sheetBody"),
  sheetClose: document.getElementById("sheetClose"),
  sheetDismiss: document.getElementById("sheetDismiss"),
  callLayer: document.getElementById("callLayer"),
  callStatus: document.getElementById("callStatus"),
  hangupButton: document.getElementById("hangupButton"),
  privacySwitchOff: document.getElementById("privacySwitchOff"),
  mimoSwitchOff: document.getElementById("mimoSwitchOff"),
  toast: document.getElementById("toast")
};

const state = {
  tab: "home",
  scene: "normal",
  cameraOverlayVisible: true,
  stream: null,
  poseLandmarker: null,
  cameraReady: false,
  modelReady: false,
  fallbackMode: false,
  lastVideoTime: -1,
  lastInferenceAt: 0,
  landmarks: [],
  toastTimer: null,
  riskTimer: null,
  privacyOn: true,
  mimoOn: true
};

function showToast(message) {
  window.clearTimeout(state.toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.add("is-visible");
  state.toastTimer = window.setTimeout(() => elements.toast.classList.remove("is-visible"), 1900);
}

function switchTab(tab) {
  if (!elements.screens[tab]) return;
  state.tab = tab;
  Object.entries(elements.screens).forEach(([name, screen]) => {
    screen.classList.toggle("is-active", name === tab);
  });
  elements.cameraStage.classList.toggle(
    "is-hidden",
    tab !== "home" || state.scene !== "normal" || !state.cameraOverlayVisible
  );
  closeSheet();
}

function setScene(sceneName) {
  const scene = SCENES[sceneName];
  if (!scene) return;
  window.clearTimeout(state.riskTimer);
  state.scene = sceneName;
  elements.homeArt.src = scene.image;
  elements.homeArt.alt = `Reme 首页 · ${scene.name}`;
  state.cameraOverlayVisible = scene.camera;
  elements.cameraStage.classList.toggle("is-hidden", !scene.camera || state.tab !== "home");
  closeSheet();
  showToast(`已切换：${scene.name}`);

  if (scene.camera && !state.cameraReady) startCamera();
  if (sceneName === "risk") {
    state.riskTimer = window.setTimeout(() => {
      elements.emergencyLayer.classList.remove("is-hidden");
      if (navigator.vibrate) navigator.vibrate([120, 80, 120]);
    }, 900);
  }
}

function openSheet({ eyebrow = "REME", title, html }) {
  elements.sheetEyebrow.textContent = eyebrow;
  elements.sheetTitle.textContent = title;
  elements.sheetBody.innerHTML = html;
  elements.sheetBackdrop.classList.remove("is-hidden");
  elements.sheetBackdrop.setAttribute("aria-hidden", "false");
}

function closeSheet() {
  elements.sheetBackdrop.classList.add("is-hidden");
  elements.sheetBackdrop.setAttribute("aria-hidden", "true");
}

function openSceneSheet() {
  const options = Object.entries(SCENES).map(([key, scene]) => `
    <button class="scene-option ${key === state.scene ? "is-selected" : ""}" data-scene="${key}" type="button">
      <span class="scene-icon">${scene.icon}</span>
      <span class="scene-copy"><strong>${scene.name}</strong><small>${scene.detail}</small></span>
      <span class="scene-check">${key === state.scene ? "✓" : "›"}</span>
    </button>
  `).join("");
  openSheet({ eyebrow: "HOME SCENES", title: "切换演示场景", html: `<div class="scene-list">${options}</div>` });
  elements.sheetBody.querySelectorAll("[data-scene]").forEach((button) => {
    button.addEventListener("click", () => setScene(button.dataset.scene));
  });
}

const SHEET_CONTENT = {
  summary: {
    title: "本周陪伴摘要",
    eyebrow: "MIMO SUMMARY",
    text: "本周外婆作息整体规律，完成 <strong>5 次自然对话</strong>、记录 <strong>3 个已授权生活片段</strong>。情绪较上周更积极，周六与孙女约好下周一起做饭。"
  },
  cooking: {
    title: "做饭 · 番茄炒蛋",
    eyebrow: "AUTHORIZED MOMENT",
    text: "12:10 检测到做饭场景。MiMo 已向外婆询问分享意愿，并在获得授权后，仅保存成品、关键步骤和语音讲解摘要。"
  },
  dialogue: {
    title: "聊起年轻时",
    eyebrow: "CONVERSATION",
    text: "“那时候很忙，但很充实。” 外婆回忆年轻时在学校教书的日子。系统只向家人展示经授权的语义摘要，不上传原始音视频。"
  },
  emotion: {
    title: "情绪变化",
    eyebrow: "WELLBEING",
    text: "本周积极表达较上周增加 <strong>12%</strong>。周三和周日心情较好；与家人通话后的积极表达持续时间更长。该结论仅作关怀参考，不是医疗诊断。"
  },
  journey: {
    title: "心路历程",
    eyebrow: "MEMORY PATH",
    text: "周二想起年轻时在学校教书的日子；周六主动和孙女约好下周一起做饭。Reme 把零散的生活瞬间整理成可回看的家庭记忆。"
  },
  range: {
    title: "统计周期",
    eyebrow: "DATE RANGE",
    text: "当前显示最近 7 天。比赛演示版也可切换最近 30 天与自定义日期，所有摘要遵循长辈授权范围。"
  }
};

function openDashboardSheet(type) {
  const content = SHEET_CONTENT[type] || SHEET_CONTENT.summary;
  openSheet({
    eyebrow: content.eyebrow,
    title: content.title,
    html: `
      <div class="detail-card"><p>${content.text}</p></div>
      <div class="sheet-actions">
        <button type="button" data-action="close">稍后再看</button>
        <button class="primary" type="button" data-action="share">发起一次关怀</button>
      </div>
    `
  });
  elements.sheetBody.querySelector("[data-action='close']").addEventListener("click", closeSheet);
  elements.sheetBody.querySelector("[data-action='share']").addEventListener("click", () => {
    closeSheet();
    showToast("已准备关怀消息，等待你确认发送");
  });
}

const SETTINGS_CONTENT = {
  family: ["外婆家", "当前连接客厅摄像头、厨房摄像头和 Reme Pin，共 3 台设备。"],
  local: ["本地处理", "摄像头原画仅在设备本地参与姿态识别；默认只向子女端发送骨骼节点、状态与事件摘要。"],
  sharing: ["分享授权", "生活片段在发送给家人前需要外婆确认；洗澡、换衣等敏感场景永不发送原画。"],
  risk: ["风险提醒", "异常姿态持续 20 秒后触发中风险；MiMo 先询问，未响应时立即通知子女与紧急联系人。"],
  pin: ["Reme Pin", "设备在线，电量 86%。可用于确认分享、主动报平安和一键呼叫家人。"],
  members: ["家庭成员", "已加入外婆、孙女和女儿，共 3 人。不同成员可以设置不同的查看与联系权限。"],
  devices: ["米家设备", "已连接 3 台设备。比赛 Demo 以手机摄像头模拟米家摄像机输入。"],
  time: ["关怀时间", "主动关怀时段为 08:00–22:00；夜间仅在检测到安全风险时提醒。"],
  security: ["数据与安全", "可查看授权记录、风险事件和本地数据清理状态。原始摄像头帧不进入云端。"]
};

function openSettingsSheet(type) {
  const [title, text] = SETTINGS_CONTENT[type] || SETTINGS_CONTENT.security;
  openSheet({
    eyebrow: "PRIVACY BY DESIGN",
    title,
    html: `<div class="detail-card"><p>${text}</p></div><div class="sheet-actions"><button data-action="close" type="button">知道了</button><button class="primary" data-action="save" type="button">保存设置</button></div>`
  });
  elements.sheetBody.querySelector("[data-action='close']").addEventListener("click", closeSheet);
  elements.sheetBody.querySelector("[data-action='save']").addEventListener("click", () => {
    closeSheet();
    showToast("设置已保存在本机");
  });
}

function toggleSetting(type) {
  if (type === "privacy") {
    state.privacyOn = !state.privacyOn;
    elements.privacySwitchOff.classList.toggle("is-visible", !state.privacyOn);
    showToast(state.privacyOn ? "自动隐私保护已开启" : "自动隐私保护已暂停（仅演示）");
  }
  if (type === "mimo") {
    state.mimoOn = !state.mimoOn;
    elements.mimoSwitchOff.classList.toggle("is-visible", !state.mimoOn);
    showToast(state.mimoOn ? "MiMo 主动关怀已开启" : "MiMo 主动关怀已关闭");
  }
}

async function startCamera() {
  if (state.cameraReady) return;
  elements.cameraMessage.classList.remove("is-hidden");
  elements.cameraRetryButton.classList.add("is-hidden");
  elements.cameraMessageTitle.textContent = "正在请求摄像头";
  elements.cameraMessageHint.textContent = "原画只在本机参与姿态计算";
  elements.connection.textContent = "连接中";

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showCameraError("浏览器不支持摄像头，已切换为演示姿态");
    enableFallback();
    return;
  }

  if (!window.isSecureContext && !["localhost", "127.0.0.1"].includes(location.hostname)) {
    showCameraError("请用附带的启动脚本，以 localhost 方式打开");
    enableFallback();
    return;
  }

  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: "user" },
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30, max: 30 }
      }
    });
    elements.video.srcObject = state.stream;
    await elements.video.play();
    state.cameraReady = true;
    elements.connection.textContent = "已连接";
    elements.cameraMessageTitle.textContent = "摄像头已连接";
    elements.cameraMessageHint.textContent = "正在初始化本地姿态模型";
    if (state.modelReady) elements.cameraMessage.classList.add("is-hidden");
  } catch (error) {
    const denied = error && (error.name === "NotAllowedError" || error.name === "PermissionDeniedError");
    showCameraError(denied ? "摄像头权限被拒绝，请允许后重试" : "摄像头不可用，已切换为演示姿态");
    if (!denied) enableFallback();
  }
}

function showCameraError(message) {
  elements.connection.textContent = "未连接";
  elements.cameraMessage.classList.remove("is-hidden");
  elements.cameraMessageTitle.textContent = "无法连接摄像头";
  elements.cameraMessageHint.textContent = message;
  elements.cameraRetryButton.classList.remove("is-hidden");
}

async function loadPoseModel() {
  try {
    const visionModule = await import(MP_BUNDLE_URL);
    const vision = await visionModule.FilesetResolver.forVisionTasks(MP_WASM_URL);
    const options = {
      baseOptions: { modelAssetPath: POSE_MODEL_URL, delegate: "GPU" },
      runningMode: "VIDEO",
      numPoses: 1,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
      outputSegmentationMasks: false
    };
    try {
      state.poseLandmarker = await visionModule.PoseLandmarker.createFromOptions(vision, options);
    } catch (gpuError) {
      options.baseOptions = { modelAssetPath: POSE_MODEL_URL };
      state.poseLandmarker = await visionModule.PoseLandmarker.createFromOptions(vision, options);
    }
    state.modelReady = true;
    if (state.cameraReady) elements.cameraMessage.classList.add("is-hidden");
  } catch (error) {
    enableFallback();
  }
}

function enableFallback() {
  state.fallbackMode = true;
  state.modelReady = false;
  elements.connection.textContent = state.cameraReady ? "已连接" : "演示中";
  elements.cameraMessage.classList.add("is-hidden");
  showToast("姿态模型未联网，已使用动态演示数据");
}

function mapLandmarks(source) {
  return SOURCE_INDEXES.map((sourceIndex) => {
    const point = source[sourceIndex];
    return { x: Number(point.x || 0), y: Number(point.y || 0), score: Number(point.visibility ?? 1) };
  });
}

function demoLandmarks(now) {
  const t = now / 1000;
  const sway = Math.sin(t * 1.4) * 0.018;
  const wave = Math.sin(t * 2) * 0.045;
  return [
    [0.50 + sway, 0.22], [0.485 + sway, 0.21], [0.515 + sway, 0.21], [0.47 + sway, 0.22], [0.53 + sway, 0.22],
    [0.42 + sway, 0.35], [0.58 + sway, 0.35], [0.37 + sway, 0.49], [0.63 + sway, 0.47 - wave],
    [0.34 + sway, 0.63], [0.70 + sway, 0.39 - wave], [0.45 + sway, 0.58], [0.55 + sway, 0.58],
    [0.44 + sway, 0.75], [0.56 + sway, 0.75], [0.43 + sway, 0.91], [0.58 + sway, 0.91]
  ].map(([x, y]) => ({ x, y, score: 0.99 }));
}

function sizeCanvas() {
  const rect = elements.canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.round(rect.width * dpr));
  const height = Math.max(1, Math.round(rect.height * dpr));
  if (elements.canvas.width !== width || elements.canvas.height !== height) {
    elements.canvas.width = width;
    elements.canvas.height = height;
  }
  const ctx = elements.canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, width: rect.width, height: rect.height };
}

function detect(now) {
  if (state.fallbackMode) {
    state.landmarks = demoLandmarks(now);
    return;
  }
  if (!state.cameraReady || !state.modelReady || !state.poseLandmarker || now - state.lastInferenceAt < 70) return;
  if (elements.video.readyState < 2 || elements.video.currentTime === state.lastVideoTime) return;
  state.lastInferenceAt = now;
  state.lastVideoTime = elements.video.currentTime;
  try {
    const result = state.poseLandmarker.detectForVideo(elements.video, now);
    state.landmarks = result?.landmarks?.[0] ? mapLandmarks(result.landmarks[0]) : [];
  } catch (error) {
    state.landmarks = [];
  }
}

function drawSkeleton(ctx, points, width, height) {
  if (points.length !== 17) return;
  const videoWidth = elements.video.videoWidth || 1280;
  const videoHeight = elements.video.videoHeight || 720;
  const scale = Math.max(width / videoWidth, height / videoHeight);
  const drawWidth = videoWidth * scale;
  const drawHeight = videoHeight * scale;
  const offsetX = (width - drawWidth) / 2;
  const offsetY = (height - drawHeight) / 2;
  const mapped = points.map((point) => ({
    x: (1 - point.x) * drawWidth + offsetX,
    y: point.y * drawHeight + offsetY,
    score: point.score
  }));

  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.shadowColor = "rgba(255, 92, 0, 0.28)";
  ctx.shadowBlur = 10;
  CONNECTIONS.forEach(([aIndex, bIndex]) => {
    const a = mapped[aIndex];
    const b = mapped[bIndex];
    if (!a || !b || a.score < 0.35 || b.score < 0.35) return;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.strokeStyle = "#ff5a00";
    ctx.lineWidth = Math.max(2.6, width / 115);
    ctx.stroke();
  });

  const shoulderWidth = Math.abs(mapped[5].x - mapped[6].x);
  const headRadius = Math.max(11, Math.min(25, shoulderWidth * 0.25));
  ctx.beginPath();
  ctx.arc(mapped[0].x, mapped[0].y - headRadius * 0.18, headRadius, 0, Math.PI * 2);
  ctx.strokeStyle = "#ff5a00";
  ctx.lineWidth = Math.max(2.6, width / 130);
  ctx.stroke();

  mapped.forEach((point) => {
    if (point.score < 0.35) return;
    const radius = Math.max(3.3, width / 110);
    ctx.beginPath();
    ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = "#ff5a00";
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.beginPath();
    ctx.arc(point.x, point.y, radius * 0.55, 0, Math.PI * 2);
    ctx.fillStyle = "#fff";
    ctx.fill();
    ctx.shadowBlur = 10;
  });
  ctx.restore();
}

function render(now) {
  detect(now);
  const { ctx, width, height } = sizeCanvas();
  ctx.clearRect(0, 0, width, height);

  const light = ctx.createRadialGradient(width * 0.5, height * 0.35, 1, width * 0.5, height * 0.35, width * 0.72);
  light.addColorStop(0, "rgba(255,255,255,0.34)");
  light.addColorStop(1, "rgba(238,230,218,0.08)");
  ctx.fillStyle = light;
  ctx.fillRect(0, 0, width, height);

  if (state.landmarks.length === 17) {
    drawSkeleton(ctx, state.landmarks, width, height);
    elements.personBadge.classList.remove("is-hidden");
  } else {
    elements.personBadge.classList.add("is-hidden");
  }
  requestAnimationFrame(render);
}

function installInteractions() {
  document.querySelectorAll("[data-tab]").forEach((button) => {
    button.addEventListener("click", () => switchTab(button.dataset.tab));
  });
  elements.sceneMenuButton.addEventListener("click", openSceneSheet);
  elements.deviceButton.addEventListener("click", () => {
    if (state.scene !== "normal") {
      setScene("normal");
      state.cameraOverlayVisible = true;
      elements.cameraStage.classList.remove("is-hidden");
      showToast("已进入实时本地处理");
      return;
    }
    state.cameraOverlayVisible = !state.cameraOverlayVisible;
    elements.cameraStage.classList.toggle("is-hidden", !state.cameraOverlayVisible);
    showToast(state.cameraOverlayVisible ? "实时本地处理已显示" : "已切换到产品视觉稿");
  });
  elements.cameraPrivacyButton.addEventListener("click", () => {
    state.cameraOverlayVisible = false;
    elements.cameraStage.classList.add("is-hidden");
    showToast("实时画面已隐藏，摄像头继续在本地运行");
  });
  elements.cameraRetryButton.addEventListener("click", startCamera);
  elements.homeCardButton.addEventListener("click", () => {
    const scene = SCENES[state.scene];
    openSheet({
      eyebrow: "CURRENT STATUS",
      title: scene.name,
      html: `<div class="detail-card"><p>${scene.detail}。当前原始视频不上传，仅同步状态和授权后的摘要。</p></div>`
    });
  });
  elements.sheetClose.addEventListener("click", closeSheet);
  elements.sheetDismiss.addEventListener("click", closeSheet);

  document.querySelectorAll("[data-sheet]").forEach((button) => {
    button.addEventListener("click", () => openDashboardSheet(button.dataset.sheet));
  });
  document.querySelectorAll("[data-settings]").forEach((button) => {
    button.addEventListener("click", () => {
      const type = button.dataset.settings;
      if (type === "privacy" || type === "mimo") toggleSetting(type);
      else openSettingsSheet(type);
    });
  });

  document.getElementById("emergencyClose").addEventListener("click", () => elements.emergencyLayer.classList.add("is-hidden"));
  document.getElementById("emergencyCall").addEventListener("click", () => {
    elements.emergencyLayer.classList.add("is-hidden");
    elements.callLayer.classList.remove("is-hidden");
    elements.callStatus.textContent = "等待接听…";
    window.setTimeout(() => {
      if (!elements.callLayer.classList.contains("is-hidden")) elements.callStatus.textContent = "正在响铃 · 00:06";
    }, 1600);
  });
  document.getElementById("emergencyLive").addEventListener("click", () => {
    elements.emergencyLayer.classList.add("is-hidden");
    showToast("正在查看风险事件的实时骨骼状态");
  });
  document.getElementById("emergencyContact").addEventListener("click", () => {
    elements.emergencyLayer.classList.add("is-hidden");
    openSheet({
      eyebrow: "EMERGENCY CONTACTS",
      title: "联系紧急联系人",
      html: `<div class="detail-list"><button class="detail-row" type="button" data-contact="女儿"><span class="detail-icon">女</span><span class="detail-copy"><strong>女儿</strong><small>首要紧急联系人</small></span><span>›</span></button><button class="detail-row" type="button" data-contact="社区管家"><span class="detail-icon">邻</span><span class="detail-copy"><strong>社区管家</strong><small>距离外婆家约 350 米</small></span><span>›</span></button></div>`
    });
    elements.sheetBody.querySelectorAll("[data-contact]").forEach((button) => {
      button.addEventListener("click", () => {
        closeSheet();
        showToast(`正在联系${button.dataset.contact}`);
      });
    });
  });
  elements.hangupButton.addEventListener("click", () => {
    elements.callLayer.classList.add("is-hidden");
    showToast("通话已结束");
  });
  window.addEventListener("resize", sizeCanvas);
  window.addEventListener("beforeunload", () => {
    if (state.stream) state.stream.getTracks().forEach((track) => track.stop());
    if (state.poseLandmarker) state.poseLandmarker.close();
  });
}

async function init() {
  installInteractions();
  requestAnimationFrame(render);
  await Promise.allSettled([startCamera(), loadPoseModel()]);
}

init();
