# Reme ABC 单机实时验收

入口：`frontend/typical-demo.html`

## 验收目标

在同一台电脑上运行并观察完整链路：

```text
C 浏览器摄像头
  → A 感知服务（8770）
  → B 决策与 MiMo（8100）
  → C Vite 页面（4174）
```

页面不再模拟第二台子女设备。左侧显示现场摄像头、骨架或隐私画面；右侧显示 C 输入状态、A 静态姿态、A 动作转变和 B/MiMo 决策。

## 一键启动

在仓库根目录执行：

```bash
uv run reme-local-demo
```

启动器会自动读取 `~/.config/reme/mimo.env`，启动 A、B、C，并等待三个服务通过健康检查。浏览器访问：

```text
http://127.0.0.1:4174/typical-demo.html
```

按 `Ctrl+C` 统一停止三个进程组，终端会明确输出 `[C] stopped`、`[B] stopped`、`[A] stopped`。该流程不使用 systemd，前端由 Vite 提供，不由 B 静态托管。

## 默认验收场景

页面默认进入“深夜跌倒”，打开后立即创建同一 `session_id` 的 A/B `live_camera` 会话：

1. C 通过 `/ws/camera-input` 向 A 发送浏览器摄像头帧或 17 点关键点。
2. A 通过 `/ws/events` 输出 `frame_landmarks`、`posture_observation` 和 `transition_event`。
3. B 主动订阅 A 的事件流，生成 `care_decision` 并通过 B WebSocket 推回 C。
4. C 在右侧验收面板显示真实连接、姿态、转变、决策来源和降级原因。
5. B 进入询问状态后，可在页面回应“我没事”；告警升级后可确认家属收到。
6. 页面左下角 `Debug` 可展开原始运行时状态；`?debug=1` 可默认打开，显示 A session、姿态分类/置信度/持续时间、转变事件和 B 决策 JSON。

## 已验证链路

本地验收已确认：

- 一键命令能同时启动 A、B、Vite，并在前台 `Ctrl+C` 后终止包括 Vite 子进程在内的全部进程组。
- 浏览器打开页面后，A 创建 `live_camera` 会话。
- B 健康状态从 `attached=false, connected=false` 变为 `attached=true, connected=true`。
- 浏览器与 4174、8770、8100 均建立实际连接。
- 合成跌倒序列产生 160 个关键点帧、54 个姿态事件和 1 个 `fall_like_transition`。
- B 先发出安全询问，8 秒无回应后确定性升级为家属通知。
- A 事件 WebSocket 断开后不再将 WebSocket 帧误解析为下一条 HTTP 请求，因此不会输出 `BrokenPipeError` 堆栈。

## 边界说明

- 当前链路是比赛 Demo 和工程验收，不构成医学或安全级跌倒检测承诺。
- `auto` 输入模式优先由 A 对浏览器 JPEG 做 MoveNet 推理；缺少本地模型时才降级为浏览器关键点输入。
- 无头浏览器或摄像头未授权时，A 会话可以建立但保持 `starting`，直到收到第一帧真实输入。
- 摄像头或模型不可用时必须显示真实降级状态，不得把演示骨架伪装为 A 的识别结果。
