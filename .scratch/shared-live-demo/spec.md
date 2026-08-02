# 单采集端、多评委实时旁观 Demo

- Type: spec
- Status: open
- Owner: C（演示）＋ A（浏览器关键点合同）
- Date: 2026-08-02

## 1. 用户目标

现场只有一台手机充当采集/监控端。评委访问独立的只读网址，实时看到这台手机产生的同一隐私画面。只有在监控网址输入正确控制密钥并取得唯一租约的手机可以请求摄像头、发布骨架和切换演示状态。

两个入口使用不同主机名，角色明确分离：

- `https://reme.maniforld.com/`：评委旁观端；
- `https://monitor.reme.maniforld.com/`：手机监控端；
- `https://reme.maniforld.com/monitor`：仅作为兼容入口；
- `/typical-demo.html`：保留为单机路演备份，不参与正式跨设备链路。

## 2. 已知事实

1. 同一域名或同一次静态部署只会让不同设备下载同一套代码；手机与评委浏览器的内存、IndexedDB 和 localStorage 不共享。
2. 当前 Vercel 部署只包含 Vite 静态前端，线上构建仍默认连接各设备自己的 `127.0.0.1`，不能跨设备看到同一会话。
3. 当前 A/B 支持多订阅广播，但控制接口无鉴权，公开控制页可接管旧会话，不能直接暴露到公网。
4. 用户提供的 `movenet_lightning_f16_v4.tflite` 是团队自训练导出的模型。LiteRT CPU 已实际加载并完成零输入推理：
   - 输入：`serving_default_input:0`，`[1, 192, 192, 3]`，`uint8`；
   - 输出：`StatefulPartitionedCall:0`，`[1, 1, 17, 3]`，`float32`；
   - SHA-256：`0fac2226112d0371903ca86e3853cec24ef603a0b2f96f589b180f0ebdd135ab`。
5. 当前手机前端运行的是 MediaPipe Pose Landmarker，不会自动执行任意 `.tflite` 文件。

## 3. 可行性假设

一台手机可在浏览器内通过 LiteRT.js/WASM 运行自训练 MoveNet，按不高于 10Hz 发布 17 个归一化关键点；一个公网单房间中继只保留最新骨架快照并向任意数量旁观者广播，即可在不传连续原画、不建业务数据库的前提下满足现场同画面演示。

## 4. 最小拓扑

```text
手机监控端 monitor.reme.maniforld.com
  ├─ 服务端密钥校验 → 唯一控制租约
  ├─ 后置摄像头
  ├─ 自训练 MoveNet（浏览器本地）
  └─ 17 点骨架 ≤10Hz
          │
          ▼
Cloudflare Durable Object：单 Demo 房间
  ├─ 唯一发布者租约
  ├─ 只在内存/WS attachment 保留最新骨架
  ├─ 不接收 JPEG、Base64 图片、视频或音频
  └─ 多 WebSocket fan-out
          │
          ▼
评委旁观端 /
  └─ 只渲染同一 17 点骨架，不加载模型、不申请摄像头
```

Vercel 继续负责两个入口、LiteRT WASM 和版本化模型静态资产；中继使用 `relay.reme.maniforld.com`。两个页面即使是不同 Origin，也只通过该临时数据面共享现场状态；评委仍只需访问 `reme.maniforld.com`。

## 5. 数据与隐私边界

- 发布合同仅允许 `schema_version / session_id / sequence / timestamp_ms / source_width / source_height / person_detected / landmark_quality / keypoints[17]`。
- 每个关键点仅含固定名称、`x / y / score` 数值。
- 中继拒绝未知顶层字段，特别拒绝 `image`、`jpeg`、`video`、`audio`、`evidence`、Base64 或二进制媒体。
- 不持久化连续骨架帧；只把最新一帧附着在活跃控制 WebSocket 上，用于晚加入旁观者快照。
- 评委端不暴露可识别原画；产品仍遵守 CONTEXT 与 ADR-0003 的最小视觉原则。
- 模型作为公开网站静态资产后可被下载；这是用户明确允许的 Demo 发布边界，不等于控制密钥公开。

## 6. 控制租约

