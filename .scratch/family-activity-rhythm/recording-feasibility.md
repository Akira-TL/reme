# 本机录像回看可行性记录

- Date: 2026-08-11
- Status: go-for-same-browser-demo / no-go-for-cross-device-claim
- Scope: 同一浏览器、同一 origin 的 `/home` → `/family`

## Hypothesis

家中端已取得摄像头、屏幕或本地文件媒体流，并收到真实后端关键点后，
可以把匿名骨架 Canvas 用 `MediaRecorder` 生成独立短片并限量写入
IndexedDB；家属端可在不经过 Relay 和 MiMo 的情况下读取并播放。

## Evidence required

1. 浏览器能力检测与不支持时的可见降级。
2. 一段真实 Blob 的保存、重新读取、对象 URL 创建与 `<video>` 播放。
3. 录像段时间线点击、播放器返回及同日片段切换。
4. 24 小时 / 48 段上限的确定性测试。
5. 浴室场景不启动录像。
6. 常规原画流不作为持久化输入，录像源固定为匿名骨架 Canvas。

## Decision boundary

本实验不把 IndexedDB 当成生产录像架构，也不解决不同设备之间的回放。
若同浏览器 Gate 通过，结论只能是“本机演示可用”；要让远端家属播放，必须
另行决定本地媒体服务、授权、传输、加密、留存和删除机制，不能把录像字节
塞进当前 Relay 的结构化历史合同。

## Result

### Deterministic gates

- `remeLocalRecordings.test.js`：上海日期映射、Blob 元数据和 24 小时 / 48 段
  淘汰计划通过。
- `remeActivityRhythm.test.js`：只有带真实 `playbackUrl` 的录像才生成橙色段；
  元数据和跨日记录不会变成可点击入口。
- `useRemeLocalRecorder.test.js`：容器能力选择通过。

### In-app browser gate

在用户选定的 Codex 内置浏览器、`390×844` 视口完成一次隔离 QA：

这次隔离 QA 验证的是存储与播放器适配器；产品录制源仍由
`useLiveVideoSource` 中的专用匿名骨架 Canvas 提供，不使用常规原画流。

1. 用浏览器原生 `canvas.captureStream` + `MediaRecorder` 生成一段真实 WebM；
2. 写入与产品代码相同的 IndexedDB schema；
3. 重新导航到 `/family` 后成功读取，时间带显示 1 段录像；
4. 点击橙色段进入播放器，播放器拿到 `blob:http://127.0.0.1:4173/...`，
   显示真实视频帧和原生 controls；
5. 返回按钮回到同日时间线，页面 `innerWidth=390`、`scrollWidth=390`；
6. QA IndexedDB 已删除，临时 QA 页面已从工作区移除。

证据：

- `evidence/13-recording-empty-390x844.png`
- `evidence/14-recording-player-390x844.png`

### Gate decision

- **Go**：同一浏览器中的家中端录像保存 → 家属端时间线 → Blob 播放闭环成立。
- **No-go**：不同设备之间没有共享 IndexedDB；当前结果不能宣称远端家属可回放。
- 生产下一步必须先决定本地媒体服务、身份授权和保留删除政策，不扩展当前
  Relay 去存录像字节。
