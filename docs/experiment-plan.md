# Product-to-Patent Heuristic Learning Plan

## Goal

把商品到发明/实用专利的侵权风险筛查做成一个可运行、可评分、可回滚的 heuristic learning harness。

输入是商品图片、商品页面、产品描述、品牌/型号/卖家线索。输出不是最终侵权结论，而是 `HIGH_RISK` 和 `RELATED` 两个 bucket 的专利候选，以及可审计 trace。

## Learning Object

学习对象不是模型权重，而是可维护的外部工作系统：

- `heuristics/product-patent-risk/SKILL.md`
- candidate helper tools under `tmp/eval-loop/candidate-tools`
- output contract
- scorer and verifier rules
- answer-blind runner protocol
- builder notes and rollback gate

## Loop

```text
answer-blind eval runner
  -> scorer / verifier
  -> planner-builder updates skill/tools
  -> rerun benchmark
  -> keep or rollback
```

Runner may read:

- product inputs
- current candidate skill
- candidate helper tools

Runner may not read:

- expected patent numbers
- grading schema answers
- prior score reports
- hidden target files

Builder may read score reports and failures, but any update must be case-agnostic and answer-blind after it is written into the reusable skill.

## Dataset Boundary

The dataset is intentionally not committed. Local runs use:

```powershell
$env:PATENT_DATASET_DIR="C:\path\to\private\dataset"
```

Required private files:

- `patent-number-inputs.md`
- `patent-number-answers.md`
- `patent-number-grading.json`

Optional private context files:

- `patent-number-benchmark.md`
- `test-set.md`
- `answers.md`

## Metrics

- `overall_score`: product-risk usefulness plus target recovery.
- `high_risk_recall`: expected high-risk targets found in `HIGH_RISK`.
- `target_recall`: expected high-risk plus related targets found anywhere in output.
- extra-candidate pressure: too many unsupported family / analog / foreign-only records trigger rollback.

## Acceptance Rule

Keep a candidate only if it improves the measured benchmark without uncontrolled noise. A candidate with better recall but much worse exact-match pattern or too many extra identifiers must be rejected.

## Current Result Summary

On the local 10-case patent-number benchmark:

| Run | Critical / high-risk recall | Target recall |
|---|---:|---:|
| Claude Code / CLI baseline | 27.3% | 21.4% |
| Codex CLI baseline | 45.5% | 42.9% |
| Best accepted heuristic checkpoint | 90.9% | 85.7% |
| Rejected noisy candidate | 81.8% | 71.4% |

The main result is not just that the model outputs more patent numbers. The useful result is that the harness learns reusable product-lock, source-label recovery, claim/status comparison, and bucket discipline.
