# 示例数据与联调工具

`examples/` 保存体积小、可提交、用于合同演示或本地联调的固定输入。

```text
examples/
├── decision/       # B 侧家庭上下文、MiMo mock 和预置语音
├── integration/    # 统一运行时联调驱动
└── motion/         # 早期动作 JSONL 示例，由 scripts/tools/run-legacy-motion-demo.sh 使用
```

规则：

- 不放真实家庭录像、摄像头录制或逐帧训练数据。
- 不放 API key、个人信息或可识别原始材料。
- 大型模型、数据集和生成结果进入 Git 忽略的 `artifacts/`。
- 示例应保持确定性；依赖网络、摄像头或本地模型时必须在文件头说明前置条件。
