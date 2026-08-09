# Reme 固定公开双端演示前端

前端使用 Vite、React、TailwindCSS v4 与 MUI 构建：

- `/`：无密码 Monitor，负责本机媒体、统一运行时和权威状态；
- `/viewer.html`：家属/评委 Viewer，负责观察、单控制租约和告警回应；
- `/_reme/runtime/*`：Vite 同源代理到本地统一后端；
- `/_reme/relay/*`：Vite 同源代理到本地 Relay，包含 HTTP 与 WebSocket。

前端不运行姿态模型。Monitor 以约 10 FPS 发送有界 JPEG，本地后端返回 MoveNet 17 点和结构化事件；原始 JPEG 不进入 Relay。有效事件期原画采用 Monitor 与 Viewer 之间的 WebRTC，RTP 不经过 Worker 或 SQLite。

## 完整启动

从仓库根目录执行：

```bash
uv sync --extra dev --extra pose
cp .env.example .env
scripts/demo/start-local-demo.sh
```

这一个命令会启动并监督三个进程：

1. `reme.runtime.server`，默认 `127.0.0.1:8770`；
2. Cloudflare Worker 本地 Relay，默认 `127.0.0.1:8787`；
3. Vite，默认 `127.0.0.1:4174`。

入口：

```text
Monitor: http://127.0.0.1:4174/
Viewer:  http://127.0.0.1:4174/viewer.html
```

`Ctrl+C`、`SIGTERM` 或 `SIGHUP` 会统一停止三个子进程。项目不使用 systemd，不从 Python 后端静态托管前端，也不安装 Python console script。

## 手机 Monitor 与 HTTPS

桌面 Chrome 可在 `http://127.0.0.1` 的 loopback 安全上下文中使用摄像头。手机通过 `http://<LAN-IP>` 访问时不是安全上下文，不能据此验收 `getUserMedia`、前后镜头或远程原画。

为手机准备一个已被手机系统信任、SAN 包含实际 LAN IPv4/hostname 的证书，然后运行：

```bash
scripts/demo/start-local-demo.sh \
  --host 0.0.0.0 \
  --public-host 192.168.1.42 \
  --tls-cert /absolute/path/to/reme-lan-cert.pem \
  --tls-key /absolute/path/to/reme-lan-key.pem
```

手机访问 `https://192.168.1.42:4174/` 或 `/viewer.html`。Vite 在 HTTPS/WSS 同源下代理后端和 Relay，因此不会把浏览器引回不安全的 `http://` 或 `ws://`。当前启动器拒绝 IPv6；只接受浏览器可见 hostname/IPv4，且 `--public-host` 必须配合 wildcard bind。

证书私钥和 CA 密钥不得提交。浏览器警告页上的临时绕过不等同于系统信任；手机摄像头、麦克风和前后镜头仍须在真机上分别授权和验收。

## 根目录 `.env`

Vite 的 `envDir` 指向仓库根目录。仓库不使用 `frontend/.env`，也不从 `~/.config` 读取项目配置。

根 `.env.example` 提供单独开发时的公开默认值：

```text
VITE_REME_PERCEPTION_HTTP_URL=http://127.0.0.1:8770
VITE_REME_PERCEPTION_INPUT_WS_URL=ws://127.0.0.1:8770/ws/camera-input
VITE_REME_DECISION_HTTP_URL=http://127.0.0.1:8770
VITE_REME_RELAY_URL=http://127.0.0.1:8787
```

完整启动器会根据端口、public host 和 TLS 参数，把这些浏览器值覆盖为 `http(s)://<frontend>/_reme/runtime` 与 `/_reme/relay/` 同源地址。`VITE_*` 会被打入 bundle，只能存放公开信息；MiMo、TURN、Cloudflare 和其他 secret 禁止写入 `VITE_*`。

只看页面时可以运行：

```bash
scripts/demo/start-frontend-preview.sh
```

该命令不会启动后端或 Relay。对应服务缺失时，页面必须显示离线/不可用，不应伪装联调成功。

## 双端交互

Monitor 加载时不主动弹权限框。点击“开始演示”取得 producer lease 后，媒体权限、文件选择和屏幕捕获仍由 Monitor 本机用户确认。远程权限命令只进入本机确认队列。

Viewer 提供首页、看板、设置和控制抽屉：

- 最多 5 名 Viewer；同一时间一个 30 秒可续租 controller；
- 命令以 `received / awaiting_local_confirmation / applied / rejected / failed` ACK 收敛，不做乐观假成功；
- 设置页高隐私开关只能隐藏已经授权的原画，不能越权开启；
- 通知开关控制当前浏览器的声音、震动和闪烁。

四场景媒体边界：

1. 客厅：日常只同步骨架，可发起主动关怀；
2. 厨房：当前事件明确同意后最多开放 60 秒原画；
3. 浴室：任何命令、重连或迟到消息都不得开放原画；
4. 跌倒：只有当前权威紧急升级后最多开放 30 秒原画。

厨房与跌倒的有效 grant 都面向全部在线 Viewer，晚加入者可使用剩余时间。这是固定公开路演的明确例外，不是生产隐私设计。

## 固定公开 Relay 与 TURN 边界

`shared-live-demo` 有意没有密码或身份认证。同一网络中能访问服务的人可加入 Viewer，producer 空闲时也可 claim Monitor。仅在可信/隔离局域网中短时运行，演示结束立即关闭。

本地 Relay 只协调状态、命令和 WebRTC 信令，不提供 TURN 凭证。无 TURN 时只能标为“本机或局域网能力”；跨 NAT、公司访客网、蜂窝网或严格防火墙下的原画可能不可用，不得把 STUN 冒充 TURN。

## 目录

```text
frontend/
├── src/
│   ├── adapters/           # 运行时 schema 与 17 点映射
│   ├── hooks/              # 本地统一后端生命周期
│   ├── services/           # HTTP/WS 客户端
│   ├── typical-demo/       # Monitor、媒体源、场景和命令适配
│   ├── shared-demo/        # Viewer、Relay 协议和 WebRTC
│   └── utils/              # 骨架绘制与本地音频
├── index.html              # Monitor
├── viewer.html             # Viewer
└── vite.config.js          # 双入口、根 envDir、HTTPS 与同源代理
```

## 验证

```bash
npm test
npm run lint
npm run build
```

自动测试不能替代真机权限、真实网络 WebRTC 或设计对照。当前已验证和待验状态见 [双端演示验收记录](../.scratch/public-dual-device-demo/validation.md)。本阶段不包含公网部署、生产 TURN、域名或费用操作。
