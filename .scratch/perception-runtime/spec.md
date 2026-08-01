# 实时感知运行时

- Type: spec
- Status: active
- Owners: A / B / C
- Shared contract: `../abc-interface/spec.md`
- Implementation directory: `backend/reme/pose/`

## 目标

在当前CUDA开发电脑上建立单人实时感知链路：

```text
C启动 live_camera
→ A确认摄像头并实时运行MoveNet 2D
→ A输出关键点与姿态RuntimeEvent
→ B运行完整实时状态机和事件触发式MiMo
→ C显示视频、2D骨架、展示型3D和决策
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
- 摄像头原始帧和视频默认不落盘；
- 失败不自动切换预录，由用户显式切换；
- 当前只支持单摄像头、单人主体和固定室内区域。

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

下一步实现摄像头和MoveNet实时适配器。
