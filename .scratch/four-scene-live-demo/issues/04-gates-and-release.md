# 04 — 四场景 Gate、LBX 提交与发布

- Type: task
- Status: in-progress
- Owner: C / Integration
- Blocked by: 01, 02, 03

## What to verify

- [x] 前端测试、lint、build。
- [x] Relay tests、types、dry-run。
- [x] 相关后端安全测试。
- [x] 390×844、430×932、桌面评委端截图检查。
- [x] 单控制端 + 至少 3 Viewer；晚加入、断线、过期和越权路径。
- [ ] 真实做饭/非做饭与真实跌倒/正常动作的条件记录。
- [ ] 只在 `lbx` 创建描述性提交，只推送 `upstream/lbx`。
- [ ] 不使用已有 `dist*`；部署前从 lockfile 重建。
