# Reme

Reme is a privacy-first care agent that aims to preserve a person's dignity while still detecting safety-relevant events.

## Working hypothesis

A locally processed human-action video may be convertible into a privacy-preserving skeleton or abstract view that retains enough motion information to classify body states and safety-relevant transitions. This is not yet proven on the team's video or hardware.

The team has a usable MiMo API. The current uncertainty is pose extraction and posture/transition classification, not API availability. Pose model, classifier, permanent schema, Raspberry Pi role, MiMo input contract, and demo workflow remain open until feasibility experiments are reviewed.

## Current stage

Feasibility analysis. The current priority is to validate the source video, compare pose extraction routes, classify static postures, and determine whether normal transitions can be distinguished from fall-like transitions.

## Repository layout

```text
.
├── AGENTS.md                 # Instructions for coding agents
├── CONTEXT.md                # Domain language and product boundaries
├── docs/
│   ├── adr/                  # Architecture decision records
│   └── agents/               # Agent workflow configuration
├── backend/reme/             # Product code
├── frontend/                 # Frontend app
├── tests/                    # Deterministic tests
└── .scratch/                 # Specs, tickets, experiments, and handoffs
```

## Local development

```bash
uv sync --extra dev --extra pose
scripts/setup-mimo-env.sh   # 一次性：粘贴 MiMo key，写入 ~/.config/reme/mimo.env 并真实冒烟验证
uv run pytest
uv run ruff check .
uv run mypy
```

从另一台电脑或不同操作系统复制仓库时，不要沿用复制来的 `.venv` 和
`frontend/node_modules`；应在目标机器分别重跑 `uv sync --extra dev --extra pose`
以及 `npm ci`。一键启动器也会检查 Node 原生模块，
发现平台不兼容时自动干净重装。

启动 B（决策服务）前加载 key：`source ~/.config/reme/mimo.env`。key 文件在仓库外、每台机器各自生成，不进 git。

### ABC 单机实时验收

在仓库根目录执行一个前台命令：

```bash
uv run reme-local-demo
```

该命令会自动读取 `~/.config/reme/mimo.env`，依次启动：

- A 感知服务：`http://127.0.0.1:8770`
- B 决策服务：`http://127.0.0.1:8100`
- C Vite 页面：`http://127.0.0.1:4174/typical-demo.html`

浏览器打开验收页面并允许摄像头权限。页面默认进入跌倒链路验收，并在同一页面显示老人端视频/A 骨架与家属手机端。厨房场景会由 `mimo-v2.5` 询问是否分享包包子的生活片段，只有老人同意后家属端才收到提醒；浴室以外场景可由家属主动查看原视频与骨架。按 `Ctrl+C` 会统一停止三个本地进程；不使用 systemd，也不由 B 静态托管前端。

The existing `reme-demo` command and motion-data files came from an early exploratory spike. They are not an accepted architecture and should not be used to constrain the feasibility experiments.

## Immediate milestone

Run the first feasibility gate after the team supplies a video:

```text
inspect video -> compare pose extractors -> annotate posture windows -> evaluate posture/transition classifiers -> decide go/no-go
```

Do not define alert policy or a permanent MiMo payload before this gate. See `.scratch/feasibility/feasibility-analysis.md` and `.scratch/feasibility/posture-classification-protocol.md`.
