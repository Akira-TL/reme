# MiMo 提示词大样本实验报告

总样本数：80；变体数：1；场景数：8

## 逐格明细（变体 × 场景）

| 变体 | 场景 | 样本数 | JSON 合法率 | Schema 合规率 | 期望命中率 | 称呼合规率 | 状态分布 | P50(ms) | P95(ms) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| v2-context | routine-sitting | 10 | 100.0% | 100.0% | 100.0% | 100.0% | check_in_required:10 | 2130 | 6425 |
| v2-context | night-bathroom-lying | 10 | 100.0% | 100.0% | 100.0% | 100.0% | check_in_required:10 | 2249 | 8021 |
| v2-context | toothache-complaint | 10 | 100.0% | 100.0% | 100.0% | 100.0% | consent_required:10 | 2639 | 6406 |
| v2-context | vague-reply | 10 | 100.0% | 100.0% | 100.0% | 100.0% | check_in_required:10 | 1934 | 4843 |
| v2-context | refuses-family-notice | 10 | 100.0% | 100.0% | 100.0% | 100.0% | check_in_required:10 | 2073 | 3917 |
| v2-context | ambiguous-groan | 10 | 100.0% | 100.0% | 100.0% | 100.0% | check_in_required:10 | 2235 | 4819 |
| v2-context | toothache-card | 10 | 100.0% | 100.0% | 100.0% | 100.0% | family_notification_required:10 | 2845 | 5060 |
| v2-context | night-fall-card | 10 | 100.0% | 100.0% | 100.0% | 100.0% | family_notification_required:10 | 3655 | 6923 |

## 汇总

| 变体 | 场景 | 样本数 | JSON 合法率 | Schema 合规率 | 期望命中率 | 称呼合规率 | 状态分布 | P50(ms) | P95(ms) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| v2-context | （全部场景） | 80 | 100.0% | 100.0% | 100.0% | 100.0% | check_in_required:50 family_notification_required:20 consent_required:10 | 2836 | 6245 |
| （全部变体） | （全部场景） | 80 | 100.0% | 100.0% | 100.0% | 100.0% | check_in_required:50 family_notification_required:20 consent_required:10 | 2836 | 6245 |
