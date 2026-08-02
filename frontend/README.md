# Reme 手机端交互 Demo

Reme 前端使用 Vite、React、TailwindCSS v4 与 MUI 构建。7 张高保真设计稿继续作为视觉基准，React 组件负责页面状态、场景切换、风险弹窗、设置交互和本地姿态识别。

## 启动

macOS 可直接双击：

```text
启动Reme手机演示.command
```

也可以使用命令：

```bash
npm install
npm run dev
```

默认地址：`http://127.0.0.1:4174`

首次打开时允许浏览器使用摄像头。页面不会显示摄像头原画，只在本地运行姿态识别并绘制 17 节点火柴人。首次初始化姿态模型需要联网；模型不可用时会明确进入动态演示模式。

## 目录

```text
frontend/
├── src/
│   ├── assets/             # 7 张高保真界面素材
│   ├── components/         # 页面、导航、MUI 弹层与摄像头组件
│   ├── data/               # 场景、看板和设置文案
│   ├── hooks/              # MediaPipe 摄像头姿态生命周期
│   ├── utils/              # 17 节点映射与 Canvas 绘制
│   ├── App.jsx             # 产品状态与场景编排
│   ├── index.css           # TailwindCSS + 精确坐标样式
│   └── main.jsx            # React 入口和 MUI 主题
├── index.html
├── package.json
└── vite.config.js
```

## 交互

- 首页：点击“外婆家”切换客厅实时、做饭、洗澡隐私和异常姿态场景。
- 异常姿态：自动触发紧急弹窗，可模拟呼叫、实时查看和联系紧急联系人。
- 看板：点击摘要、生活片段、对话、情绪曲线和心路历程查看 MUI 详情弹窗。
- 设置：自动隐私保护和 MiMo 主动关怀使用 MUI Switch，其他条目打开详情。
- 导航：首页、看板、设置三页使用 MUI BottomNavigation 管理。

## 构建

```bash
npm run lint
npm run build
npm run preview
```
