# 商品到专利的启发式学习

这个 repo 是一个面向专利智能场景的 heuristic learning demo。任务不是让模型直接给最终侵权结论，而是把一个商品证据输入转成可复核的发明/实用专利侵权风险筛查结果。

核心问题：

```text
product evidence -> patent infringement risk screening -> HIGH_RISK / RELATED buckets
```

输入可以是商品图片、商品页面、产品描述、品牌/型号/卖家线索。输出是带证据链的专利候选：

- `HIGH_RISK`: 和具体商品证据关系强、需要优先由专利分析师或律师复核的候选。
- `RELATED`: 有产品、公司、技术路线、同族或背景关联，但证据不足以进入高风险的候选。

`HIGH_RISK / RELATED` 是结果表达和评分口径，不是最终法律结论。这个 demo 关注的是如何用 verifier-centered harness 让 agent 在小样本专利检索任务上学习稳定工作协议。

## Repo 里有什么

```text
heuristics/product-patent-risk/SKILL.md
  可维护的 patent-risk screening Skill。

scripts/patent-eval-loop.mjs
  answer-blind runner -> scorer -> builder -> rerun 的 heuristic learning loop。

scripts/score-patent-eval.mjs
  对 HIGH_RISK / RELATED 输出做 scoring，产出 score-report.md/json。

scripts/run-cli-baseline-noskill.mjs
  跑 Claude Code / Codex CLI 的 no-skill baseline，用于比较训练是否有效。

scripts/google_patents_parser.py
scripts/claim_risk_matrix.py
  可被 loop 维护或调用的小工具种子。

reports/product-to-patent-heuristic-learning-report.html
  中文长报告草稿，说明任务、方法、实验结果和 training curve。

docs/experiment-plan.md
  实验设计和可复现边界。
```

## 不放进 GitHub 的东西

真实 dataset、答案文件、运行产物、agent transcripts、`.env` 和任何 API key 都不应该提交。脚本通过 `PATENT_DATASET_DIR` 指向本地私有数据目录。

预期本地数据目录结构如下：

```text
<PATENT_DATASET_DIR>/
  patent-number-inputs.md
  patent-number-answers.md
  patent-number-grading.json
  patent-number-benchmark.md      # optional, 给 builder 阅读背景
  test-set.md                     # optional
  answers.md                      # optional legacy file
```

## 运行 baseline 对比

先在当前 shell 指向你的本地数据集：

```powershell
$env:PATENT_DATASET_DIR="C:\path\to\private\patent-dataset"
```

Codex CLI no-skill baseline：

```powershell
node scripts\run-cli-baseline-noskill.mjs `
  --runner codex `
  --model gpt-5.4 `
  --run-dir tmp\baseline-codex
```

Claude Code no-skill baseline：

```powershell
node scripts\run-cli-baseline-noskill.mjs `
  --runner claude `
  --model claude-sonnet-4-6 `
  --run-dir tmp\baseline-claude
```

给某个 run 评分：

```powershell
$env:PATENT_EVAL_RUN_DIR="tmp\baseline-codex"
node scripts\score-patent-eval.mjs
```

## 运行 heuristic learning

Dry run 只检查 harness 和 scoring，不调用 Codex agent：

```powershell
$env:PATENT_DATASET_DIR="C:\path\to\private\patent-dataset"
$env:PATENT_LOOP_DIR="tmp\eval-loop-demo"
$env:PATENT_LOOP_DRY_RUN="1"
$env:PATENT_LOOP_MAX_ITERS="1"
node scripts\patent-eval-loop.mjs
```

真实优化 loop：

```powershell
$env:PATENT_DATASET_DIR="C:\path\to\private\patent-dataset"
$env:PATENT_LOOP_DIR="tmp\eval-loop-demo"
$env:PATENT_LOOP_MAX_ITERS="5"
$env:PATENT_LOOP_NO_PROGRESS_LIMIT="2"
$env:PATENT_LOOP_MODEL="gpt-5.4"
node scripts\patent-eval-loop.mjs
```

默认情况下，loop 只在 `tmp\eval-loop-demo` 里维护候选 skill 和 helper tools，不会改 repo 里的 seed skill。只有显式设置下面这个变量，才会把 best skill 写回：

```powershell
$env:PATENT_LOOP_APPLY="1"
```

## 关键指标

实验报告使用三类核心指标：

- `overall_score`: 综合 product-risk usefulness、bucket quality 和 required-target recovery。
- `high_risk_recall`: 预期高风险目标是否进入 `HIGH_RISK` bucket。
- `target_recall`: 高风险目标和相关目标是否至少被找回。

在当前 10-case benchmark 上，no-skill baseline 和 heuristic loop 的关键对比如下：

| Run | Critical / high-risk recall | Target recall |
|---|---:|---:|
| Claude Code / CLI baseline | 27.3% (3/11) | 21.4% (3/14) |
| Codex CLI baseline | 45.5% (5/11) | 42.9% (6/14) |
| Heuristic loop iter-004 | 90.9% (10/11) | 85.7% (12/14) |
| Heuristic loop iter-005 | 81.8% (9/11) | 71.4% (10/14) |

iter-004 是最佳可接受 checkpoint。iter-005 的召回仍高于 baseline，但输出了过多 extra candidates，public score 掉到 33.1%，因此应该 rollback。

## 安全边界

- 不提交 dataset、答案、运行日志或 `.env`。
- 不把商品名、专利号答案、hidden targets 写进 reusable skill。
- Runner 是 answer-blind；builder 可以读失败摘要，但只能更新可迁移检索协议和工具。
- 这个 demo 是侵权风险筛查前置检索，不是法律意见，也不是 FTO 结论。
