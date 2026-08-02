# Reme 手机端交互 Demo

Reme 前端使用 Vite、React、TailwindCSS v4 与 MUI 构建。7 张高保真设计稿继续作为视觉基准，React 组件负责页面状态、场景切换、风险弹窗、设置交互、本地姿态识别，以及 A 感知运行时接入。

## 启动

完整 ABC 单机验收请在仓库根目录执行：

```bash
uv run reme-local-demo
```

然后访问：

```text
http://127.0.0.1:4174/typical-demo.html
```

该命令以前台进程组方式同时启动 A、B 和 Vite，按 `Ctrl+C` 会依次输出 `[C] stopped`、`[B] stopped`、`[A] stopped` 并统一退出；不使用 systemd，也不由 B 静态托管前端。

仅调试前端时可执行：

```bash
npm install
npm run dev
```

默认地址：`http://127.0.0.1:4174`

首次打开时允许浏览器使用摄像头。页面不会默认展示可识别原画，只在本地运行姿态识别并绘制 17 节点火柴人。MediaPipe wasm 与姿态模型均从本地资产加载，不依赖运行时 CDN；模型不可用或 15 秒内未加载完成时会明确进入降级模式。

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

当前 A 正式提供 `/ws/camera-input`。`auto` 模式优先接收浏览器 JPEG 并在 A 内运行 MoveNet；本地推理栈不可用时，C 才会按能力声明切换为 17 点关键点直传。两种模式都会如实显示数据源和降级状态，不会把演示骨架伪装成 A 输出。

## 四场景单机现场验收

独立入口：

```text
http://127.0.0.1:4174/typical-demo.html
```

macOS 可双击 `启动Reme典型场景演示.command`，也可以执行 `npm run dev`。

该页面在同一设备上显示老人端与家属手机端，并复用同一个电脑摄像头：

1. 客厅行走：老人端显示原视频与 A 返回骨架，家属端默认仅骨架；可手动触发久坐关怀。
2. 厨房包饺子：保留本人确认分享交互，家属端仍需主动打开现场画面。
3. 浴室洗澡：强制骨架模式，家属端永不开放原视频。
4. 深夜跌倒：可使用真人动作，也可点击 `手动触发跌倒报警`，由真实 C→A→B 链路产生询问和家属告警。

页面的“场景状态与语音验收”工具栏还提供恢复正常、重播询问、开始说话、我没事和我需要帮助。B 返回预置语音时优先播放音频文件，否则回退浏览器中文 TTS；浏览器语音识别结果按真实 `/api/response` 合同提交给 B。

数字键 `1`–`4` 可快速切换四个场景。页面左下角的 `Debug` 按钮可展开 A 的会话状态、当前帧活动、人物检测、姿态分类来源、MIL v3 分数，以及 B 的 MiMo 模型、决策、语音识别文本和完整 JSON。`running` 只表示会话运行，不表示当前检测到动作。使用 `?debug=1` 可在打开页面时自动展开调试面板。

当前 MoveNet 单人检测需要全身尽量进入画面，半身取景可能在姿态分类前被判为关键点不可用。摄像头帧只在页面内存中处理，默认不录制；手动测试使用合成运行时事件并明确标注为 `manual_debug`。

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
│   ├── typical-demo/       # 四场景 ABC 单机现场验收
│   ├── utils/              # 17 节点映射与 Canvas 绘制
│   ├── App.jsx             # 产品状态与场景编排
│   ├── index.css           # TailwindCSS + 精确坐标样式
│   └── main.jsx            # React 入口和 MUI 主题
├── index.html
├── typical-demo.html
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
npm test
npm run build
npm run preview
```
