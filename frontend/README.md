# Reme 前端与共享现场 Demo

Reme 前端使用 Vite、React、TailwindCSS v4 与 MUI 构建。当前正式入口优先服务单手机采集、多评委只读旁观的现场演示；既有四场景演示保留为明确的单机备份。

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

评委域名是只读端，不会请求摄像头或下载姿态模型。只有打开独立监控域名、输入正确控制密钥并主动点击“开启后置摄像头”后，监控页才会请求摄像头并在本地加载模型。

## 双网址共享现场 Demo

正式入口按主机名区分角色：

```text
https://reme.maniforld.com/          # 评委只读旁观端
https://monitor.reme.maniforld.com/  # 唯一手机监控端
```

两个网址是不同的浏览器 Origin；它们不依赖 localStorage、IndexedDB 或所谓“同域存储”共享数据，而是连接同一个临时 relay 房间。`https://reme.maniforld.com/monitor` 仅保留为兼容入口。

监控端在浏览器本地运行版本化 MoveNet 权重，只把不高于 10Hz 的 17 点骨架发送到 `relay.reme.maniforld.com`。评委端不下载模型、不请求摄像头，也不接收原始视频。Cloudflare Durable Object 只保存短期控制租约；最新骨架只附着在活跃控制 WebSocket 上，不建立业务数据库或录像存储。

控制密钥原文不在仓库或 Vite 环境变量中。本机部署者可将它直接复制到剪贴板：

```bash
security find-generic-password \
  -a reme-demo-monitor \
  -s reme-shared-live-control-key \
  -w | pbcopy
```

本地联调可在 `.env.local` 指向隔离的 Worker staging：

```text
VITE_REME_DEMO_RELAY_URL=https://reme-demo-relay-staging.lx-0506.workers.dev
```

staging 只允许已列出的本地端口和 Preview；正式 Worker 只允许评委域名、独立监控域名与固定 Preview 别名。

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

截至 `develop/akira@8ef0df8`，A 尚未提供 `/ws/camera-input`，其现有正式实现仍要求 A 反向连接 C 的 Camera WebSocket。页面会将这种情况显示为“A输入待接入”，并继续使用浏览器本地 MediaPipe 作为明确的后备，不会把本地结果伪装成 A 输出。点击状态标签可在 A 服务部署或恢复后重新创建会话。

## 四场景双端现场演示

独立入口：

```text
http://127.0.0.1:4174/typical-demo.html
```

macOS 可双击 `启动Reme典型场景演示.command`，也可以执行 `npm run dev`。

该页面同时显示智能设备端和子女手机端，并复用同一个电脑摄像头：

1. 客厅行走：双端只显示实时17节点骨架。
2. 厨房包饺子：显示实时人物抠像；长辈确认分享后，子女端立即收到生活片段卡片。
3. 浴室洗澡：强制骨架模式，显示隐私幕布、关闭真人画面与音频。
4. 深夜跌倒：点击“开始跌倒流程”或按空格，依次演示候选检测、主动询问、紧急视频和联系人响应。

数字键 `1`–`4` 可快速切换四个场景。跌倒流程使用明确标注的演示编排，不宣称当前模型已经完成真实跌倒确诊；摄像头帧只在页面内存中处理，默认不录制。

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
│   ├── model/              # 自训练 MoveNet 的 LiteRT.js 浏览器适配
│   ├── shared-demo/        # 评委只读页与唯一监控端
│   ├── typical-demo/       # 四场景双端现场演示
│   ├── utils/              # 17 节点映射与 Canvas 绘制
│   ├── App.jsx             # 产品状态与场景编排
│   ├── index.css           # TailwindCSS + 精确坐标样式
│   └── main.jsx            # React 入口和 MUI 主题
├── index.html
├── monitor.html
├── typical-demo.html
├── viewer.html
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
