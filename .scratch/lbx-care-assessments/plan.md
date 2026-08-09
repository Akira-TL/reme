# 实施计划

1. 为 CareDecision 建立最小 `care.assessment` 投影和纯函数测试。
2. 将 demo state 升级到 v2，并同步 Monitor、Relay、Viewer 校验与 fixture。
3. 重构 family timeline reducer：主事件只保留判断、授权/隐私和处理回执。
4. 加入 8 月 4 日至 11 日的独立 Mock fixture，并保持全程显式标识。
5. 将家庭端导航收敛为 `家 / reme / 设置`，把首页与看板合并。
6. 重构 reme 卡片层级与文案，把系统状态移入展开详情。
7. 运行全套测试、构建和浏览器视觉 QA。
8. 描述性提交，合入并推送 `lbx-frontend`。
