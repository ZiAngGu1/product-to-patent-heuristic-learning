import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const root = process.cwd();
const datasetDir = path.resolve(process.env.PATENT_DATASET_DIR ?? path.join(root, "dataset"));
const answersPath = path.join(datasetDir, "patent-number-answers.md");
const inputsPath = path.join(datasetDir, "patent-number-inputs.md");
const gradingSchemaPath = path.join(datasetDir, "patent-number-grading.json");
const runDir = process.env.PATENT_EVAL_RUN_DIR
  ? path.resolve(process.env.PATENT_EVAL_RUN_DIR)
  : path.join(root, "tmp", "eval-runs");
const reportPath = process.env.PATENT_EVAL_REPORT_PATH
  ? path.resolve(process.env.PATENT_EVAL_REPORT_PATH)
  : path.join(runDir, "score-report.md");
const publicReportPath = process.env.PATENT_EVAL_PUBLIC_REPORT_PATH
  ? path.resolve(process.env.PATENT_EVAL_PUBLIC_REPORT_PATH)
  : path.join(runDir, "score-report.public.md");
const jsonPath = process.env.PATENT_EVAL_JSON_PATH
  ? path.resolve(process.env.PATENT_EVAL_JSON_PATH)
  : path.join(runDir, "score-report.json");
const caseFilter = new Set(
  (process.env.PATENT_EVAL_CASE_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
const useAgentGrader = process.env.PATENT_EVAL_AGENT_GRADER !== "0";
const graderModel = process.env.PATENT_EVAL_GRADER_MODEL ?? "";
const graderTimeoutMs = Number.parseInt(process.env.PATENT_EVAL_GRADER_TIMEOUT_MS ?? "420000", 10);
const graderParallelism = Math.max(1, Number.parseInt(process.env.PATENT_EVAL_GRADER_PARALLELISM ?? "5", 10));
const graderReasoningEffort = process.env.PATENT_EVAL_GRADER_REASONING_EFFORT ?? process.env.PATENT_LOOP_REASONING_EFFORT ?? "";
const graderRetries = Math.max(0, Number.parseInt(process.env.PATENT_EVAL_GRADER_RETRIES ?? "1", 10));
const PATENT_RE = /\b(?:USD|US|CN|EP|JP|KR|WO)\s*[\d,\s.-]+[A-Z]?\d?\b/gi;
const HIGH_RISK_HEADING_RE = /^(?:HIGH[_\s-]*RISK|HIGH RISK PATENTS?|HIGH-RISK ITEMS?)\s*:?\s*$/i;
const RELATED_HEADING_RE = /^(?:RELATED|RELATED ITEMS?|RELATED PATENTS?)\s*:?\s*$/i;

function parseAnswers(text) {
  const rows = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\| (PN-\d{3}) \| (.*?) \|/);
    if (!match) continue;
    rows.set(match[1], normalizeSet(match[2]));
  }
  return rows;
}

function parseInputCases(text) {
  const rows = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\| (PN-\d{3}) \| (.*?) \| `(.*?)` \|$/);
    if (!match) continue;
    rows.set(match[1], { id: match[1], task: match[2], input: match[3] });
  }
  return rows;
}

function parseOutputs(text) {
  return new Map([...parseOutputRecords(text)].map(([id, record]) => [id, record.all]));
}

function parseOutputRecords(text) {
  const rows = new Map();
  const sectionRe = /^##\s+(PN-\d{3})\s*$/gm;
  const matches = [...text.matchAll(sectionRe)];
  for (let i = 0; i < matches.length; i++) {
    const id = matches[i][1];
    const start = matches[i].index + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    const block = text.slice(start, end);
    const fence = block.match(/```(?:text)?\s*([\s\S]*?)```/);
    rows.set(id, parseOutputBlock(fence ? fence[1] : block));
  }
  return rows;
}

function normalizeSet(text) {
  const values = new Set();
  const patentMatches = text.match(PATENT_RE) ?? [];
  for (const raw of patentMatches) {
    values.add(normalizePatent(raw));
  }
  if (/\[family(?::[^\]]*)?\]/i.test(text)) {
    values.add("[family]");
  }
  if (/\bNONE\b/i.test(text) && values.size === 0) {
    values.add("NONE");
  }
  return [...values].sort();
}

function normalizePatent(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function stripListPrefix(line) {
  return String(line || "").replace(/^\s*(?:[-*]|\d+[.)])\s+/, "").trim();
}

function addUnique(values, value) {
  if (!value || values.includes(value)) return;
  values.push(value);
}

