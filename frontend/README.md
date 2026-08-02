# Reme 前端与共享现场 Demo

Reme 前端使用 Vite、React、TailwindCSS v4 与 MUI 构建。当前正式入口优先服务单手机采集、多评委只读旁观的现场演示；既有四场景演示保留为明确的单机备份。

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

评委域名是只读端，不会请求摄像头或下载姿态模型。只有打开独立监控域名、输入正确控制密钥并主动点击“开启后置摄像头”后，监控页才会请求摄像头并在本地加载模型。

## 双网址共享现场 Demo

正式入口按主机名区分角色：

```text
https://reme.maniforld.com/          # 评委只读旁观端
https://monitor.reme.maniforld.com/  # 唯一手机监控端
```

两个网址是不同的浏览器 Origin；它们不依赖 localStorage、IndexedDB 或所谓“同域存储”共享数据，而是连接同一个临时 relay 房间。`https://reme.maniforld.com/monitor` 仅保留为兼容入口。

监控端在浏览器本地运行版本化 MoveNet 权重，日常只把不高于 10Hz 的 17 点骨架和版本化结构事件发送到 `relay.reme.maniforld.com`。评委端不下载模型、也不请求摄像头；只有做饭活动被实验识别且本人同意，或跌倒问询按规则升级为告警后，签发时已经在线的评委才会在短时 `media_grant` 下通过 WebRTC 接收现场画面。Cloudflare Durable Object 保存短期控制租约、最新结构状态和授权元数据，只转发 SDP/ICE 而不接收视频帧；JPEG、SDP/ICE、视频帧和录像 Blob 均不写入其 SQLite。最新骨架仍只附着在活跃控制 WebSocket 上。

跨设备页包含四条现场路径：日常为固定家具抽象与实时骨架；厨房低频发送一张降采样 JPEG 给 MiMo，连续两次高置信度 `cooking` 才形成家庭心跳卡；完全隐私场景强制纯骨架；跌倒由真实姿态转变进入问询，完整响应窗未得到安全确认后才升级告警并短期开原画。固定家具不是对真实家庭的识别或重建，跌倒规则也不作医疗准确率承诺。不同网络仅配置 STUN，P2P 协商失败时页面会保留结构化告警并明确回落骨架。

跌倒场景支持公网语音回应。监控端只在用户进入该场景或主动开启采集时预授权麦克风，授权完成即释放音轨；真实跌倒事件的问询播放结束后，才会在冻结的响应截止时间内短时收音。单声道 16 kHz PCM WAV 只用于该事件的一次 MiMo 意图判断，结果仅为 `safe`、`need_help` 或 `unclear`。原始音频和转写不进入 WebSocket、Durable Object、持久存储或服务日志；事件结束、切换场景、停止采集和离开页面都会取消收音及网络请求。无声、拒权、超时或 MiMo 故障都不会延长响应窗，也不会阻止确定性规则告警。

跌倒事件只有收到匹配的 Relay 确认后才显示为已送达。浏览器按严格版本化合同把未结案的结构状态镜像到当前标签页的 `sessionStorage`，不保存控制密钥、音频或转写；短租约失效后重新解锁会强制回到跌倒场景，并按原 deadline 补发或升级。Relay 接受 checking 后还会设置 Durable Object alarm，因此页面被挂起、控制权在 checking 时释放或租约到期，都不会静默取消规则升级。`controller_ready.current_alarm` 会先把服务端未结案升级合并到本地；它可跨合法新租约延续，离线保存的旧“安全”不能自动覆盖已经发出的 timeout 告警。未确认告警、未确认结案或会话存储故障时，页面会阻止场景切换和控制权释放。

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

`/typical-demo.html` 是 ABC 单机验收备份：非浴室场景的家中面板显示本地视频与骨架，家属面板默认只显示骨架且需主动操作才开放视频；浴室始终强制仅骨架。MediaPipe wasm 与姿态模型均从本地资产加载，不依赖运行时 CDN；模型不可用或 15 秒内未加载完成时会明确进入降级模式。

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

1. 客厅行走：老人端只显示现场视频与 A 返回骨架；可手动触发 MiMo 主动关怀。
2. 厨房包包子：进入约 3 秒后由 B 调用 MiMo 询问是否分享给孩子；只有老人明确同意后，家属手机才显示生活提醒。
3. 浴室洗澡：强制骨架模式，家属端永不开放原视频。
4. 深夜跌倒：可使用真人动作，也可点击 `手动触发跌倒报警`，由真实 C→A→B 链路产生询问和家属告警。

家属手机在浴室以外的场景都可主动点击 `查看原视频 + 骨架`。厨房拒绝分享或不回应时不会产生家属生活提醒。页面工具栏提供 MiMo 主动询问、厨房分享/不分享、跌倒报警、重播询问和语音回复；所有回复按真实 `/api/response` 合同提交给 B。

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
│   ├── model/              # 自训练 MoveNet 的 LiteRT.js 浏览器适配
│   ├── shared-demo/        # 评委只读页与唯一监控端
│   ├── typical-demo/       # 四场景 ABC 单机现场验收
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
