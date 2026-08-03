# 四场景视觉策略 v2 公网发布证据

- Date: 2026-08-02
- Release commit: `e0601fb48e24d19cf7102a438561672e144998bb`
- Automated code boundary: `f55ca630c3f12a40203d7ee6dc2df93b662ea7e7`
- Voice production baseline: `e465fd7360df8f5111128f269779f096a854ddc5`

## 发布结果

- Cloudflare staging Relay：version `9cd51889-9cdd-4a34-bfe9-ea0a69fd5894`，URL `https://reme-demo-relay-staging.lx-0506.workers.dev`。
- Vercel production：deployment `dpl_4rogtoB5aHkhFXQg6BLhvqdaCVgH`，build URL `https://reme-m8azgozob-lx050s-projects.vercel.app`；`reme.maniforld.com` 与 `monitor.reme.maniforld.com` 已精确切换到该 deployment。
- Cloudflare production Relay：version `666082dc-7b15-4aeb-938f-da734228e640`，custom domain `https://relay.reme.maniforld.com`。
- 滚动顺序为 staging Relay → production frontend → production Relay。生产前端先行期间，旧 Relay 不声明 activity capability，新前端只进入显式 unavailable，不采样或发送 confirmed。

## 自动化与静态发布检查

- Frontend：152/152 tests、ESLint、Vite production build（972 modules）通过；Vercel 生产构建同为 972 modules。
- Relay：61/61 tests 连续三轮、Wrangler types、TypeScript、production/staging dry-run 通过；bundle 152.60 KiB / gzip 26.83 KiB。
- 两路独立只读终审对代码边界 `f55ca630` 均为 no P0-P2。
- 公网入口清单引用 `monitor-main-BUXR0yl7.js` 与 `viewer-main-D_NaztpO.js`；`reme.maniforld.com`、`monitor.reme.maniforld.com` 均为 HTTP 200，并保留 CSP、Permissions-Policy、Referrer-Policy 与 `X-Frame-Options: DENY`。
- 本地发布前视觉检查覆盖 390×844、430×932、1440×900。生产 Chrome 扩展在本次发布后的 DOM/screenshot 读取超时，因此没有把公网自动截图冒充为已完成证据；目标设备视觉 Gate 仍保留。

## staging 与 production 真实路径 smoke

两个环境均使用仓库静态 `frontend/public/scenes/kitchen.jpg`，只验证真实鉴权、WebSocket、MiMo 路径与清理，不作为识别质量样本：

- 非允许 Origin 均为 403。
- controller 首消息为严格六字段 `controller_ready`，下一条独立消息精确声明 `verified-activity-event/v1`。
- staging：scene 返回 `uncertain` / 0.90 / `temporal_evidence=false` / 2094 ms；activity 返回 `not_cooking` / 0.95 / consecutive 0 / no receipt / 1287 ms；两者 model 均为 `mimo-v2.5`。
- production 首轮：scene 返回 `uncertain` / 0.90 / `temporal_evidence=false` / 1829 ms；activity 返回 `not_cooking` / 0.95 / consecutive 0 / no receipt / 1439 ms；两者 model 均为 `mimo-v2.5`。
- production 过滤日志复核轮：scene 1777 ms，activity 1108 ms；结束前发布 living，随后释放租约。最终 `/api/status` 为 `controller_locked=false`、`controller_connected=false`。

Cloudflare production 过滤日志中的真实 MiMo 元数据：

```json
{"event":"scene_recognition_mimo","request_id":"c3ab7bc2-7f90-4001-acde-673117196569","provider":"xiaomi_mimo","model":"mimo-v2.5","status":200,"latency_ms":1777,"outcome":"success","visual_kind":"keyframe","media_format":"jpeg","duration_ms":0,"bytes":236676}
```

日志不含图片正文、MiMo key、控制 key、语音正文或 transcript。activity HTTP 响应也证明走到真实 `mimo-v2.5`，但当前 activity adapter 没有额外写 console 日志；不能据此虚构一条 activity 日志。

## 仍未通过的人工 Gate

- 真实监控手机 + 两个评委设备的厨房 late join、TTL 到期、页面隐藏/恢复、断网、租约释放与权威跌倒 late join。
- 真实做饭与非做饭的连续正/负样本、条件、原始判定与延迟；当前静态图片 smoke 不产生准确率结论。
- 安全保护下的真实跌倒/正常动作演示；不产生医疗级能力声明。
- STUN-only 跨网络条件；TURN/SFU 仍未实现，不能宣称公网普遍稳定。
- iPhone Safari / Android Chrome 的事件触发语音、权限与真实停顿体验；1.4 秒 trailing silence 仅证明短暂停顿可收束，不是语义 VAD 或常驻热词。
