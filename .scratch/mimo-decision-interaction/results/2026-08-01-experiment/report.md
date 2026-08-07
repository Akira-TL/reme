# MiMo 提示词大样本实验报告

总样本数：160；变体数：2；场景数：8

## 逐格明细（变体 × 场景）

| 变体 | 场景 | 样本数 | JSON 合法率 | Schema 合规率 | 期望命中率 | 称呼合规率 | 状态分布 | P50(ms) | P95(ms) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| v1-stock | routine-sitting | 10 | 100.0% | 100.0% | 100.0% | 100.0% | check_in_required:10 | 3149 | 4884 |
| v1-stock | night-bathroom-lying | 10 | 100.0% | 100.0% | 100.0% | 100.0% | check_in_required:10 | 2504 | 4795 |
| v1-stock | toothache-complaint | 10 | 100.0% | 100.0% | 100.0% | 100.0% | consent_required:10 | 2547 | 5217 |
| v1-stock | vague-reply | 10 | 100.0% | 100.0% | 100.0% | 100.0% | check_in_required:10 | 2396 | 5692 |
| v1-stock | refuses-family-notice | 10 | 100.0% | 100.0% | 100.0% | 100.0% | check_in_required:10 | 2359 | 4500 |
| v1-stock | ambiguous-groan | 10 | 100.0% | 100.0% | 100.0% | 100.0% | check_in_required:10 | 3122 | 5170 |
| v1-stock | toothache-card | 10 | 100.0% | 100.0% | 100.0% | 100.0% | family_notification_required:10 | 3209 | 5692 |
| v1-stock | night-fall-card | 10 | 100.0% | 100.0% | 100.0% | 100.0% | family_notification_required:10 | 3513 | 6853 |
| v2-context | routine-sitting | 10 | 100.0% | 100.0% | 100.0% | 100.0% | check_in_required:10 | 2288 | 6246 |
| v2-context | night-bathroom-lying | 10 | 100.0% | 100.0% | 100.0% | 100.0% | check_in_required:10 | 2051 | 4678 |
| v2-context | toothache-complaint | 10 | 100.0% | 100.0% | 100.0% | 100.0% | consent_required:10 | 2452 | 5493 |
| v2-context | vague-reply | 10 | 100.0% | 100.0% | 100.0% | 100.0% | check_in_required:10 | 2519 | 3846 |
| v2-context | refuses-family-notice | 10 | 100.0% | 100.0% | 100.0% | 100.0% | check_in_required:10 | 2690 | 3887 |
| v2-context | ambiguous-groan | 10 | 100.0% | 100.0% | 100.0% | 100.0% | check_in_required:10 | 2158 | 3165 |
| v2-context | toothache-card | 10 | 100.0% | 100.0% | 100.0% | 100.0% | family_notification_required:10 | 3912 | 5548 |
| v2-context | night-fall-card | 10 | 100.0% | 100.0% | 100.0% | 100.0% | family_notification_required:10 | 4117 | 5293 |

## 汇总

| 变体 | 场景 | 样本数 | JSON 合法率 | Schema 合规率 | 期望命中率 | 称呼合规率 | 状态分布 | P50(ms) | P95(ms) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| v1-stock | （全部场景） | 80 | 100.0% | 100.0% | 100.0% | 100.0% | check_in_required:50 family_notification_required:20 consent_required:10 | 3036 | 5170 |
| v2-context | （全部场景） | 80 | 100.0% | 100.0% | 100.0% | 100.0% | check_in_required:50 family_notification_required:20 consent_required:10 | 2705 | 5048 |
| （全部变体） | （全部场景） | 160 | 100.0% | 100.0% | 100.0% | 100.0% | check_in_required:100 family_notification_required:40 consent_required:20 | 2868 | 5170 |
