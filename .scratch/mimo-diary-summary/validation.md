# MiMo 本日动态摘要验证

- 日期：2026-08-09
- 结论：通过

## 自动化

- 后端新接口定向测试：`tests/test_mimo_diary_summary.py`，5/5 通过。
- 后端完整测试：从包含本机 ignored 模型的官方工作区运行本分支测试，全部通过；1 项既有 skip。
- Ruff：新增/修改 Python 文件全部通过。
- Mypy：`diary.py`、decision `config.py`、decision `server.py` 与统一 `server.py` 严格检查通过；动态 HTTP verb 挂载收束在具名适配器中。仓库级检查仍有 4 个与本次 diff 无关的既有感知模块错误。
- 前端：在最新 `origin/lbx-frontend@7d8acd86` 整合基线上 192/192 通过，ESLint 通过，Vite build 通过。
- 路由构建：4/4 通过。
- `git diff --check`：通过。

## 真实 MiMo

- 首轮按默认单次 8 秒预算调用，两次均在读取阶段超时。
- 将日记摘要独立设为单次 20 秒、无自动重试；不改变安全决策预算。
- `mimo-v2.5` 真实复测：6 条结构化事件，9.08 秒成功，严格 JSON 解析通过。
- 返回：`source=mimo`、`reme-diary-summary/v0-experiment`、4 个合法时间重点片段、`uncertainty=low`。
- 密钥仅从进程环境读取，测试日志与前端均未包含密钥。

## 浏览器端到端

- 临时链路：前端 4375 → 后端 8871；验收后均已停止。
- 8 月 9 日：44 条结构化演示记录可提交真实 MiMo 摘要，其中包含 `device` 类型。
- 切换到 8 月 8 日会构建新的请求，输入 33 条；选中日期参与 request key，旧日期结果不能覆盖新日期。
- DOM 上 `data-summary-schema=reme-diary-summary/v0-experiment`，状态为“MiMo 实时生成”。
- 390×844：`window.innerWidth=390`、`document.scrollWidth=390`，无横向溢出。
- 控制台 warning/error：0。
- 截图：`validation-390x844.png`。

## 失败可见性

- `live` 模式真实调用。
- `mock` / `record` 模式返回 `mimo_summary_disabled`。
- 缺 key、超时或网络失败返回 `mimo_unavailable`。
- 模型 JSON 不合法返回 `mimo_invalid_diary_summary`。
- 模型若返回输入中不存在的重点时间，同样返回 `mimo_invalid_diary_summary`。
- 前端所有失败均明确显示“当前不显示替代摘要”，不会落回固定 Mock 文案。
