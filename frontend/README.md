# Reme 手机端交互 Demo

Reme 前端使用 Vite、React、TailwindCSS v4 与 MUI 构建。7 张高保真设计稿继续作为视觉基准，React 组件负责页面状态、场景切换、风险弹窗、设置交互、本地姿态识别，以及 A 感知运行时接入。

## 启动

macOS 可直接双击：

```text
启动Reme手机演示.command
```

也可以使用命令：

```bash
npm install
npm run dev
```

默认地址：`http://127.0.0.1:4174`

首次打开时允许浏览器使用摄像头。页面不会显示摄像头原画，只在本地运行姿态识别并绘制 17 节点火柴人。首次初始化姿态模型需要联网；模型不可用时会明确进入动态演示模式。

## 接入 A 感知服务

复制环境变量示例，并按 A 的实际地址修改：

```bash
cp .env.example .env.local
```

```text
VITE_REME_PERCEPTION_HTTP_URL=http://127.0.0.1:8770
VITE_REME_PERCEPTION_INPUT_WS_URL=ws://127.0.0.1:8770/ws/camera-input
```

前端使用 A 已公布的 HTTP 控制接口启动/停止会话，通过 `/ws/events` 接收 `frame_landmarks`、`posture_observation` 和 `transition_event`。摄像头输入采用浏览器直连 A 的设计：先发送 `scene_signal`，再以 `frame_meta + binary JPEG` 发送 10 FPS、最长边 640px 的帧。

截至 `develop/akira@dfcd312`，A 尚未提供 `/ws/camera-input`，其现有正式实现仍要求 A 反向连接 C 的 Camera WebSocket。页面会将这种情况显示为“A输入待接入”，并继续使用浏览器本地 MediaPipe 作为明确的后备，不会把本地结果伪装成 A 输出。

## 目录

```text
frontend/
├── src/
│   ├── assets/             # 7 张高保真界面素材
│   ├── components/         # 页面、导航、MUI 弹层与摄像头组件
│   ├── adapters/           # A schema 校验和 17 节点映射
│   ├── data/               # 场景、看板和设置文案
│   ├── hooks/              # 摄像头、MediaPipe 与 A 运行时生命周期
│   ├── services/           # A HTTP/WS 地址与控制请求
│   ├── utils/              # 17 节点映射与 Canvas 绘制
│   ├── App.jsx             # 产品状态与场景编排
│   ├── index.css           # TailwindCSS + 精确坐标样式
│   └── main.jsx            # React 入口和 MUI 主题
├── index.html
├── package.json
└── vite.config.js
```

## 交互

- 首页：点击“外婆家”切换客厅实时、做饭、洗澡隐私和异常姿态场景。
- 异常姿态：自动触发紧急弹窗，可模拟呼叫、实时查看和联系紧急联系人。
- 看板：点击摘要、生活片段、对话、情绪曲线和心路历程查看 MUI 详情弹窗。
- 设置：自动隐私保护和 MiMo 主动关怀使用 MUI Switch，其他条目打开详情。
- 导航：首页、看板、设置三页使用 MUI BottomNavigation 管理。
- A 的 `fall_like_transition` 只显示为候选并等待 B 决策，不直接触发紧急通知；原型中的“异常姿态”场景仍是独立的脚本演示。

## 构建

```bash
npm run lint
npm run build
npm run preview
```
