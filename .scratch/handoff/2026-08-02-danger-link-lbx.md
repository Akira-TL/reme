# lbx 集成分支：危险链路六跳全链打通记录（2026-08-02）

分支 `lbx` = b-decision（B 全量）+ develop/jiang（C 前端）+ develop/akira（A 侧演进）+ 三条嫁接。目标：把「C 视频→A 火柴人→姿态→B 分类→预置语音+原图确认→告警卡→真机震动/响铃/闪光」六跳链路真正跑通。

## 拓扑矛盾与解法（最重要的一条）

- akira 的 `c_ws` 适配器假设 **A 外拨**连"C 托管的摄像头 WS"（交接文档 `--c-camera-ws-url ws://<C_HOST>...`）；
- jiang 的真实 C 是浏览器页面，`new WebSocket("<A>/ws/camera-input")` **拨入 A**；
- 浏览器不能当 WS 服务器 → 两端都是客户端，原拓扑无法接通。
- **解法**：`--input-adapter c_ws_server`（新默认）由 A 托管 `/ws/camera-input`：
  - JPEG 帧 → A 的 `CStreamDecoder` 解码 → 进程内队列源 → **逐字复用** akira 的 `CCameraWebSocketPerceptionWorker`（需 cv2+模型工件）；
  - `landmarks_frame`（C 浏览器 MediaPipe 33→17 映射点）→ 纯几何姿态兜底（`GeometricPostureModel`，沿光轴塌缩/稀疏点弃权）+ A 的姿态跟踪与转移检测——**零依赖环境可跑**；
  - `/api/runtime/capabilities` 增 `input` 段（`jpeg_inference`/`landmarks_inference`/`accepts`），C 起手探测自动选道；每服务器单通道，序列单写者。
- akira 的 `c_ws` 外拨适配器**原样保留**（未删一行），如后续真有 C 侧 relay 可切回。请 A owner 复核 c_ws_server 默认值是否接受。

## 逐跳验收

| 跳 | 实现 | 验证 |
|---|---|---|
| 1 C→A | `/ws/camera-input` 托管 + landmarks 直传/JPEG 双道 | E2E + 14 单测 |
| 2 A 姿态/转移 | 几何兜底（无模型）或 MoveNet 管线（有模型） | 合成跌倒流出 `fall_like_transition`（conf≥0.55） |
| 3 A→B | 既有 PerceptionBridge 拉 `/ws/events`（未改） | E2E 实连 |
| 4 B 确认 | 预置语音 + `/api/danger/frame|voice` 双路竞速（昨日建成） | E2E + 真实 key |
| 5 B→C | 既有 `/ws` 决策流（未改），check-in/alarm 均实推 | E2E 断言信封与字段 |
| 6 C 真机 | DangerLayer：voice_asset 即播、倒计时自动 timeout、抓帧/录 WAV 上传、alarm=震动循环+WebAudio 响铃+爆闪 | npm build/lint/node test 绿；真机待 mkcert 联调 |

## 实测数字

- pytest 全量绿（含 `tests/test_danger_link_e2e.py` 六跳集成：真 A 服务器+真 B 服务器+脚本 C，MiMo 仅传输层假体）；mypy strict 57 文件零错；ruff 全过；前端 build/lint/test 绿。
- **真实 key 全链冒烟**（真 A + 真 B live + 真 MiMo 视觉，`run_chain_smoke`）：
  - 合成跌倒关键点流 → check-in 推达 C 端 WS：**0.02s**（本地确定性管线）；
  - fallen.jpg 上传 → 真 MiMo 视觉确认 → alarm 推达：**1.44s**；
  - **全链（跌倒发生→家属端告警指令）：1.46s**，8s 倒计时兜底仍垫底。

## 演示启动（三进程）

```bash
# A（无模型机器自动走 landmarks 道；有 cv2+模型自动 JPEG 道）
.venv/bin/python -m reme.pose.runtime_server --port 8770 --input-adapter c_ws_server
# B（live 需 source ~/.config/reme/mimo.env；预置语音已在 examples/decision/voice_presets）
.venv/bin/reme-decision-server --port 8100 --a-events-url ws://127.0.0.1:8770/ws/events
# C
cd frontend && npm install && npm run dev
# 前端环境变量（默认已对齐）：VITE_REME_PERCEPTION_HTTP_URL=http://127.0.0.1:8770
#                       VITE_REME_DECISION_HTTP_URL=http://127.0.0.1:8100
```

## 遗留

- 手机真机联调（mkcert HTTPS + Android 装 CA）未做；电脑 localhost 直接可跑。
- JPEG 道（cv2+MoveNet 模型工件）在本机未实测（无 [pose] extras）——akira 环境应验证一轮。
- `--input-adapter c_ws_server` 设为默认改变了 A 的 CLI 行为（原默认 c_ws 且必须给 --c-camera-ws-url 否则拒启）——待 akira 确认。
- B 侧 mock 模式下危险链路音频/图片确认不可用（text 规则路可用），演示走 live。
