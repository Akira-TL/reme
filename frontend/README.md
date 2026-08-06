# Reme 单机演示前端

Reme 前端使用 Vite、React、TailwindCSS v4 与 MUI 构建。正式入口展示四场景单机验收页面，负责场景切换、本地姿态识别、统一后端运行时接入，以及老人端与家属端联动演示。

## 启动

完整单机验收请在仓库根目录执行：

```bash
scripts/demo/start-local-demo.sh
```

然后访问：

```text
http://127.0.0.1:4174/
```

该命令以前台进程组方式启动统一后端和 Vite，按 `Ctrl+C` 会输出 `[FRONTEND] stopped`、`[BACKEND] stopped` 并统一退出；不使用 systemd，也不由后端静态托管前端。

仅调试前端时可执行：

```bash
npm install
npm run dev
```

默认地址：`http://127.0.0.1:4174`

首次打开时允许浏览器使用摄像头。页面不会默认展示可识别原画，只在本地运行姿态识别并绘制 17 节点火柴人。MediaPipe wasm 与姿态模型均从本地资产加载，不依赖运行时 CDN。正式演示强制使用 MediaPipe GPU delegate，并拒绝 SwiftShader、llvmpipe 等软件 WebGL 渲染器；GPU 初始化失败时明确进入动态骨架降级，不会静默回退 CPU。

## 接入统一后端

复制环境变量示例，并按统一后端的实际地址修改：

```bash
cp .env.example .env.local
```

```text
VITE_REME_PERCEPTION_HTTP_URL=http://127.0.0.1:8770
VITE_REME_PERCEPTION_INPUT_WS_URL=ws://127.0.0.1:8770/ws/camera-input
VITE_REME_DECISION_HTTP_URL=http://127.0.0.1:8770
```

前端使用统一后端的 HTTP 控制接口启动/停止会话，通过 `/ws/events` 接收 `frame_landmarks`、`posture_observation` 和 `transition_event`，通过 `/ws` 接收决策事件。正式启动器使用 `landmarks` 输入模式：浏览器摄像头帧由 MediaPipe GPU delegate 转为 17 点关键点，再通过 `/ws/camera-input` 发送给统一后端；不会把 JPEG 交给 Python LiteRT 做 CPU MoveNet 推理。

感知事件通过后端进程内桥接进入决策模块，不经过第二个服务。Debug 面板会显示 `inference_backend=gpu` 和浏览器实际 WebGL 渲染器，用于确认没有落到软件渲染。

## 四场景单机现场验收

正式入口：

```text
http://127.0.0.1:4174/
```

前端不再提供第二个 HTML 入口。macOS 可双击 `启动Reme典型场景演示.command`，也可以执行 `npm run dev`。

该页面在同一设备上显示老人端与家属手机端，并复用同一个电脑摄像头：

1. 客厅行走：老人端只显示现场视频与后端返回骨架；可手动触发 MiMo 主动关怀。
2. 厨房包包子：进入约 3 秒后由决策模块调用 MiMo 询问是否分享给孩子；只有老人明确同意后，家属手机才显示生活提醒。
3. 浴室洗澡：强制骨架模式，家属端永不开放原视频。
4. 深夜跌倒：可使用真人动作，也可点击 `手动触发跌倒报警`，由真实浏览器→统一后端→决策链路产生询问和家属告警。

家属手机在浴室以外的场景都可主动点击 `查看原视频 + 骨架`。厨房拒绝分享或不回应时不会产生家属生活提醒。页面工具栏提供 MiMo 主动询问、厨房分享/不分享、跌倒报警、重播询问和语音回复；所有回复按真实 `/api/response` 合同提交给统一后端。

数字键 `1`–`4` 可快速切换四个场景。页面左下角的 `Debug` 按钮可展开感知会话、当前帧活动、人物检测、姿态分类来源、MIL v3 分数，以及 MiMo 模型、决策、语音识别文本和完整 JSON。`running` 只表示会话运行，不表示当前检测到动作。使用 `?debug=1` 可在打开页面时自动展开调试面板。

当前 MoveNet 单人检测需要全身尽量进入画面，半身取景可能在姿态分类前被判为关键点不可用。摄像头帧只在页面内存中处理，默认不录制；手动测试使用合成运行时事件并明确标注为 `manual_debug`。

## 目录

```text
frontend/
├── src/
│   ├── adapters/           # 运行时 schema 校验和 17 节点映射
│   ├── hooks/              # 统一运行时生命周期
│   ├── services/           # 统一后端 HTTP/WS 地址与控制请求
│   ├── typical-demo/       # 四场景页面、摄像头与状态展示
│   ├── utils/              # GPU、骨架绘制与音频录制
│   ├── main.jsx            # 唯一 React 挂载入口
│   └── theme.js            # MUI 主题
├── index.html              # Vite/React 单页应用壳
├── package.json
└── vite.config.js
```

## 入口约定

- `/` 是唯一正式入口；`index.html` 只负责加载 `src/main.jsx`，页面由 React 在浏览器中动态渲染。
- 前端只有一个 Vite 构建入口，不再生成或维护 `typical-demo.html`。
- 当前只有一个页面，不引入 React Router；后续出现多个客户端页面时再增加语义化路由。

## 构建

```bash
npm run lint
npm test
npm run build
npm run preview
```