function parseOutputBlock(text) {
  const highRisk = [];
  const related = [];
  const all = [];
  let currentBucket = "highRisk";
  let sawBucketHeading = false;

  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = stripListPrefix(rawLine);
    if (!line) continue;
    if (HIGH_RISK_HEADING_RE.test(line)) {
      currentBucket = "highRisk";
      sawBucketHeading = true;
      continue;
    }
    if (RELATED_HEADING_RE.test(line)) {
      currentBucket = "related";
      sawBucketHeading = true;
      continue;
    }
    if (/^NONE$/i.test(line)) {
      continue;
    }
    if (/\[family(?::[^\]]*)?\]/i.test(line)) {
      addUnique(all, "[family]");
      if (!sawBucketHeading || currentBucket === "highRisk") addUnique(highRisk, "[family]");
      else addUnique(related, "[family]");
      continue;
    }
    for (const match of line.matchAll(PATENT_RE)) {
      const normalized = normalizePatent(match[0]);
      if (!normalized) continue;
      addUnique(all, normalized);
      if (!sawBucketHeading || currentBucket === "highRisk") addUnique(highRisk, normalized);
      else addUnique(related, normalized);
    }
  }

  if (all.length === 0) {
    addUnique(all, "NONE");
    addUnique(highRisk, "NONE");
  }

  return {
    all: all.sort(),
    highRisk: highRisk.sort(),
    related: related.sort(),
  };
}

function diffSets(expected, actual) {
  const e = new Set(expected);
  const a = new Set(actual);
  return {
    truePositive: actual.filter((x) => e.has(x)),
    missing: expected.filter((x) => !a.has(x)),
    extra: actual.filter((x) => !e.has(x)),
  };
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort();
}

function normalizedTargetList(values) {
  if (!Array.isArray(values) || values.length === 0) return [];
  return normalizeSet(values.join("\n")).filter((value) => value !== "NONE");
}

function withoutSuspectTargets(values, schema) {
  const suspect = new Set(normalizedTargetList(schema?.suspect_source_labels));
  return values.filter((value) => !suspect.has(value));
}

function getCaseTargets(schema, expected) {
  const highRiskTargets = withoutSuspectTargets(normalizedTargetList(schema?.high_risk_targets), schema);
  const relatedTargets = withoutSuspectTargets(normalizedTargetList(schema?.related_targets), schema);
  const explicitTargets = highRiskTargets.length > 0 || relatedTargets.length > 0;
  if (explicitTargets) {
    return {
      highRiskTargets,
      relatedTargets,
      requiredTargets: uniqueSorted([...highRiskTargets, ...relatedTargets]),
    };
  }

  const directTargets = withoutSuspectTargets(normalizedTargetList(schema?.direct_targets), schema);
  const familyTargets = withoutSuspectTargets(normalizedTargetList(schema?.family_targets), schema);
  const sourceTargets = normalizedTargetList(schema?.source_labels);
  const fallbackTargets = expected.filter((value) => value !== "NONE");
  const inferredHighRisk = directTargets.length > 0 ? directTargets : fallbackTargets;
  const inferredRelated = familyTargets.length > 0
    ? familyTargets
    : sourceTargets.filter((value) => !inferredHighRisk.includes(value));

  return {
    highRiskTargets: uniqueSorted(inferredHighRisk),
    relatedTargets: uniqueSorted(inferredRelated),
    requiredTargets: uniqueSorted([...inferredHighRisk, ...inferredRelated]),
  };
}

function targetStats(targets, actual) {
  const actualSet = new Set(actual);
  const matched = targets.filter((value) => actualSet.has(value));
  return {
    matched,
    missed: targets.filter((value) => !actualSet.has(value)),
    recall: targets.length === 0 ? 1 : matched.length / targets.length,
  };
}

function summarizeTargetCases(cases) {
  const highRiskTargets = cases.flatMap((row) => row.highRiskTargets ?? []);
  const highRiskMatched = cases.flatMap((row) => row.matchedHighRiskTargets ?? []);
  const requiredTargets = cases.flatMap((row) => row.requiredTargets ?? []);
  const requiredMatched = cases.flatMap((row) => row.matchedRequiredTargets ?? []);
  return {
    highRiskTargetCount: highRiskTargets.length,
    highRiskMatchedCount: highRiskMatched.length,
    highRiskRecall: safeDiv(highRiskMatched.length, highRiskTargets.length),
    requiredTargetCount: requiredTargets.length,
    requiredMatchedCount: requiredMatched.length,
    requiredRecall: safeDiv(requiredMatched.length, requiredTargets.length),
  };
}

function safeDiv(numerator, denominator) {
  return denominator === 0 ? 0 : numerator / denominator;
}

function f1(precision, recall) {
  return precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
}

