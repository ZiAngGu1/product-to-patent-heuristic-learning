# Harvey LAB Codex Heuristic Demo

This repository is a small, reproducible demo for running a Harvey LAB
patent/IP litigation benchmark with Codex as the agent runtime and a
heuristic-learning loop as the improvement mechanism.

Core constraint: Harvey LAB scoring remains unchanged. The experiment improves
the agent's working skill, not the benchmark.

## Experiment

- Benchmark: Harvey LAB `intellectual-property` patent/IP litigation tasks.
- Split: 10 train tasks and 10 test tasks.
- Runner: Codex app/runtime with ChatGPT plan authentication.
- Runner model: `gpt-5.4-mini` for high-volume task execution.
- Maintainer model: `gpt-5.5` for train-failure analysis and skill updates.
- Evaluation: Harvey native evaluator, criteria, `scores.json`, and
  `report.html`.

## Repository Layout

```text
docs/
  experiment-plan.md
experiments/
  splits/patent-ip-10-train-10-test.json
heuristics/
  patent-litigation/SKILL.md
runner/
  # Codex app-runtime integration will live here.
scripts/
  # Experiment orchestration scripts will live here.
reports/
  # Final Chinese long-form report will live here.
artifacts/
  # Run summaries and copied result tables live here.
```

## Research Question

Can train-set Harvey failures improve a reusable patent-litigation Skill and
raise Harvey-native test scores without changing Harvey's evaluator?

## Non-Goals

- No fine-tuning.
- No custom benchmark scoring.
- No hidden answer leakage from test tasks into the Skill.
- No API-key-based bulk experiment by default.

