# Reme 本地数据资产

`data/` 保存训练、验证和来源归档数据。除本说明外，目录内容默认不进入 Git。

## 来源

2026-08-05 从以下开发机恢复：

```text
akira@192.168.100.102:/home/akira/Projects/reme
主机名：AkiraArch
```

## 当前目录

```text
data/
├── training/
│   ├── pose/
│   │   ├── raw/downloads6/        # 58 段原始动作视频
│   │   └── processed/downloads6/  # 23 组关键点、标注及 dataset-index.json
│   └── fall/
│       ├── raw/                    # 原始与带检测标记的 50 种摔倒视频
│       └── bootstrap/              # clip manifest、弱标签候选和姿态样本
├── sources/
│   └── pose/downloads6.zip        # 原始下载压缩包
└── reference/
    └── pose/video_148703662/       # 原视频、2D关键点、骨架视频、3D结果和验收页
```

## 姿态数据校验

目录聚合 SHA-256：

```text
b4f69b052d90d2baa32f571c7ef9f98e162c64ec6a0af7bc7c7911dac23a8e7b  training/pose/raw/downloads6
a1ea59f6a00de3f3e4792659056bf62046691300390403328215bfcdf6a62b8d  training/pose/processed/downloads6
85791b1cd21d761ed38f434f6fd74f5cbee69ab8d59c7b3eb542dc7ba26f5c15  reference/pose/video_148703662
```

关键文件 SHA-256：

```text
d6b8279660f7dfff209d5e048122f034fafa6b80319e5c0174ec22f73f4242fc  sources/pose/downloads6.zip
cab66cdd62e1f7c0b5709ab00c50c8e96a7b0bc80527e65013b6f35cd3cbe3a3  training/pose/processed/downloads6/dataset-index.json
6b17dd3c2efdba0e4dff19b6d72836580dafa6bbe632eee5d5430df2eb5743cc  reference/pose/video_148703662/media/source.mp4
```

远端根目录的 `148703662.mp4` 与 `reference/pose/video_148703662/media/source.mp4` 哈希相同，因此没有重复保存。

## 跌倒数据校验

```text
dc0d3a6fec6fd28a52445d6af68a95d13dc2577c9dc86e2ae77cf0da2cbd878c  training/fall/raw/50种摔倒方式 -摔倒检测.mp4
08c6d3c683e19d72a8c9c79cf0d7f074b86536e0855586dca5301019d429a8c2  training/fall/raw/50种摔倒.mp4
0b8e153b4546df94af9a6b58bb97db545e59bc68a75900b60288a5a87a4acb4b  training/fall/bootstrap（目录聚合）
```

原始 bootstrap 文件保留了旧机器绝对路径，便于追溯训练现场。新旧路径对应关系：

```text
/home/akira/Projects/reme/50种摔倒.mp4
→ data/training/fall/raw/50种摔倒.mp4

/home/akira/Projects/reme/50种摔倒方式 -摔倒检测.mp4
→ data/training/fall/raw/50种摔倒方式 -摔倒检测.mp4

/home/akira/Projects/reme/artifacts/pose-classification/fall-50/bootstrap/
→ data/training/fall/bootstrap/
```

重训时应通过命令参数传入新路径，不要直接覆盖原始 manifest 和训练报告中的历史记录。

## 使用规则

- 原始视频只读使用，不在原目录上覆盖处理结果。
- 新生成的关键点、切片或训练集写入 `training/*/processed/` 下的新版本目录。
- 可再生成的日志、临时评估和运行输出写入 `artifacts/`，不要混入数据集。
- 数据来源、授权和可再分发范围尚未统一确认；不得将这些视频公开发布或提交到远端 Git。