function formatPct(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function average(values) {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function clamp01(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(1, numeric));
}

function resolveCodexInvocation() {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
    const jsCandidates = [
      path.join(appData, "npm", "node_modules", "@openai", "codex", "bin", "codex.js"),
      path.join(os.homedir(), "AppData", "Roaming", "npm", "node_modules", "@openai", "codex", "bin", "codex.js"),
    ];
    for (const candidate of jsCandidates) {
      if (fs.existsSync(candidate)) {
        return { cmd: process.execPath, prefixArgs: [candidate] };
      }
    }
  }
  return { cmd: "codex", prefixArgs: [] };
}

function runCodex(prompt, outLog) {
  const { cmd, prefixArgs } = resolveCodexInvocation();
  const args = [...prefixArgs, "exec", "-C", root, "-s", "danger-full-access"];
  if (graderModel) args.push("-m", graderModel);
  if (graderReasoningEffort) args.push("-c", `model_reasoning_effort="${graderReasoningEffort}"`);
  args.push("-");

  let lastError = null;
  for (let attempt = 1; attempt <= graderRetries + 1; attempt++) {
    const attemptLog = codexAttemptLogPath(outLog, attempt);
    const started = new Date().toISOString();
    const result = spawnSync(cmd, args, {
      cwd: root,
      input: prompt,
      encoding: "utf8",
      shell: false,
      maxBuffer: 50 * 1024 * 1024,
      env: { ...process.env },
      timeout: graderTimeoutMs,
    });
    const error = result.status === 0 ? null : new Error(`agent grader failed with code=${result.status ?? ""} signal=${result.signal ?? ""}`);
    writeCodexLog(attemptLog, started, result.status, result.signal, result.error ?? error, result.stdout, result.stderr);
    if (result.status === 0) {
      if (attemptLog !== outLog) fs.copyFileSync(attemptLog, outLog);
      return;
    }
    lastError = result.error ?? error;
    if (attempt <= graderRetries) {
      fs.appendFileSync(outLog, `\nRetrying agent grader after failed attempt ${attempt}; see ${attemptLog}\n`, "utf8");
    }
  }
  throw new Error(`agent grader failed after ${graderRetries + 1} attempt(s); see ${outLog}: ${lastError}`);
}

async function runCodexAsync(prompt, outLog) {
  let lastError = null;
  for (let attempt = 1; attempt <= graderRetries + 1; attempt++) {
    const attemptLog = codexAttemptLogPath(outLog, attempt);
    try {
      await runCodexAsyncOnce(prompt, attemptLog);
      if (attemptLog !== outLog) fs.copyFileSync(attemptLog, outLog);
      return;
    } catch (error) {
      lastError = error;
      if (attempt <= graderRetries) {
        fs.appendFileSync(outLog, `\nRetrying agent grader after failed attempt ${attempt}; see ${attemptLog}\n`, "utf8");
      }
    }
  }
  throw lastError;
}

function runCodexAsyncOnce(prompt, outLog) {
  const { cmd, prefixArgs } = resolveCodexInvocation();
  const args = [...prefixArgs, "exec", "-C", root, "-s", "danger-full-access"];
  if (graderModel) args.push("-m", graderModel);
  if (graderReasoningEffort) args.push("-c", `model_reasoning_effort="${graderReasoningEffort}"`);
  args.push("-");

  return new Promise((resolve, reject) => {
    const started = new Date().toISOString();
    const child = spawn(cmd, args, {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
      shell: false,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, graderTimeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      writeCodexLog(outLog, started, null, "", error, stdout, stderr);
      reject(error);
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const error = code === 0 && !timedOut
        ? null
        : new Error(`agent grader failed with code=${code ?? ""} signal=${signal ?? ""}${timedOut ? " timeout" : ""}`);
      writeCodexLog(outLog, started, code, signal, error, stdout, stderr);
      if (error) reject(error);
      else resolve();
    });

    child.stdin.end(prompt, "utf8");
  });
}

function writeCodexLog(outLog, started, exitCode, signal, error, stdout, stderr) {
  const body = [
    `started: ${started}`,
    `finished: ${new Date().toISOString()}`,
    `exitCode: ${exitCode}`,
    `signal: ${signal ?? ""}`,
    `error: ${error ? String(error) : ""}`,
    "",
    "## stdout",
    "",
    stdout ?? "",
    "",
    "## stderr",
    "",
    stderr ?? "",
  ].join("\n");
  fs.writeFileSync(outLog, body, "utf8");
}

function codexAttemptLogPath(outLog, attempt) {
  if (attempt <= 1) return outLog;
  const ext = path.extname(outLog);
  const base = ext ? outLog.slice(0, -ext.length) : outLog;
  return `${base}.attempt-${attempt}${ext || ".log"}`;
}

