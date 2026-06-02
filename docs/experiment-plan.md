# Experiment Plan

## Goal

Run a full 10-train / 10-test Harvey LAB patent/IP litigation experiment. The
agent runtime is Codex. The benchmark and scoring are Harvey-native. The
learning object is a reusable Skill, not model weights.

## Method

1. Run baseline Codex agent on all 20 tasks with a minimal Skill.
2. Evaluate every run with Harvey's original evaluator.
3. Inspect train-set `scores.json`, `report.html`, `metrics.json`, and
   transcripts.
4. Use a stronger maintainer model to update only the heuristic surfaces:
   `heuristics/patent-litigation/SKILL.md` and small helper tools/checklists.
5. Rerun the 10 train tasks with the learned Skill.
6. Freeze the Skill.
7. Run the 10 heldout test tasks once with the frozen Skill.
8. Compare baseline test scores against learned-skill test scores.

## Success Criteria

The final report should show improvement on Harvey-native metrics, especially:

- criterion pass rate
- failed criteria per task
- all-pass count
- document coverage
- trace evidence of validation and revision

All headline benchmark numbers must come from Harvey's evaluator.

## Model Budget Strategy

- `gpt-5.4-mini`: task runner and high-volume execution.
- `gpt-5.5`: train-failure analysis and Skill maintenance.

This uses Codex ChatGPT-plan authentication by default instead of API-key bulk
usage.

## Report Style

The final report follows the shape of "Learning Beyond Gradients": start with
the anomaly, explain the learning object, show why gradient-free learning is
natural here, then present the experiment and what changed in the Skill.

