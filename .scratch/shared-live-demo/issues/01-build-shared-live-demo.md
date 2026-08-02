# 构建单采集端、多评委实时旁观 Demo

- Type: task
- Status: ready-for-human
- Owner: Codex
- Blocked by: Cloudflare Domain Connect 最终授权；目标手机 60 秒实机 Gate

## Scope

按 `../spec.md` 实现并验证：

1. 版本化自训练 MoveNet 静态资产与 LiteRT.js 浏览器适配；
2. `reme.maniforld.com` 评委只读入口与 `monitor.reme.maniforld.com` 密钥解锁采集入口（`/monitor` 仅兼容）；
3. Cloudflare Durable Object 单房间、唯一控制租约、骨架快照和多 Viewer 广播；
4. 单元/集成测试、前端构建、Worker dry-run、Preview 验证；
5. 只有所有适用 Gate 通过后才发布正式入口。

## Answer

代码、upstream 合并、自动化验证、Worker production 与 Vercel production 均已完成。`reme.maniforld.com/` 和兼容控制入口 `/monitor` 已上线；独立控制主机名已附加到 Vercel，Cloudflare 授权页已精确列出待新增的 DNS-only CNAME 与校验 TXT。

剩余两项只可由人完成：

1. 在已登录 Cloudflare Domain Connect 页面确认一次 DNS 变更，使 `monitor.reme.maniforld.com` 生效；
2. 用现场目标 iPhone Safari 或 Android Chrome 连续运行后置摄像头 60 秒并记录性能与降级状态。
