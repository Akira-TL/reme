# A/B/C 实时联调并行修改清单

## 已完成的A侧接口

```text
POST /api/runtime/start
POST /api/runtime/stop
GET  /api/runtime/status
GET  /api/health
WS   /ws/events?session_id=<session_id>
```

A仅在摄像头成功打开并完成首帧推理后回报`running`。WebSocket当前发送：

- `FrameLandmarks`
- `PostureObservation`

切换session时旧连接关闭，旧事件不会进入新会话。

## B可并行修改

1. 增加与A同形状的运行时启动、停止和状态接口；
2. 接受C发起的同一`session_id + live_camera`请求；
3. 作为WebSocket客户端订阅A事件，只消费`PostureObservation`和后续`TransitionEvent`；
4. 正常稳定姿态不得持续调用MiMo；
5. 增加B→C的决策WebSocket或等价推送接口；
6. 从核心合同移除牙疼、授权和行动卡强绑定，不让产品故事阻塞基本链路；
7. 使用`response_timeout_ms`作为当前互动倒计时；未来需要绝对审计时再增加锚点时间字段。

当前`origin/mimo-api-research`已有姿态HTTP入口，但仍缺运行时session控制、B状态推送和决策WebSocket，并保留旧行动卡字段。

## C可并行修改

1. 生成新`session_id`并同时启动A/B；
2. 分别展示A和B回报的实际状态，不根据按钮点击假显示`LIVE`；
3. 连接A WebSocket，渲染实时视频、骨架、姿态和质量；
4. 连接B决策流，渲染`CareDecision`；
5. C→B回应继续使用HTTP；
6. 切换模式时关闭旧连接并丢弃旧session事件；
7. Three.js展示层隐藏双眼和双耳，可用鼻子或面部点平均值显示单一头节点，不修改MoveNet 17点合同。

## A后续可并行修改

1. 继续建立`TransitionEvent`时序基线；
2. 增加`recorded_video`回放Adapter；
3. 完成10分钟连续运行和页面延迟测量；
4. 使用真人受控视频验证静态姿态模型；
5. 不继续通过机械增加epochs追求弱标签动画域指标。

## 合并顺序

```text
A实时事件服务
→ B同步运行时合同并消费A事件
→ C接入A/B状态和事件流
→ 联合10分钟运行
→ 再接TransitionEvent和MiMo触发
```
