# Frontend Demo Polish Agent Handoff

你负责 Reme 比赛典型场景页面的前端演示优化。

## 工作位置

```text
worktree: /home/Akira/.devspace/worktrees/reme-cfd30132
branch: feature/frontend-demo-polish
base: refactor/structure@dcfc922
```

进入工作区后先阅读：

```text
AGENTS.md
CONTEXT.md
.scratch/frontend-demo-polish/spec.md
frontend/README.md
```

如果 `.codegraph/` 存在，先使用 CodeGraph 定位组件和调用链。

## 任务

只优化 `frontend/` 的比赛现场演示：

1. 1920×1080 首屏完整展示老人端、家属手机、场景切换和关键状态；
2. 保持摄像头原始宽高比，不拉伸；
3. 优化四场景切换、风险状态和交互反馈；
4. 明确展示摄像头、GPU、WebGL renderer、后端连接和 landmarks 输入状态；
5. 修复重复摄像头、WebSocket 或 RAF 的资源泄漏；
6. 保持浴室场景永不显示原视频；
7. Debug 面板不得挤压主要演示画面。

## 禁止事项

- 不修改 `backend/`、`models/`、`data/`；
- 不修改 HTTP、WebSocket、RuntimeEvent 或 MiMo schema；
- 不改变姿态、跌倒或决策阈值；
- 不恢复 GPU 失败后的 CPU 静默 fallback；
- 不伪造后端、模型或 MiMo 成功状态；
- 不提交构建产物和本地环境文件。

发现后端问题时记录到：

```text
.scratch/frontend-demo-polish/issues.md
```

## 验收

```bash
cd frontend
npm test
npm run lint
npm run build
```

人工检查：

- 1920×1080 无需滚动即可完成主演示；
- 四场景连续切换 20 次无重复摄像头流和 WebSocket；
- 后端离线、GPU 不可用、摄像头拒权时均显示真实状态；
- 浴室场景任何状态都不显示原画；
- `?debug=1` 可完成技术验收。

## 提交

按功能拆分提交：

```text
fix(frontend): 优化典型场景首屏布局
fix(frontend): 完善GPU与后端状态展示
fix(frontend): 修复场景切换资源释放
```

完成后推送 `origin/feature/frontend-demo-polish`，报告提交号、修改文件、测试结果和已知限制。不要合并到其他分支。
