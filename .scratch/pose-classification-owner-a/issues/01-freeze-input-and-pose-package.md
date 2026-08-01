# 01 — 冻结输入场景与姿态提取数据包

**Type:** task

**What to build:** 将比赛目标视频、MoveNet 最佳配置和派生姿态数据整理为可重复生成、不会依赖 `/tmp`、符合 A/B/C 共享接口的首个场景数据包。完成后，团队可以从一个明确的场景入口读取视频元数据和逐帧关键点，而不必重新猜测模型参数或文件位置。

**Blocked by:** None — can start immediately.

**Status:** ready-for-human

- [x] 为每个当前目标视频分配稳定的 `scene_id`，记录文件哈希、分辨率、帧率、总帧数、时长和用途。
- [x] 将当前最佳 MoveNet 关键点、骨架视频和运行摘要保存到被 Git 忽略的持久产物目录，不再把 `/tmp` 作为唯一副本。
- [x] 提供一条可重复执行的命令，使用已确认的模型、阈值和跟踪裁剪参数重建关键点数据。
- [x] 重建结果的帧数、时间戳顺序、关键点名称和坐标空间与已测基线一致；差异必须有书面解释。
- [x] 生成符合共享接口的 `SceneManifest`，并让其中的本地媒体引用和关键点数据引用可以被独立解析。
- [ ] 逐段回放原视频与 MotionBERT Three.js 三维骨架，记录离画、遮挡、低位动作、关键点错位和明显抖动区间。
- [x] 确认默认运行不会持久化额外原始帧，结果报告明确区分姿态提取覆盖率与姿态分类准确率。
- [x] 为 manifest 和关键点 JSONL 增加最小结构校验或自动化测试，非法版本、乱序时间戳和错误关键点集合能够被拒绝。

## Progress

自动化实现和证据见 [`../results/2026-08-01-ticket-01.md`](../results/2026-08-01-ticket-01.md)。

场景包已生成到：

```text
artifacts/pose-classification/scenes/video_148703662/
```

当前只剩人工视觉回放验收。审核页右侧使用 MotionBERT 3D 数据和 Three.js canvas，不再播放骨架 MP4：

```text
artifacts/pose-classification/scenes/video_148703662/review.html
```

使用 `reme.pose.review_server` 启动支持视频 Range 请求的本地服务器。结果报告已经列出打开方式以及优先检查的低置信、低位和高位移候选区间；人工确认后可将本票设为 `resolved`，并开始 Ticket 02。