- 密钥只作为 Cloudflare Secret 的 SHA-256 摘要存在，不进入 Git、Vite 环境变量或浏览器持久存储。
- 正确密钥只签发短期不透明控制令牌；令牌仅保存在监控页内存。
- 同一 Demo 房间一次只允许一个未过期控制租约和一个控制 WebSocket。
- 第二个正确密钥请求也返回 `controller_locked`，不能抢占。
- 心跳续租；断线后短暂保留重连窗口；主动释放或超时后才允许下一位控制者。
- Viewer WebSocket 永远只读。

## 7. Go / No-Go 门槛

只有以下证据全部通过，才把该链路用于正式演示：

1. **模型 Gate**：LiteRT.js/WASM 能加载版本化权重；输入/输出与上方事实一致；固定图片输出 17 个有限关键点。
2. **对齐 Gate**：同一固定输入的浏览器与 Python adapter 点序、坐标解码和裁剪映射一致；差异需记录，不得凭目测通过。
3. **手机 Gate**：Android Chrome 或 iPhone Safari 后置摄像头连续运行 60 秒；记录冷加载、首帧、推理 P50/P95、实际发布 FPS 和降级状态。未测平台不得宣称支持。
4. **共享 Gate**：一个控制端和至少三个 Viewer 同时连接；Viewer 收到同一 `session_id` 和递增 `sequence`；晚加入立即收到最新快照。
5. **权限 Gate**：错误密钥、第二控制者、缺失/过期令牌和 Viewer 发布全部被拒绝；默认 `/` 不调用 `getUserMedia`。
6. **隐私 Gate**：中继拒绝媒体字段和二进制帧；Viewer 网络记录不包含原画上传。
7. **发布 Gate**：Vercel Preview 与 Worker staging 验证后再切正式域名；正式页、模型、WASM、Worker health 和 WSS 都返回预期状态。

任一 Gate 不通过时，正式演示回退到现有 MediaPipe 本地推理或 `/typical-demo.html` 单机备份，并明确展示降级状态。

## 8. 本轮范围

包含：双入口、后置摄像头、自训练 MoveNet 浏览器适配、单房间骨架中继、单控制者密钥租约、Viewer 只读、构建与部署验证。

不包含：原始视频直播、长期录像、身份识别、多房间、多采集者、A/B 全量公网迁移、生产级账户体系或医疗效果声明。

## 9. 2026-08-02 验证记录

| Gate | 结果 | 证据与边界 |
|---|---|---|
| 模型 | 通过（桌面 Chrome/WASM） | LiteRT.js 2.5.3 实际加载版本化权重；`uint8 [1,192,192,3] → float32 [1,1,17,3]`；固定画布输出 17 个有限关键点。 |
| 对齐 | 通过（固定 192×192 输入） | 同一确定性 RGB 输入相对 Python `ai-edge-litert` 的 `max_abs_error=5.960464477539063e-8`、`mean_abs_error=7.85e-9`。该结果刻意绕开浏览器与 OpenCV 缩放差异，不外推非方形预处理像素级一致。 |
| 手机 | 待真人执行 | 尚未在目标 iPhone Safari 或 Android Chrome 连续运行 60 秒；桌面 Chrome 推理时间不能作为手机指标。 |
| 共享 | 通过（Worker staging） | 真实公网 staging 中一个控制浏览器向三个既有 Viewer 广播同一 `session_id/#41`；第四个晚加入 Viewer 立即收到同一快照。 |
| 权限 | 通过 | Relay 7/7 集成测试覆盖错误密钥、第二控制者、Viewer 写入、媒体/二进制拒绝；真实浏览器中的第二监控页显示占用拒绝，释放后租约归零。 |
| 隐私 | 通过（合同与网络检查） | Viewer 构建分包和浏览器资源记录均不含 `/weights/` 或 `/litert/wasm/`，摄像头权限保持 `prompt`；中继只接受严格 17 点 JSON。 |
| 发布 | 进行中 | Worker staging 与 `https://relay.reme.maniforld.com` 已部署，正式域名 HTTPS 健康、外域 Origin 返回 403；Vercel Preview/正式页仍待本分支提交后验证。 |