function graderPrompt(caseId, actualPath, tracePath, gradePath, logFriendlyName) {
  return `You are the FLEXIBLE PATENT BENCHMARK GRADER for one case.

Read only what you need from:
- ${gradingSchemaPath}
- ${inputsPath}
- ${answersPath}
- ${actualPath}
- ${tracePath}
- dataset/patent-number-benchmark.md
- dataset/test-set.md
- pn-002-pn-003-evidence.html

Task:
1. Grade only case ${caseId} for strategy ${logFriendlyName}.
2. Use the typed grading schema as the primary policy.
3. Treat source labels as historical benchmark targets, not as the only possible truth.
4. Read the emitted HIGH_RISK and RELATED buckets from the actual payload. If the output was not bucketed, treat emitted patents as HIGH_RISK for backward compatibility.
5. Judge each emitted patent using one relation label:
   - direct_match
   - same_family_or_counterpart
   - potential_risk
   - weak_related
   - irrelevant
   - family_marker
   - none_marker
6. Classify the abstention style when output is NONE:
   - good_none: disciplined search but still no recoverable patent
   - bad_none: strong candidate or likely patent path existed, but the runner still returned NONE
7. Be conservative. A patent should be direct_match only when the product-to-patent bridge is strong.
8. For patents not listed in the schema, use local evidence first. Use primary-source patent records only if needed.

Write strict JSON to ${gradePath} with this shape:
{
  "id": "${caseId}",
  "direct_coverage": 0.0,
  "family_coverage": 1.0,
  "source_label_recall": 0.0,
  "process_score": 0.0,
  "quality_score": 0.0,
  "risk_analysis_score": 0.0,
  "claim_comparison_score": 0.0,
  "legal_scope_score": 0.0,
  "case_score": 0.0,
  "pass": false,
  "none_assessment": "not_applicable | good_none | bad_none",
  "process_checks": {
    "product_identity_lock": "strong | partial | missing",
    "product_decomposition": "strong | partial | missing",
    "search_point_extraction": "strong | partial | missing",
    "expansion_discipline": "strong | partial | missing",
    "evidence_reasoning": "strong | partial | missing",
    "claim_status_comparison": "strong | partial | missing",
    "stop_discipline": "strong | partial | missing"
  },
  "matched_direct_targets": [],
  "matched_family_targets": [],
  "matched_source_labels": [],
  "missed_direct_targets": [],
  "missed_family_targets": [],
  "missed_source_labels": [],
  "matched_high_risk_targets": [],
  "missed_high_risk_targets": [],
  "matched_related_targets": [],
  "missed_related_targets": [],
  "graded_patents": [
    {
      "patent": "US123",
      "relation": "potential_risk",
      "confidence": "medium",
      "note": "short reason"
    }
  ],
  "rationale": "2-4 short sentences",
  "risk_analysis_note": "1-2 short sentences on whether non-target outputs are useful risk findings or mostly noise"
}

Scoring guidance:
- direct_coverage = fraction of direct_targets recovered
- family_coverage = fraction of family_targets recovered; use 1.0 if none exist
- source_label_recall = audit-only fraction of historical source_labels recovered
- suspect_source_labels are audit-only. Do not count them as high_risk_targets, related_targets, direct_targets, family_targets, required targets, or case-score misses, even if a legacy schema also lists them elsewhere.
- high-risk targets should appear in the HIGH_RISK bucket unless the schema notes they are provisional
- related targets can appear in RELATED; they should still count against no-miss recall if omitted
- process_score = how well the trace follows the typed FTO-lite search process for this case
- quality_score = 1.0 for clean strong outputs, around 0.7 for mostly good outputs with meaningful but incomplete support, around 0.4 for mixed outputs, 0.0 for mostly irrelevant/noisy outputs
- risk_analysis_score = usefulness of the emitted patents for real product-risk analysis independent of source-label recall
- claim_comparison_score = how well the trace compares product features to patent abstracts/claim windows instead of relying on titles/categories
- legal_scope_score = how well the trace separates active/enforceable US/CN/EP/JP/KR risk from foreign-only, expired, abandoned, withdrawn, or broad prior-art context
- case_score should combine result quality and process quality
- Scoring bands matter:
  - 0.90 to 1.00 only for near-complete strong answers
  - 0.70 to 0.89 for good but incomplete answers
  - 0.40 to 0.69 for partial / mixed answers
  - 0.00 to 0.39 for weak answers
- Do NOT give 0.90+ to a direct-only answer when the case still appears broader or required target recall is low.
- Do NOT give 0.90+ when configured high_risk_targets or related_targets are missed.
- Extra supported RELATED patents should not heavily reduce quality; unsupported HIGH_RISK noise should.
- Do not conflate audit-only source-label misses with risk-analysis uselessness. If a case misses only suspect/audit labels but finds the required product-risk targets, do not cap case_score for that audit miss.
- A title/category match alone is weak. Reward claim/status comparison only when product features are compared to abstract/claim/legal-status evidence.
- Do NOT pass a clean NONE abstention by default. If the case has no recovered source label and no credible risk analog, NONE should usually be <= 0.25 and fail.
- If the trace shows a disciplined search and no strong candidate path, mark NONE as good_none.
- If the trace itself surfaces a strong candidate path or a likely product-linked patent story that was not emitted, mark NONE as bad_none.
- For family cases, a correct anchor plus genuine family patents can score positively even if the raw output misses an explicit family marker, but that is usually not 0.90+.
- pass means acceptable under flexible grading, not exact-set identity

Do not write markdown. Do not write any file except ${gradePath}.`;
}

