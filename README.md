# Reme

Reme 是面向独居或经常独处老人的隐私优先关怀演示系统。Monitor 在本地采集媒体，统一后端完成 MoveNet 姿态、动作事件和关怀决策；Viewer 默认只接收 17 点骨架和结构化状态。

当前冻结演示版本为 `v0.1.0beta`。它用于比赛路演和可行性验收，不是医疗器械、生产级监护系统，也不代表跌倒准确率、延迟或隐私合规已经获得验证。

## 当前双端链路

```text
Monitor /
  ├─ 摄像头 / 屏幕 / 本地视频
  ├─ 约 10 FPS 有界 JPEG
  │    └─ Vite 同源代理 → 统一后端 :8770
  │         ├─ MoveNet / 姿态 / 连续转变
  │         └─ 进程内 EventBroker → decision / MiMo
  └─ 权威状态、17 点骨架、控制 ACK、WebRTC 信令
       └─ Vite 同源代理 → Relay :8787 → Viewer /viewer.html

事件期原画：Monitor ═════ WebRTC ═════> 全部在线 Viewer
             （RTP 不进入 Worker、SQLite 或事件消息）
```

正式本地入口 `scripts/demo/start-local-demo.sh` 在一个前台启动器中管理三个进程：统一后端、固定公开 Relay 和 Vite 前端。感知到决策仍在后端进程内传递；浏览器和 Viewer 不加载 MoveNet、MediaPipe、LiteRT 或重复模型权重。

## 桌面本机启动

环境要求：Python 3.11+、`uv`、Node.js 和 npm。

```bash
uv sync --extra dev --extra pose
cp .env.example .env
# 编辑仓库根目录 .env；MIMO_API_KEY 可留空并显示确定性降级状态
scripts/demo/start-local-demo.sh
```

脚本最终执行的 Python 入口是：

```bash
uv run --extra pose python -m reme.runtime.launcher
```

启动后访问：

```text
Monitor: http://127.0.0.1:4174/
Viewer:  http://127.0.0.1:4174/viewer.html
```

`Ctrl+C`、`SIGTERM` 或 `SIGHUP` 会触发统一清理。macOS 也可双击根目录的 `启动Reme全链路演示.command`。

## 手机局域网启动

手机把局域网 IP 的普通 HTTP 页面视为不安全上下文，不能据此验收摄像头或前后镜头。手机 Monitor 必须使用手机已信任的 HTTPS 证书，且证书 SAN 必须包含实际访问的 IPv4 地址或 hostname：

```bash
scripts/demo/start-local-demo.sh \
  --host 0.0.0.0 \
  --public-host 192.168.1.42 \
  --tls-cert /absolute/path/to/reme-lan-cert.pem \
  --tls-key /absolute/path/to/reme-lan-key.pem
```

然后在手机访问：

```text
Monitor: https://192.168.1.42:4174/
Viewer:  https://192.168.1.42:4174/viewer.html
```

`--public-host` 只允许与 `--host 0.0.0.0` 一起使用，当前启动器明确拒绝 IPv6。证书私钥不得提交；仅“继续访问”一个未受信任的自签证书不能替代系统信任，也不能作为手机媒体权限已通过的证据。

## 固定公开房间风险

`shared-live-demo` 有意不做身份认证，只是本轮受控路演例外。同一网络中能够访问端口的人可以作为 Viewer 加入，producer 空闲时也可尝试 claim Monitor。只应在可信或隔离局域网中短时运行，演示结束立即关闭，不得把它宣传为生产访问控制或隐私方案。

- 最多 5 名 Viewer；同一时刻仅一个 30 秒可续租的远程 controller。
- 日常只同步骨架；浴室永不开放原画。
- 厨房只有当前事件明确授权后才可开放最多 60 秒原画。
- 跌倒只有当前权威升级后才可开放最多 30 秒原画。
- 有效 grant 面向全部在线 Viewer，晚到 Viewer 可加入剩余窗口。

本地 Relay 只有信令，没有 TURN 凭证服务。局域网内仍需按实际浏览器和网络结果验收 WebRTC；跨 NAT 或受限网络的原画不可保证，界面必须显示“局域网能力”，不能把 STUN 或一次偶然直连描述为生产可用。

## 根目录环境

项目默认读取仓库根目录 `.env`，不使用 `~/.config`。`frontend/vite.config.js` 的 `envDir` 也指向仓库根目录；公共默认值见 `.env.example`。完整启动器会根据 CLI 主机、端口和 TLS 参数，把浏览器地址覆盖为 Vite 的同源代理路径。

`VITE_*` 会进入浏览器 bundle，只能保存公开 URL 或公开状态。MiMo、TURN、Cloudflare 和其他密钥不得写入 `VITE_*`。

## 目录结构

```text
.
├── backend/reme/       # 本地统一后端：perception、decision、transport、server
├── demo-relay/         # 固定公开房间的 Worker + SQLite Durable Object
├── frontend/           # Monitor、Viewer、媒体源和 WebRTC 适配
├── models/             # 运行时模型约定与本机 ignored 训练模型
├── data/               # 本地或带外训练/参考数据
├── scripts/            # 演示、环境配置和平台启动器
├── docs/               # 产品、方案、ADR 和启动文档
├── tests/              # Python 确定性测试
├── .scratch/           # 规格、实验、验收记录和交接
├── AGENTS.md
└── CONTEXT.md
```

完整操作见 [docs/快速启动.md](docs/快速启动.md)，本轮真实验证与待验项见 [.scratch/public-dual-device-demo/validation.md](.scratch/public-dual-device-demo/validation.md)。

## 开发检查

```bash
uv run --extra dev --extra pose pytest
npm --prefix frontend test
npm --prefix frontend run lint
npm --prefix frontend run build
npm --prefix demo-relay test
npm --prefix demo-relay run check
npm --prefix demo-relay run dry-run
```

模型、摄像头、手机、WebRTC 或 MiMo 的检查必须记录真实设备、网络和缺失条件。自动测试、脚本场景或降级结果不能替代硬件验收。

## 兼容与历史内容

- 项目不定义 `[project.scripts]`，也不向 `.venv/bin` 安装 `reme-*` 命令。
- `scripts/tools/run-legacy-motion-demo.sh`、`experiments/legacy_motion_demo/` 和 `docs/motion-data-format.md` 只用于历史追溯。
- `.scratch/` 中的方案或结果不自动成为架构事实；正式边界以 `CONTEXT.md`、已接受 ADR 和当前代码为准。
