# 实时感知运行时

- Type: spec
- Status: active
- Owners: A / B / C
- Shared contract: `../abc-interface/spec.md`
- Implementation directory: `backend/reme/pose/`

## 目标

在当前CUDA开发电脑上建立单人实时感知链路：

```text
C启动 live_camera 并采集视频/音频
→ A复用C camera WebSocket接收视频帧与场景信号
→ A实时运行MoveNet 2D并输出关键点、姿态和转变RuntimeEvent
→ B接收A的感知事实与C的音频/交互，运行实时状态机和事件触发式MiMo
→ C使用自己的原视频显示视频，并叠加2D骨架、展示型3D和决策
```

预录 `recorded_video` 只回放预计算感知与预录决策，具体视频内容后续决定。

## 已冻结决议

- C是运行模式唯一发起者；
- A/B分别回报实际生效状态；
- 只支持 `live_camera` 和 `recorded_video` 两个profile；
- 切换profile必须创建新 `session_id`；
- 旧session事件必须丢弃；
- 实时只要求MoveNet 2D推理；
- 实时3D是2D关键点在Three.js中的展示映射；
- MotionBERT根节点相对3D只用于预录视频；
- B状态机实时运行，MiMo只在事件触发时调用；
- 正式视频和音频由C采集；A只处理C camera WebSocket中的JPEG帧，音频不进入A；
- A复用同一C camera WebSocket接收不同场景信号，场景切换清空时序状态但不重连；
- A本地摄像头适配器只用于开发测试；
- 摄像头原始帧和视频默认不落盘；
- 失败不自动切换预录，由用户显式切换；
- 当前只支持C提供的单摄像头和单人主体；同一session可复用多个场景。

## 性能目标

- 摄像头预览约30 FPS；
- MoveNet至少15 FPS；
- 姿态输出5–10 Hz；
- 关键点到页面延迟P95不超过300 ms；
- 姿态到页面延迟P95不超过500 ms；
- MiMo触发后首个决策目标不超过8秒；
- 完整链路连续运行10分钟无崩溃。

以上均为待测目标。

## 当前实现

`backend/reme/pose/runtime.py` 已实现：

- RuntimeSessionRequest；
- RuntimeSessionStatus；
- RuntimeEvent；
- 两个profile的合法组合；
- 运行状态不得静默换profile；
- 模式切换要求新session；
- 旧session事件拒绝。

当前已实现C camera WebSocket输入适配器、本地摄像头测试适配器、MoveNet实时推理、姿态/转变事件和A侧HTTP/WebSocket服务。下一步由B/C按共享合同完成消费者接入。