async function runAgentGraders(strategyName, outputs, inputsById) {
  const graderRoot = path.join(runDir, "grader", strategyName);
  fs.mkdirSync(graderRoot, { recursive: true });
  const results = new Map();
  const queue = [...outputs.entries()];
  const workers = Array.from({ length: Math.min(graderParallelism, queue.length) }, async () => {
    while (queue.length > 0) {
      const [id, actual] = queue.shift();
      const caseDir = path.join(graderRoot, id);
      fs.mkdirSync(caseDir, { recursive: true });
      const actualPath = path.join(caseDir, "actual.json");
      const gradePath = path.join(caseDir, "grade.json");
      const logPath = path.join(caseDir, "grader-agent.log");
      const tracePath = path.join(runDir, id, "trace.md");
      const payload = {
        strategy: strategyName,
        id,
        task: inputsById.get(id)?.task ?? "",
        input: inputsById.get(id)?.input ?? "",
        actual,
      };
      fs.writeFileSync(actualPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      await runCodexAsync(graderPrompt(id, actualPath, tracePath, gradePath, strategyName), logPath);
      results.set(id, JSON.parse(fs.readFileSync(gradePath, "utf8").replace(/^\uFEFF/, "")));
    }
  });
  await Promise.all(workers);
  return results;
}

function summarizeGraderCases(gradeCases) {
  const targetSummary = summarizeTargetCases(gradeCases);
  return {
    overallScore: average(gradeCases.map((item) => item.caseScore ?? item.case_score ?? 0)),
    directCoverage: average(gradeCases.map((item) => item.directCoverage ?? item.direct_coverage ?? 0)),
    familyCoverage: average(gradeCases.map((item) => item.familyCoverage ?? item.family_coverage ?? 0)),
    sourceLabelRecall: average(gradeCases.map((item) => item.sourceLabelRecall ?? item.source_label_recall ?? 0)),
    riskAnalysisScore: average(gradeCases.map((item) => item.riskAnalysisScore ?? item.risk_analysis_score ?? 0)),
    claimComparisonScore: average(gradeCases.map((item) => item.claimComparisonScore ?? item.claim_comparison_score ?? 0)),
    legalScopeScore: average(gradeCases.map((item) => item.legalScopeScore ?? item.legal_scope_score ?? 0)),
    highRiskRecall: targetSummary.highRiskRecall,
    requiredRecall: targetSummary.requiredRecall,
    processScore: average(gradeCases.map((item) => item.processScore ?? item.process_score ?? 0)),
    quality: average(gradeCases.map((item) => item.qualityScore ?? item.quality_score ?? 0)),
    passCount: gradeCases.filter((item) => item.pass).length,
  };
}

function adjustCaseGrade(row, schema) {
  const directTargets = schema?.direct_targets ?? [];
  const familyTargets = schema?.family_targets ?? [];
  const taskMode = schema?.task_mode ?? "";
  const gradedPatents = row.gradedPatents ?? [];
  const actual = row.actual ?? [];
  const hasNoneOnly = actual.length === 1 && actual[0] === "NONE";
  const relationCounts = gradedPatents.reduce((acc, item) => {
    const key = item?.relation ?? "unknown";
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
  const directCount = relationCounts.direct_match ?? 0;
  const familyCount = relationCounts.same_family_or_counterpart ?? 0;
  const riskCount = relationCounts.potential_risk ?? 0;
  const irrelevantCount = relationCounts.irrelevant ?? 0;
  let processScore = row.processScore ?? row.process_score ?? 0;
  let score = row.caseScore ?? row.case_score ?? 0;
  let pass = row.pass ?? false;

  if (hasNoneOnly && row.sourceLabelRecall <= 0 && directCount === 0 && familyCount === 0 && riskCount === 0) {
    score = Math.min(score, taskMode === "risk_analog_search" ? 0.2 : 0.1);
    pass = false;
  }

  if ((row.highRiskTargets ?? []).length > 0 && (row.highRiskRecall ?? 0) < 1) {
    score = Math.min(score, 0.69);
    pass = false;
  }

  if ((row.requiredTargets ?? []).length > 0 && (row.requiredRecall ?? 0) < 0.9) {
    score = Math.min(score, 0.79);
    pass = false;
  }

  if ((row.relatedTargets ?? []).length > 0 && (row.relatedRecall ?? 0) < 1 && (row.requiredRecall ?? 0) >= 0.9) {
    score = Math.min(score, 0.89);
  }

  if (taskMode === "exact_match" && directTargets.length > 0 && row.directCoverage >= 1 && familyTargets.length === 0) {
    const broaderSupport = familyCount + riskCount;
    if (broaderSupport === 0 && row.sourceLabelRecall < 0.5) {
      score = Math.min(score, 0.72);
    }
  }

  if (taskMode === "family_expansion" && row.directCoverage >= 1 && row.familyCoverage <= 0 && familyCount > 0) {
    score = Math.min(score, 0.8);
  }

  if (irrelevantCount > 0 && directCount === 0 && familyCount === 0 && riskCount === 0) {
    score = Math.min(score, 0.1);
    pass = false;
  }

  if (row.directCoverage <= 0 && row.sourceLabelRecall <= 0 && riskCount <= 0 && familyCount <= 0) {
    pass = false;
  }

  processScore = Math.max(0, Math.min(1, processScore));
  score = Math.max(0, Math.min(1, score));

  return {
    ...row,
    pass,
    processScore,
    caseScore: score,
  };
}

const allAnswers = parseAnswers(fs.readFileSync(answersPath, "utf8"));
const allInputs = parseInputCases(fs.readFileSync(inputsPath, "utf8"));
const gradingSchema = fs.existsSync(gradingSchemaPath)
  ? JSON.parse(fs.readFileSync(gradingSchemaPath, "utf8"))
  : { cases: [] };
const schemaCases = new Map((gradingSchema.cases ?? []).map((item) => [item.id, item]));
const answers = caseFilter.size === 0
  ? allAnswers
  : new Map([...allAnswers].filter(([id]) => caseFilter.has(id)));
const inputsById = caseFilter.size === 0
  ? allInputs
  : new Map([...allInputs].filter(([id]) => caseFilter.has(id)));
const files = fs.existsSync(runDir)
  ? fs.readdirSync(runDir).filter((f) => /^strategy-.*-outputs\.md$/.test(f)).sort()
  : [];

const report = [];
const publicReport = [];
const json = {
  generatedAt: new Date().toISOString(),
  runDir,
  gradingSchemaPath: fs.existsSync(gradingSchemaPath) ? gradingSchemaPath : "",
  agentGrader: useAgentGrader,
  graderModel: graderModel || "Codex CLI default",
  graderParallelism,
  graderReasoningEffort: graderReasoningEffort || "Codex CLI/profile default",
  graderRetries,
  target: gradingSchema.target ?? {
    overall_score_goal: 0.9,
    high_risk_recall_goal: 0.9,
    target_recall_goal: 0.9,
  },
  strategies: [],
};
report.push("# Patent Eval Score Report");
report.push("");
report.push(`Generated: ${json.generatedAt}`);
report.push("");
publicReport.push("# Patent Eval Score Report (Public)");
publicReport.push("");
publicReport.push(`Generated: ${json.generatedAt}`);
publicReport.push("");
publicReport.push("This report redacts expected patent numbers. It is safe for planner/builder agents.");
publicReport.push("");

for (const file of files) {
  const outputRecords = parseOutputRecords(fs.readFileSync(path.join(runDir, file), "utf8"));
  const outputs = new Map([...outputRecords].map(([id, record]) => [id, record.all]));
  let exact = 0;
  let total = 0;
  let totalTp = 0;
  let totalFp = 0;
  let totalFn = 0;
  let macroF1Sum = 0;
  const strategyName = file.replace("-outputs.md", "");
  const strategyJson = {
    name: strategyName,
    file,
    exact,
    total,
    exactRate: 0,
    patentTotals: {
      tp: 0,
      fp: 0,
      fn: 0,
      precision: 0,
      recall: 0,
      f1: 0,
    },
    macro: {
      caseF1: 0,
    },
    targetTotals: {
      highRiskTargetCount: 0,
      highRiskMatchedCount: 0,
      highRiskRecall: 0,
      requiredTargetCount: 0,
      requiredMatchedCount: 0,
      requiredRecall: 0,
    },
    grader: null,
    cases: [],
  };
  const caseRows = [];
  for (const [id, expected] of answers) {
    total++;
    const record = outputRecords.get(id) ?? { all: [], highRisk: [], related: [] };
    const actual = record.all ?? [];
    const schema = schemaCases.get(id) ?? {};
    const { highRiskTargets, relatedTargets, requiredTargets } = getCaseTargets(schema, expected);
    const highRiskStats = targetStats(highRiskTargets, record.highRisk ?? []);
    const relatedStats = targetStats(relatedTargets, record.related ?? []);
    const requiredStats = targetStats(requiredTargets, actual);
    const { truePositive, missing, extra } = diffSets(expected, actual);
    const exactPass = missing.length === 0 && extra.length === 0;
    const tp = truePositive.length;
    const fp = extra.length;
    const fn = missing.length;
    const precision = safeDiv(tp, tp + fp);
    const recall = safeDiv(tp, tp + fn);
    const caseF1 = f1(precision, recall);
    if (exactPass) exact++;
    totalTp += tp;
    totalFp += fp;
    totalFn += fn;
    macroF1Sum += caseF1;
    caseRows.push({
      id,
      actual,
      highRiskActual: record.highRisk ?? [],
      relatedActual: record.related ?? [],
      highRiskTargets,
      relatedTargets,
      requiredTargets,
      matchedHighRiskTargets: highRiskStats.matched,
      missedHighRiskTargets: highRiskStats.missed,
      highRiskRecall: highRiskStats.recall,
      matchedRelatedTargets: relatedStats.matched,
      missedRelatedTargets: relatedStats.missed,
      relatedRecall: relatedStats.recall,
      matchedRequiredTargets: requiredStats.matched,
      missedRequiredTargets: requiredStats.missed,
      requiredRecall: requiredStats.recall,
      exactPass,
      truePositive,
      truePositiveCount: tp,
      missingCount: missing.length,
      missing,
      extraCount: extra.length,
      extra,
      precision,
      recall,
      f1: caseF1,
    });
  }

  let gradeByCase = new Map();
  if (useAgentGrader) {
    const actualForGrader = new Map(caseRows.map((row) => [row.id, {
      all: row.actual,
      high_risk: row.highRiskActual,
      related: row.relatedActual,
    }]));
    gradeByCase = await runAgentGraders(strategyName, actualForGrader, inputsById);
  }

  const microPrecision = safeDiv(totalTp, totalTp + totalFp);
  const microRecall = safeDiv(totalTp, totalTp + totalFn);
  const microF1 = f1(microPrecision, microRecall);
  const macroCaseF1 = safeDiv(macroF1Sum, total);
  strategyJson.exact = exact;
  strategyJson.total = total;
  strategyJson.exactRate = safeDiv(exact, total);
  strategyJson.patentTotals = {
    tp: totalTp,
    fp: totalFp,
    fn: totalFn,
    precision: microPrecision,
    recall: microRecall,
    f1: microF1,
  };
  strategyJson.macro = {
    caseF1: macroCaseF1,
  };

  const mergedCases = caseRows.map((row) => {
    const grade = gradeByCase.get(row.id);
    const schema = schemaCases.get(row.id) ?? {};
    const extraInRelated = (row.extra ?? []).every((value) => (row.relatedActual ?? []).includes(value));
    const deterministicPass =
      row.highRiskRecall >= 1 &&
      row.requiredRecall >= (gradingSchema.target?.target_recall_goal ?? 0.9) &&
      ((row.extra ?? []).length === 0 || extraInRelated);
    const deterministicCaseScore = deterministicPass
      ? Math.max(row.f1, extraInRelated ? 0.95 : row.requiredRecall)
      : row.f1;
    const merged = {
      ...row,
      pass: grade?.pass ?? deterministicPass,
      directCoverage: grade?.direct_coverage ?? 0,
      familyCoverage: grade?.family_coverage ?? ((schema.family_targets ?? []).length === 0 ? 1 : 0),
      sourceLabelRecall: grade?.source_label_recall ?? row.recall,
      processScore: grade?.process_score ?? 0,
      qualityScore: grade?.quality_score ?? 0,
      riskAnalysisScore: clamp01(grade?.risk_analysis_score ?? 0),
      claimComparisonScore: clamp01(grade?.claim_comparison_score ?? 0),
      legalScopeScore: clamp01(grade?.legal_scope_score ?? 0),
      caseScore: grade?.case_score ?? deterministicCaseScore,
      noneAssessment: grade?.none_assessment ?? "not_applicable",
      processChecks: grade?.process_checks ?? {},
      matchedDirectTargets: grade?.matched_direct_targets ?? [],
      matchedFamilyTargets: grade?.matched_family_targets ?? [],
      matchedSourceLabels: grade?.matched_source_labels ?? [],
      missedDirectTargets: grade?.missed_direct_targets ?? [],
      missedFamilyTargets: grade?.missed_family_targets ?? [],
      missedSourceLabels: grade?.missed_source_labels ?? row.missing,
      gradedPatents: grade?.graded_patents ?? [],
      rationale: grade?.rationale ?? "",
      riskAnalysisNote: grade?.risk_analysis_note ?? "",
    };
    return adjustCaseGrade(merged, schema);
  });

  strategyJson.targetTotals = summarizeTargetCases(mergedCases);

  if (useAgentGrader) {
    strategyJson.grader = summarizeGraderCases(mergedCases);
  }

  strategyJson.cases = mergedCases;
  json.strategies.push(strategyJson);
  const overallScore = strategyJson.grader?.overallScore ?? average(mergedCases.map((row) => row.caseScore ?? 0));

  report.push(`## ${strategyName}`);
  report.push("");
  report.push("| id | expected | high_risk | related | result | score | high_risk_recall | target_recall |");
  report.push("|---|---|---|---|---|---:|---:|---:|");
  publicReport.push(`## ${strategyName}`);
  publicReport.push("");
  publicReport.push("| id | high_risk | related | result | score | high_risk_recall | target_recall |");
  publicReport.push("|---|---|---|---|---:|---:|---:|");

  for (const row of mergedCases) {
    report.push(
      `| ${row.id} | ${(answers.get(row.id) ?? []).join(", ") || "(empty)"} | ${row.highRiskActual.join(", ") || "(empty)"} | ${row.relatedActual.join(", ") || "(empty)"} | ${row.pass ? "PASS" : "FAIL"} | ${formatPct(row.caseScore)} | ${formatPct(row.highRiskRecall)} | ${formatPct(row.requiredRecall)} |`,
    );
    publicReport.push(
      `| ${row.id} | ${row.highRiskActual.join(", ") || "(empty)"} | ${row.relatedActual.join(", ") || "(empty)"} | ${row.pass ? "PASS" : "FAIL"} | ${formatPct(row.caseScore)} | ${formatPct(row.highRiskRecall)} | ${formatPct(row.requiredRecall)} |`,
    );
    if (row.rationale) {
      report.push("");
      report.push(`- ${row.id} rationale: ${row.rationale}`);
    }
    if (row.noneAssessment && row.noneAssessment !== "not_applicable") {
      report.push(`- ${row.id} none_assessment: ${row.noneAssessment}`);
    }
    if (row.riskAnalysisNote) {
      report.push(`- ${row.id} risk_analysis_note: ${row.riskAnalysisNote}`);
    }
    if ((row.missedHighRiskTargets ?? []).length > 0) {
      report.push(`- ${row.id} missed high-risk targets: ${row.missedHighRiskTargets.join(", ")}`);
    }
    if ((row.missedRelatedTargets ?? []).length > 0) {
      report.push(`- ${row.id} missed related targets: ${row.missedRelatedTargets.join(", ")}`);
    }
    if (row.gradedPatents.length > 0) {
      report.push(`- ${row.id} graded outputs: ${row.gradedPatents.map((item) => `${item.patent}:${item.relation}`).join("; ")}`);
    }
  }

  report.push("");
  report.push(`Overall score: ${formatPct(overallScore)}`);
  report.push(`High-risk recall: ${formatPct(strategyJson.targetTotals.highRiskRecall)} (${strategyJson.targetTotals.highRiskMatchedCount}/${strategyJson.targetTotals.highRiskTargetCount})`);
  report.push(`Target recall: ${formatPct(strategyJson.targetTotals.requiredRecall)} (${strategyJson.targetTotals.requiredMatchedCount}/${strategyJson.targetTotals.requiredTargetCount})`);
  report.push(`Target: score >= ${formatPct(gradingSchema.target?.overall_score_goal ?? 0.9)}, high-risk recall >= ${formatPct(gradingSchema.target?.high_risk_recall_goal ?? 0.9)}, target recall >= ${formatPct(gradingSchema.target?.target_recall_goal ?? 0.9)}`);
  report.push("");

  publicReport.push("");
  publicReport.push(`Overall score: ${formatPct(overallScore)}`);
  publicReport.push(`High-risk recall: ${formatPct(strategyJson.targetTotals.highRiskRecall)} (${strategyJson.targetTotals.highRiskMatchedCount}/${strategyJson.targetTotals.highRiskTargetCount})`);
  publicReport.push(`Target recall: ${formatPct(strategyJson.targetTotals.requiredRecall)} (${strategyJson.targetTotals.requiredMatchedCount}/${strategyJson.targetTotals.requiredTargetCount})`);
  publicReport.push(`Target: score >= ${formatPct(gradingSchema.target?.overall_score_goal ?? 0.9)}, high-risk recall >= ${formatPct(gradingSchema.target?.high_risk_recall_goal ?? 0.9)}, target recall >= ${formatPct(gradingSchema.target?.target_recall_goal ?? 0.9)}`);
  publicReport.push("");
}

fs.writeFileSync(reportPath, report.join("\n"), "utf8");
fs.writeFileSync(publicReportPath, publicReport.join("\n"), "utf8");
fs.writeFileSync(jsonPath, `${JSON.stringify(json, null, 2)}\n`, "utf8");
console.log(reportPath);
