import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";

const root = process.cwd();
const datasetDir = path.resolve(process.env.PATENT_DATASET_DIR ?? path.join(root, "dataset"));
const loopDir = path.resolve(process.env.PATENT_LOOP_DIR ?? path.join(root, "tmp", "eval-loop"));
const seedPath = path.resolve(process.env.PATENT_LOOP_SEED ?? path.join(root, "heuristics", "product-patent-risk", "SKILL.md"));
const candidatePath = path.resolve(process.env.PATENT_LOOP_CANDIDATE ?? path.join(loopDir, "current-skill.md"));
const candidateToolsDir = path.resolve(process.env.PATENT_LOOP_TOOLS_DIR ?? path.join(loopDir, "candidate-tools"));
const warmStartFrom = process.env.PATENT_LOOP_WARM_START_FROM
  ? path.resolve(process.env.PATENT_LOOP_WARM_START_FROM)
  : "";
const retrievalExperiment = (process.env.PATENT_LOOP_RETRIEVAL_EXPERIMENT ?? "").trim().toLowerCase();
const inputsPath = path.join(datasetDir, "patent-number-inputs.md");
const answersPath = path.join(datasetDir, "patent-number-answers.md");
const benchmarkPath = path.join(datasetDir, "patent-number-benchmark.md");
const testSetPath = path.join(datasetDir, "test-set.md");
const legacyAnswersPath = path.join(datasetDir, "answers.md");
const caseFilter = new Set(
  (process.env.PATENT_LOOP_CASE_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
const blankSkillStart = process.env.PATENT_LOOP_BLANK_SKILL === "1";
const blankToolsStart = process.env.PATENT_LOOP_BLANK_TOOLS === "1";
const resetWorkspace = process.env.PATENT_LOOP_RESET_WORKSPACE === "1";
const maxIters = Number.parseInt(process.env.PATENT_LOOP_MAX_ITERS ?? "5", 10);
const noProgressLimit = Number.parseInt(process.env.PATENT_LOOP_NO_PROGRESS_LIMIT ?? "2", 10);
const targetExact = process.env.PATENT_LOOP_TARGET_EXACT
  ? Number.parseInt(process.env.PATENT_LOOP_TARGET_EXACT, 10)
  : null;
const targetScore = Number.parseFloat(process.env.PATENT_LOOP_TARGET_SCORE ?? "0.9");
const targetRecall = Number.parseFloat(process.env.PATENT_LOOP_TARGET_RECALL ?? "0.9");
const model = process.env.PATENT_LOOP_MODEL ?? "";
const graderModel = process.env.PATENT_EVAL_GRADER_MODEL ?? model;
const graderParallelism = Math.max(1, Number.parseInt(process.env.PATENT_EVAL_GRADER_PARALLELISM ?? "5", 10));
const reasoningEffort = process.env.PATENT_LOOP_REASONING_EFFORT ?? "";
const applyFinal = process.env.PATENT_LOOP_APPLY === "1";
const skipEvalAgent = process.env.PATENT_LOOP_DRY_RUN === "1";
const codexTimeoutMs = Number.parseInt(process.env.PATENT_LOOP_CODEX_TIMEOUT_MS ?? "900000", 10);
const codexRetries = Math.max(0, Number.parseInt(process.env.PATENT_LOOP_CODEX_RETRIES ?? "1", 10));
const evalParallelism = Number.parseInt(process.env.PATENT_LOOP_EVAL_PARALLELISM ?? "5", 10);
const allowCaseFailures = process.env.PATENT_LOOP_ALLOW_CASE_FAILURES === "1";
const learningJsonPath = path.join(loopDir, "learning.json");
const learningMdPath = path.join(loopDir, "learning.md");
const resultsTsvPath = path.join(loopDir, "results.tsv");
const caseLedgerTsvPath = path.join(loopDir, "case-results.tsv");
const programPath = path.join(loopDir, "program.md");
const bestSkillPath = path.join(loopDir, "best-skill.md");
const bestToolsDir = path.join(loopDir, "best-tools");

fs.mkdirSync(loopDir, { recursive: true });
if (resetWorkspace) {
  resetLoopWorkspace();
}
fs.mkdirSync(candidateToolsDir, { recursive: true });
initializeWorkspace();
ensureToolsReadme();
ensureToolSeeds();
sanitizeToolWorkspace(candidateToolsDir);
ensureProgramFile();
ensureLedgerHeaders();
if (!fs.existsSync(bestSkillPath)) {
  fs.copyFileSync(candidatePath, bestSkillPath);
}
syncDirectory(candidateToolsDir, bestToolsDir);
sanitizeToolWorkspace(bestToolsDir);

const cases = parseInputCases(fs.readFileSync(inputsPath, "utf8")).filter((item) => caseFilter.size === 0 || caseFilter.has(item.id));
const logPath = path.join(loopDir, "loop-log.md");
const log = [];
log.push("# Patent Eval Loop Log");
log.push("");
log.push(`Started: ${new Date().toISOString()}`);
log.push(`Seed: ${seedPath}`);
log.push(`Candidate: ${candidatePath}`);
log.push(`Candidate tools: ${candidateToolsDir}`);
if (warmStartFrom) log.push(`Warm start: ${warmStartFrom}`);
if (blankSkillStart) log.push("Blank skill start: enabled");
if (blankToolsStart) log.push("Blank tools start: enabled");
if (resetWorkspace) log.push("Workspace reset: enabled");
if (retrievalExperiment) log.push(`Retrieval experiment: ${retrievalExperiment}`);
log.push(`Cases: ${cases.map((c) => c.id).join(", ")}`);
log.push(`Eval parallelism: ${evalParallelism}`);
log.push(`Grader parallelism: ${graderParallelism}`);
log.push(`Eval model: ${model || "Codex CLI default"}`);
log.push(`Grader model: ${graderModel || "Codex CLI default"}`);
log.push(`Reasoning effort: ${reasoningEffort || "Codex CLI/profile default"}`);
log.push(`Codex retries: ${codexRetries}`);
log.push(`Allow case failures: ${allowCaseFailures ? "enabled" : "disabled"}`);
log.push(`Max iterations: ${maxIters}`);
log.push(`Target score: ${targetScore}`);
log.push(`Target recall: ${targetRecall}`);
log.push("");

let bestGraderScore = -1;
let bestPatentF1 = -1;
let bestExact = -1;
let bestMacroCaseF1 = -1;
let bestIter = 0;
let noProgress = 0;
let lastScore = null;
let candidateDescription = "baseline";

await main();

async function main() {
for (let iter = 1; iter <= maxIters; iter++) {
  const iterDir = path.join(loopDir, `iter-${String(iter).padStart(3, "0")}`);
  fs.mkdirSync(iterDir, { recursive: true });
  log.push(`## Iteration ${iter}`);
  log.push("");

  if (skipEvalAgent) {
    for (const item of cases) {
      const caseDir = path.join(iterDir, item.id);
      fs.mkdirSync(caseDir, { recursive: true });
      fs.writeFileSync(path.join(caseDir, "outputs.md"), `## ${item.id}\n\`\`\`text\nHIGH_RISK:\nNONE\n\nRELATED:\nNONE\n\`\`\`\n`, "utf8");
      fs.writeFileSync(path.join(caseDir, "trace.md"), "Dry run placeholder.\n", "utf8");
    }
  } else {
    await runCasesInParallel(iter, iterDir);
  }

  assembleIterationOutputs(iterDir, cases);
  runScore(iterDir);
  const score = readScore(path.join(iterDir, "score-report.json"));
  lastScore = score;
  writeLearningArtifacts(loopDir);

  const strategy = score.strategies[0];
  const exact = strategy?.exact ?? 0;
  const total = strategy?.total ?? 0;
  const graderScore = strategy?.grader?.overallScore ?? strategy?.patentTotals?.f1 ?? 0;
  const patentF1 = strategy?.patentTotals?.f1 ?? 0;
  const macroCaseF1 = strategy?.macro?.caseF1 ?? 0;
  const highRiskRecall = strategy?.targetTotals?.highRiskRecall ?? 0;
  const requiredRecall = strategy?.targetTotals?.requiredRecall ?? strategy?.patentTotals?.recall ?? 0;
  const target = targetExact ?? total;
  const improved =
    graderScore > bestGraderScore ||
    (graderScore === bestGraderScore && patentF1 > bestPatentF1) ||
    (graderScore === bestGraderScore && patentF1 === bestPatentF1 && exact > bestExact) ||
    (graderScore === bestGraderScore && patentF1 === bestPatentF1 && exact === bestExact && macroCaseF1 > bestMacroCaseF1);
  const status = improved ? "keep" : "discard";
  log.push(`Score: overall_score=${graderScore.toFixed(4)}, high_risk_recall=${highRiskRecall.toFixed(4)}, target_recall=${requiredRecall.toFixed(4)}`);
  log.push(`Status: ${status}`);
  log.push("");

  appendResultsRow(iter, graderScore, highRiskRecall, requiredRecall, status, candidateDescription);
  appendCaseLedgerRows(iter, strategy?.cases ?? []);

  if (status === "keep") {
    bestGraderScore = graderScore;
    bestPatentF1 = patentF1;
    bestExact = exact;
    bestMacroCaseF1 = macroCaseF1;
    bestIter = iter;
    noProgress = 0;
    fs.copyFileSync(candidatePath, bestSkillPath);
    syncDirectory(candidateToolsDir, bestToolsDir);
  } else {
    noProgress += 1;
    restoreBestWorkspace();
  }

  if (targetExact !== null && exact >= target && total > 0) {
    log.push(`Target reached at iteration ${iter}.`);
    log.push("");
    break;
  }
  if (targetExact === null && graderScore >= targetScore && highRiskRecall >= targetRecall && requiredRecall >= targetRecall) {
    log.push(`Target reached at iteration ${iter}: score and recall thresholds met.`);
    log.push("");
    break;
  }
  if (iter === maxIters) {
    log.push("Stopped: reached max iterations.");
    log.push("");
    break;
  }
  if (noProgress >= noProgressLimit) {
    log.push(`Stopped: no score progress for ${noProgressLimit} iteration(s).`);
    log.push("");
    break;
  }

  runCodex(builderPrompt(iter, iterDir), path.join(iterDir, "builder-agent.log"));
  candidateDescription = summarizeBuilderNote(path.join(iterDir, "builder-notes.md"));
}

log.push("## Final");
log.push("");
log.push(`Best overall_score: ${bestGraderScore.toFixed(4)}`);
log.push(`Best iteration: ${bestIter}`);
log.push("");

if (applyFinal && fs.existsSync(bestSkillPath)) {
  fs.copyFileSync(bestSkillPath, seedPath);
  log.push(`Applied best skill to ${seedPath}`);
  log.push("");
}

fs.writeFileSync(logPath, log.join("\n"), "utf8");
console.log(logPath);
}

function initializeWorkspace() {
  const warmSkill = resolveWarmStartSkillPath();
  const warmTools = resolveWarmStartToolsDir();
  if (!fs.existsSync(candidatePath)) {
    if (blankSkillStart) {
      fs.writeFileSync(candidatePath, blankSkillTemplate(), "utf8");
    } else if (warmSkill) {
      fs.copyFileSync(warmSkill, candidatePath);
    } else {
      fs.copyFileSync(seedPath, candidatePath);
    }
  }
  if (!blankToolsStart && !dirHasFiles(candidateToolsDir) && warmTools) {
    syncDirectory(warmTools, candidateToolsDir);
  }
}

function ensureToolsReadme() {
  if (blankToolsStart) return;
  const toolsReadmePath = path.join(candidateToolsDir, "README.md");
  if (!fs.existsSync(toolsReadmePath)) {
    fs.writeFileSync(
      toolsReadmePath,
      `# Candidate Patent Tools

Keep tools small and deterministic.

Good:
- query planning
- patent-page parsing
- lightweight ranking / evidence scoring
- backend adapters for low-cost search
- simple page parsing
- normalization
- evidence JSON formatting

Avoid:
- embedding answer-key logic
- giant policy engines
- combining retrieval and final scoring in one script

Seeded helpers:
- \`query_pack.py\` for exact-anchor query planning
- \`google_patents_parser.py\` for local page parsing of Google Patents records
- \`claim_risk_matrix.py\` for product-feature to patent-claim/status comparison
`,
      "utf8",
    );
  }
}

function ensureToolSeeds() {
  if (blankToolsStart) return;
  const queryPackPath = path.join(candidateToolsDir, "query_pack.py");
  const parserPath = path.join(candidateToolsDir, "google_patents_parser.py");
  const matrixPath = path.join(candidateToolsDir, "claim_risk_matrix.py");
  if (!fs.existsSync(queryPackPath)) {
    fs.writeFileSync(queryPackPath, defaultQueryPackPy(), "utf8");
  }
  if (!fs.existsSync(parserPath)) {
    const source = path.join(root, "scripts", "google_patents_parser.py");
    if (fs.existsSync(source)) fs.copyFileSync(source, parserPath);
    else fs.writeFileSync(parserPath, defaultGooglePatentsParserPy(), "utf8");
  }
  if (!fs.existsSync(matrixPath)) {
    const source = path.join(root, "scripts", "claim_risk_matrix.py");
    if (fs.existsSync(source)) fs.copyFileSync(source, matrixPath);
  }
}

function sanitizeToolWorkspace(dir) {
  if (!fs.existsSync(dir)) return;
  for (const name of [
    "google_patents_bigquery.py",
    "audit-family-pack.json",
    "query-pack-validation.json",
    "query_pack-validation.json",
    "query_pack_validation.json",
    "query_pack_validation_variant.json",
  ]) {
    const target = path.join(dir, name);
    if (fs.existsSync(target)) fs.rmSync(target, { force: true, recursive: true });
  }
}

function resetLoopWorkspace() {
  for (const target of [
    candidatePath,
    bestSkillPath,
    resultsTsvPath,
    caseLedgerTsvPath,
    learningJsonPath,
    learningMdPath,
    programPath,
    path.join(loopDir, "loop-log.md"),
  ]) {
    if (fs.existsSync(target)) fs.rmSync(target, { force: true, recursive: true });
  }
  for (const dir of [candidateToolsDir, bestToolsDir]) {
    if (fs.existsSync(dir)) fs.rmSync(dir, { force: true, recursive: true });
  }
  for (const entry of fs.readdirSync(loopDir, { withFileTypes: true })) {
    if (entry.isDirectory() && /^iter-\d+$/.test(entry.name)) {
      fs.rmSync(path.join(loopDir, entry.name), { force: true, recursive: true });
    }
  }
}

function ensureProgramFile() {
  if (fs.existsSync(programPath)) return;
  fs.writeFileSync(
    programPath,
    `# Patent Autoresearch Program

This loop follows a simple keep/discard discipline.

## Editable surface

- \`current-skill.md\`
- small deterministic tools under \`candidate-tools/\`

## Goal

Raise patent-level benchmark score and recall without leaking the answer key.
Keep benchmark recall separate from analyst risk quality: useful claim-risk findings should be visible even when source-label recall fails.

## Loop

1. Evaluate the current candidate on all cases.
2. Score the run.
3. Record one row in \`results.tsv\`.
4. If score improved, keep the candidate as the new best.
5. If score did not improve, discard it and restore the previous best workspace.
6. Builder proposes the next experiment from the kept baseline.

## Builder discipline

- Make at most one skill change and one tool change per round.
- Keep tools small. Retrieval/query planning is allowed; hidden answer logic is not.
- Prefer structured evidence over broader search.
- Require product identity lock, claim/status comparison, jurisdiction/status discipline, and final bucket verification before broad acceptance.
- Use \`results.tsv\`, \`case-results.tsv\`, and \`learning.md\` to avoid repeating failed moves.
- If one unresolved case keeps surfacing plausible patent families and then rejecting them, treat that as an acceptance-policy problem before treating it as a retrieval problem.
- Do not loosen acceptance globally just to fix one thin storefront or white-label case. If a second acceptance regime is needed, isolate it narrowly to that failure mode so exact-product cases do not regress.
- Preserve the bucketed output contract: \`HIGH_RISK\` for strong product/risk matches and \`RELATED\` for supported weaker matches.
- The benchmark target is near 90% score/recall; missing configured targets is worse than including extra supported related context.
`,
    "utf8",
  );
}

function ensureLedgerHeaders() {
  if (!fs.existsSync(resultsTsvPath)) {
    fs.writeFileSync(resultsTsvPath, "iteration\toverall_score\thigh_risk_recall\ttarget_recall\tstatus\tdescription\n", "utf8");
  }
  if (!fs.existsSync(caseLedgerTsvPath)) {
    fs.writeFileSync(
      caseLedgerTsvPath,
      "iteration\tcase_id\tpass\tcase_score\thigh_risk_recall\ttarget_recall\tactual\n",
      "utf8",
    );
  }
}

function parseInputCases(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\| (PN-\d{3}) \| (.*?) \| `(.*?)` \|$/);
    if (!match) continue;
    out.push({ id: match[1], task: match[2], input: match[3] });
  }
  return out;
}

function runCodex(prompt, outLog) {
  const { cmd, prefixArgs } = resolveCodexInvocation();
  const args = [...prefixArgs, "exec", "-C", root, "-s", "danger-full-access"];
  if (model) args.push("-m", model);
  if (reasoningEffort) args.push("-c", `model_reasoning_effort="${reasoningEffort}"`);
  args.push("-");

  let lastError = null;
  for (let attempt = 1; attempt <= codexRetries + 1; attempt++) {
    const attemptLog = codexAttemptLogPath(outLog, attempt);
    const started = new Date().toISOString();
    const result = spawnSync(cmd, args, {
      cwd: root,
      input: prompt,
      encoding: "utf8",
      shell: false,
      maxBuffer: 50 * 1024 * 1024,
      env: { ...process.env },
      timeout: codexTimeoutMs,
    });
    const error = result.status === 0 ? null : new Error(`codex exec failed with code=${result.status ?? ""} signal=${result.signal ?? ""}`);
    writeCodexLog(attemptLog, started, result.status, result.signal, result.error ?? error, result.stdout, result.stderr);
    if (result.status === 0) {
      if (attemptLog !== outLog) fs.copyFileSync(attemptLog, outLog);
      return;
    }
    lastError = result.error ?? error;
    if (attempt <= codexRetries) {
      fs.appendFileSync(outLog, `\nRetrying Codex exec after failed attempt ${attempt}; see ${attemptLog}\n`, "utf8");
    }
  }
  throw new Error(`codex exec failed after ${codexRetries + 1} attempt(s); see ${outLog}: ${lastError}`);
}

async function runCasesInParallel(iter, iterDir) {
  const queue = [...cases];
  const workers = Array.from({ length: Math.min(evalParallelism, cases.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) return;
      const caseDir = path.join(iterDir, item.id);
      fs.mkdirSync(caseDir, { recursive: true });
      try {
        await runCodexAsync(evalPrompt(iter, iterDir, item), path.join(caseDir, "eval-agent.log"));
      } catch (error) {
        if (!allowCaseFailures) throw error;
        writeCaseFailureArtifacts(caseDir, item, error);
      }
    }
  });
  await Promise.all(workers);
}

async function runCodexAsync(prompt, outLog) {
  let lastError = null;
  for (let attempt = 1; attempt <= codexRetries + 1; attempt++) {
    const attemptLog = codexAttemptLogPath(outLog, attempt);
    try {
      await runCodexAsyncOnce(prompt, attemptLog);
      if (attemptLog !== outLog) fs.copyFileSync(attemptLog, outLog);
      return;
    } catch (error) {
      lastError = error;
      if (attempt <= codexRetries) {
        fs.appendFileSync(outLog, `\nRetrying Codex exec after failed attempt ${attempt}; see ${attemptLog}\n`, "utf8");
      }
    }
  }
  throw lastError;
}

function runCodexAsyncOnce(prompt, outLog) {
  const { cmd, prefixArgs } = resolveCodexInvocation();
  const args = [...prefixArgs, "exec", "-C", root, "-s", "danger-full-access"];
  if (model) args.push("-m", model);
  if (reasoningEffort) args.push("-c", `model_reasoning_effort="${reasoningEffort}"`);
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
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      child.kill("SIGTERM");
    }, codexTimeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      writeCodexLog(outLog, started, null, "", err, stdout, stderr);
      reject(err);
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const error = code === 0 ? null : new Error(`codex exec failed with code=${code ?? ""} signal=${signal ?? ""}`);
      writeCodexLog(outLog, started, code, signal, error, stdout, stderr);
      if (code === 0) resolve();
      else reject(error);
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

function writeCaseFailureArtifacts(caseDir, item, error) {
  const outputPath = path.join(caseDir, "outputs.md");
  const tracePath = path.join(caseDir, "trace.md");
  if (!fs.existsSync(outputPath)) {
    fs.writeFileSync(
      outputPath,
      `## ${item.id}\n\`\`\`text\nHIGH_RISK:\nNONE\n\nRELATED:\nNONE\n\`\`\`\n`,
      "utf8",
    );
  }
  if (!fs.existsSync(tracePath)) {
    fs.writeFileSync(
      tracePath,
      [
        "# Case Runner Failure",
        "",
        `Case: ${item.id}`,
        `Input: ${item.input}`,
        `Error: ${String(error)}`,
        "",
        "The Codex child failed after configured retries. This placeholder preserves the loop run and lets the grader count the case as a miss instead of aborting all other parallel cases.",
        "",
      ].join("\n"),
      "utf8",
    );
  }
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

function assembleIterationOutputs(iterDir, items) {
  const outputParts = [];
  const traceParts = [];
  for (const item of items) {
    const caseDir = path.join(iterDir, item.id);
    const outputPath = path.join(caseDir, "outputs.md");
    const tracePath = path.join(caseDir, "trace.md");
    if (fs.existsSync(outputPath)) outputParts.push(fs.readFileSync(outputPath, "utf8").trim());
    if (fs.existsSync(tracePath)) traceParts.push(`## ${item.id}\n${fs.readFileSync(tracePath, "utf8").trim()}`);
  }
  fs.writeFileSync(path.join(iterDir, "strategy-loop-outputs.md"), `${outputParts.join("\n\n")}\n`, "utf8");
  fs.writeFileSync(path.join(iterDir, "strategy-loop-trace.md"), `${traceParts.join("\n\n")}\n`, "utf8");
}

function runScore(iterDir) {
  const nodeCmd = process.execPath;
  const result = spawnSync(nodeCmd, ["scripts/score-patent-eval.mjs"], {
    cwd: root,
    encoding: "utf8",
    shell: false,
    env: {
      ...process.env,
      PATENT_DATASET_DIR: datasetDir,
      PATENT_EVAL_RUN_DIR: iterDir,
      PATENT_EVAL_REPORT_PATH: path.join(iterDir, "score-report.md"),
      PATENT_EVAL_PUBLIC_REPORT_PATH: path.join(iterDir, "score-report.public.md"),
      PATENT_EVAL_JSON_PATH: path.join(iterDir, "score-report.json"),
      PATENT_EVAL_CASE_IDS: cases.map((item) => item.id).join(","),
      PATENT_EVAL_GRADER_MODEL: graderModel,
      PATENT_EVAL_GRADER_PARALLELISM: String(graderParallelism),
      PATENT_EVAL_GRADER_REASONING_EFFORT: reasoningEffort,
    },
  });
  if (result.status !== 0) {
    throw new Error(`score script failed:\n${result.stderr}`);
  }
}

function readScore(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeLearningArtifacts(baseDir) {
  const iterDirs = fs
    .readdirSync(baseDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^iter-\d+$/.test(d.name))
    .map((d) => path.join(baseDir, d.name))
    .sort();

  const history = new Map();
  for (const item of cases) {
    history.set(item.id, { task: item.task, scores: [], lastActual: [], passes: 0 });
  }

  for (const iterDir of iterDirs) {
    const jsonFile = path.join(iterDir, "score-report.json");
    if (!fs.existsSync(jsonFile)) continue;
    const report = JSON.parse(fs.readFileSync(jsonFile, "utf8"));
    const strategy = report.strategies[0];
    if (!strategy) continue;
    for (const caseRow of strategy.cases ?? []) {
      const rec = history.get(caseRow.id);
      if (!rec) continue;
      rec.scores.push({
        pass: caseRow.pass,
        caseScore: caseRow.caseScore ?? 0,
        highRiskRecall: caseRow.highRiskRecall ?? 0,
        requiredRecall: caseRow.requiredRecall ?? 0,
        directCoverage: caseRow.directCoverage ?? 0,
        sourceLabelRecall: caseRow.sourceLabelRecall ?? 0,
        riskAnalysisScore: caseRow.riskAnalysisScore ?? 0,
        claimComparisonScore: caseRow.claimComparisonScore ?? 0,
        legalScopeScore: caseRow.legalScopeScore ?? 0,
        qualityScore: caseRow.qualityScore ?? 0,
        truePositiveCount: caseRow.truePositiveCount ?? 0,
        missingCount: caseRow.missingCount ?? 0,
        extraCount: caseRow.extraCount ?? (caseRow.extra ?? []).length,
        precision: caseRow.precision ?? 0,
        recall: caseRow.recall ?? 0,
        f1: caseRow.f1 ?? 0,
        extra: caseRow.extra ?? [],
        actual: caseRow.actual ?? [],
      });
      rec.lastActual = caseRow.actual;
      if (caseRow.pass) rec.passes += 1;
    }
  }

  const json = {};
  const md = ["# Eval Learning", ""];
  for (const [id, rec] of history) {
    const passCount = rec.passes;
    const total = rec.scores.length;
    const latest = rec.scores.at(-1) ?? {
      pass: false,
      caseScore: 0,
      highRiskRecall: 0,
      requiredRecall: 0,
      directCoverage: 0,
      sourceLabelRecall: 0,
      riskAnalysisScore: 0,
      claimComparisonScore: 0,
      legalScopeScore: 0,
      qualityScore: 0,
      truePositiveCount: 0,
      missingCount: 0,
      extraCount: 0,
      precision: 0,
      recall: 0,
      f1: 0,
      extra: [],
      actual: [],
    };
    json[id] = {
      task: rec.task,
      passCount,
      totalRuns: total,
      latestActual: rec.lastActual,
      latestPass: latest.pass,
      latestCaseScore: latest.caseScore,
      latestHighRiskRecall: latest.highRiskRecall,
      latestRequiredRecall: latest.requiredRecall,
      latestDirectCoverage: latest.directCoverage,
      latestSourceLabelRecall: latest.sourceLabelRecall,
      latestRiskAnalysisScore: latest.riskAnalysisScore,
      latestClaimComparisonScore: latest.claimComparisonScore,
      latestLegalScopeScore: latest.legalScopeScore,
      latestQualityScore: latest.qualityScore,
      latestTruePositiveCount: latest.truePositiveCount,
      latestMissingCount: latest.missingCount,
      latestExtraCount: latest.extraCount,
      latestPrecision: latest.precision,
      latestRecall: latest.recall,
      latestF1: latest.f1,
      latestExtra: latest.extra,
    };
    md.push(`## ${id}`);
    md.push(`- task: ${rec.task}`);
    md.push(`- passes: ${passCount}/${total}`);
    md.push(`- latest actual: ${rec.lastActual.join(", ") || "(empty)"}`);
    md.push(`- latest case_score: ${latest.caseScore.toFixed(4)}`);
    md.push(`- latest high_risk_recall: ${latest.highRiskRecall.toFixed(4)}`);
    md.push(`- latest target_recall: ${latest.requiredRecall.toFixed(4)}`);
    if (passCount === 0) md.push(`- status: unresolved`);
    else if (passCount < total) md.push(`- status: unstable`);
    else md.push(`- status: stable`);
    md.push("");
  }

  fs.writeFileSync(learningJsonPath, `${JSON.stringify(json, null, 2)}\n`, "utf8");
  fs.writeFileSync(learningMdPath, `${md.join("\n")}\n`, "utf8");
}

function appendResultsRow(iteration, graderScore, highRiskRecall, targetRecallValue, status, description) {
  const safeDescription = sanitizeTsv(description);
  fs.appendFileSync(
    resultsTsvPath,
    `${iteration}\t${graderScore.toFixed(6)}\t${highRiskRecall.toFixed(6)}\t${targetRecallValue.toFixed(6)}\t${status}\t${safeDescription}\n`,
    "utf8",
  );
}

function appendCaseLedgerRows(iteration, caseRows) {
  for (const row of caseRows) {
    const actual = sanitizeTsv((row.actual ?? []).join(", "));
    fs.appendFileSync(
      caseLedgerTsvPath,
      `${iteration}\t${row.id}\t${row.pass ? 1 : 0}\t${(row.caseScore ?? 0).toFixed(6)}\t${(row.highRiskRecall ?? 0).toFixed(6)}\t${(row.requiredRecall ?? 0).toFixed(6)}\t${actual}\n`,
      "utf8",
    );
  }
}

function sanitizeTsv(value) {
  return String(value ?? "").replace(/\t/g, " ").replace(/\r?\n/g, " ").trim();
}

function resolveWarmStartSkillPath() {
  if (!warmStartFrom) return "";
  const candidates = [
    path.join(warmStartFrom, "best-skill.md"),
    path.join(warmStartFrom, "current-skill.md"),
  ];
  return candidates.find((file) => fs.existsSync(file)) ?? "";
}

function resolveWarmStartToolsDir() {
  if (!warmStartFrom) return "";
  const candidates = [
    path.join(warmStartFrom, "best-tools"),
    path.join(warmStartFrom, "candidate-tools"),
  ];
  return candidates.find((dir) => dirHasFiles(dir)) ?? "";
}

function dirHasFiles(dir) {
  if (!dir || !fs.existsSync(dir)) return false;
  return fs.readdirSync(dir).length > 0;
}

function summarizeBuilderNote(file) {
  if (!fs.existsSync(file)) return "builder change";
  const lines = fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return "builder change";
  return lines[0].replace(/^[-*]\s*/, "");
}

function restoreBestWorkspace() {
  if (fs.existsSync(bestSkillPath)) {
    fs.copyFileSync(bestSkillPath, candidatePath);
  }
  if (fs.existsSync(bestToolsDir)) {
    syncDirectory(bestToolsDir, candidateToolsDir);
  }
}

function syncDirectory(sourceDir, targetDir) {
  if (!fs.existsSync(sourceDir)) return;
  fs.rmSync(targetDir, { recursive: true, force: true });
  copyDirectoryRecursive(sourceDir, targetDir);
}

function copyDirectoryRecursive(sourceDir, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const src = path.join(sourceDir, entry.name);
    const dst = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      copyDirectoryRecursive(src, dst);
    } else if (entry.isFile()) {
      fs.copyFileSync(src, dst);
    }
  }
}

function defaultQueryPackPy() {
  return `#!/usr/bin/env python3
"""Build a compact, answer-free query plan for one patent-search case.

This tool is intentionally simple. It does not decide the final patent output.
It only turns known anchors into a small deterministic search plan.
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path


TASKS = {
    "extract": "product-page patent extraction",
    "fallback": "product-page patent extraction plus fallback search if needed",
    "variant": "same-product variant / continuation check",
    "family": "product-page patent extraction plus family signal detection",
}


def uniq(values: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for value in values:
        cleaned = " ".join((value or "").split()).strip()
        if cleaned and cleaned not in seen:
            seen.add(cleaned)
            out.append(cleaned)
    return out


def split_words(value: str) -> list[str]:
    return re.findall(r"[A-Za-z0-9]+", value or "")


def phrase_variants(value: str) -> list[str]:
    cleaned = " ".join((value or "").split()).strip()
    if not cleaned:
        return []
    variants = [cleaned]
    compact = re.sub(r"[^A-Za-z0-9]+", " ", cleaned).strip()
    compact = " ".join(compact.split())
    if compact and compact not in variants:
        variants.append(compact)
    return uniq(variants)


def model_codes(*values: str) -> list[str]:
    out: list[str] = []
    for value in values:
        for token in re.findall(r"[A-Za-z0-9-]+", value or ""):
            if len(token) < 4:
                continue
            has_alpha = any(c.isalpha() for c in token)
            has_digit = any(c.isdigit() for c in token)
            if has_alpha and has_digit:
                out.append(token)
                compact = re.sub(r"[^A-Za-z0-9]", "", token)
                if compact != token:
                    out.append(compact)
    return uniq(out)


def short_feature_shards(features: list[str]) -> list[str]:
    shards: list[str] = []
    for feature in features[:3]:
        words = split_words(feature)
        if len(words) >= 2:
            shards.append(" ".join(words[:2]))
            shards.append(" ".join(words[-2:]))
        if len(words) >= 3:
            shards.append(" ".join(words[:3]))
    return uniq(shards)


def make_queries(
    task: str,
    brand: str,
    product: str,
    model: str,
    seller: str,
    legal_owner: str,
    features: list[str],
    extra_entities: list[str],
    doc_anchors: list[str],
) -> list[str]:
    entities = uniq(
        phrase_variants(brand)
        + phrase_variants(seller)
        + phrase_variants(legal_owner)
        + [alias for item in extra_entities for alias in phrase_variants(item)]
    )
    product_terms = phrase_variants(product)
    model_terms = uniq(phrase_variants(model) + model_codes(model, product, *doc_anchors))
    doc_terms = uniq([alias for item in doc_anchors for alias in phrase_variants(item)])
    feature_terms = short_feature_shards(features)

    queries: list[str] = []

    for term in product_terms[:3]:
        queries.extend(
            [
                f'"{term}" patent',
                f'"{term}" "patent pending"',
                f'"{term}" "patent number"',
                f'"{term}" "protected by"',
                f'Google Patents "{term}"',
            ]
        )

    for term in model_terms[:6]:
        queries.extend(
            [
                f'"{term}" patent',
                f'"{term}" "patent pending"',
                f'"{term}" "published application"',
                f'"{term}" "application granted"',
                f'Google Patents "{term}"',
            ]
        )

    for entity in entities[:6]:
        for term in product_terms[:2] + model_terms[:3]:
            queries.extend(
                [
                    f'"{entity}" "{term}" patent',
                    f'"{entity}" "{term}" "patent pending"',
                    f'Google Patents "{entity}" "{term}"',
                ]
            )

    for doc in doc_terms[:6]:
        for term in model_terms[:3] + product_terms[:2]:
            queries.extend(
                [
                    f'"{doc}" "{term}" patent',
                    f'"{doc}" "{term}" "published application"',
                    f'Google Patents "{doc}" "{term}"',
                ]
            )

    for shard in feature_terms[:6]:
        queries.extend(
            [
                f'"{shard}" patent',
                f'Google Patents "{shard}"',
            ]
        )
        for entity in entities[:4]:
            queries.append(f'"{entity}" "{shard}" patent')

    if task in {"fallback", "variant", "family"}:
        for term in product_terms[:2] + model_terms[:4]:
            queries.extend(
                [
                    f'"{term}" "publication of"',
                    f'"{term}" "granted as"',
                    f'"{term}" "also published as"',
                ]
            )

    if task == "variant":
        for term in product_terms[:2] + model_terms[:3]:
            queries.extend(
                [
                    f'"{term}" continuation patent',
                    f'"{term}" divisional patent',
                ]
            )

    if task == "family":
        for term in product_terms[:2] + model_terms[:3]:
            queries.extend(
                [
                    f'"{term}" patent family',
                    f'"{term}" continuation family',
                ]
            )

    return uniq(queries)


def make_checks(task: str) -> list[str]:
    checks = [
        "Extract product anchors first: product title, model/ASIN, seller/manufacturer, legal owner, manuals/support links.",
        "Prefer product-page, manual, package, and official support evidence over generic patent similarity.",
        "Normalize patent numbers only after verification.",
    ]
    if task in {"extract", "fallback", "variant"}:
        checks.append("If the first hit is a design patent, do one same-product utility/application search pass before final output.")
        checks.append("If one side of a publication/grant pair is found, search the direct counterpart before stopping.")
    if task == "fallback":
        checks.append("If the product says patent pending, search exact model + manual/support anchors before returning NONE.")
    if task == "variant":
        checks.append("Prefer the closest same-product publication/grant pair over broader sibling family members.")
    if task == "family":
        checks.append("Recover one exact-product anchor first, then run one bounded family check.")
    return checks


def build_payload(args: argparse.Namespace) -> dict:
    features = uniq(args.feature or [])
    extra_entities = uniq(args.extra_entity or [])
    doc_anchors = uniq(args.doc_anchor or [])
    return {
        "task_mode": TASKS[args.task],
        "anchors": {
            "brand": args.brand or "",
            "product": args.product or "",
            "model": args.model or "",
            "seller": args.seller or "",
            "legal_owner": args.legal_owner or "",
            "features": features,
            "extra_entities": extra_entities,
            "doc_anchors": doc_anchors,
        },
        "queries": make_queries(
            task=args.task,
            brand=args.brand or "",
            product=args.product or "",
            model=args.model or "",
            seller=args.seller or "",
            legal_owner=args.legal_owner or "",
            features=features,
            extra_entities=extra_entities,
            doc_anchors=doc_anchors,
        ),
        "checks": make_checks(args.task),
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--task", choices=sorted(TASKS), required=True)
    parser.add_argument("--brand", default="")
    parser.add_argument("--product", default="")
    parser.add_argument("--model", default="")
    parser.add_argument("--seller", default="")
    parser.add_argument("--legal-owner", dest="legal_owner", default="")
    parser.add_argument("--feature", action="append")
    parser.add_argument("--extra-entity", action="append")
    parser.add_argument("--doc-anchor", action="append")
    parser.add_argument("--out", default="")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    payload = build_payload(args)
    rendered = json.dumps(payload, indent=2, ensure_ascii=True)
    if args.out:
        out_path = Path(args.out)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(rendered + "\\n", encoding="utf-8")
    else:
        print(rendered)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
`;
}

function defaultGooglePatentsParserPy() {
  return `#!/usr/bin/env python3
"""Fetch and parse a Google Patents page into compact JSON."""

from __future__ import annotations

import argparse
import json
import re
from html import unescape
from html.parser import HTMLParser
from urllib.request import Request, urlopen


PATENT_RE = re.compile(r"\\b(?:US|USD|WO|EP|JP|KR|CN)\\s?[0-9][0-9A-Z,/ -]{4,}\\b")


class TextCollector(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.parts: list[str] = []

    def handle_data(self, data: str) -> None:
        if data:
            self.parts.append(data)


def normalize_space(value: str) -> str:
    return " ".join((value or "").split()).strip()


def normalize_patent(value: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", (value or "").upper())


def fetch_text(url: str) -> str:
    req = Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 PatentLawless/1.0",
            "Accept-Language": "en-US,en;q=0.9",
        },
    )
    with urlopen(req, timeout=30) as resp:
        return resp.read().decode("utf-8", errors="replace")


def extract_json_ld(html: str) -> list[dict]:
    blobs = re.findall(
        r"<script[^>]+type=[\"']application/ld\\+json[\"'][^>]*>(.*?)</script>",
        html,
        flags=re.I | re.S,
    )
    out: list[dict] = []
    for blob in blobs:
        try:
            parsed = json.loads(unescape(blob))
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            out.append(parsed)
        elif isinstance(parsed, list):
            out.extend(item for item in parsed if isinstance(item, dict))
    return out


def strip_text(html: str) -> str:
    collector = TextCollector()
    collector.feed(html)
    return normalize_space(unescape(" ".join(collector.parts)))


def collect_patents(*values: str) -> list[str]:
    found: list[str] = []
    seen: set[str] = set()
    for value in values:
        for match in PATENT_RE.findall(value or ""):
            normalized = normalize_patent(match)
            if len(normalized) < 6 or normalized in seen:
                continue
            seen.add(normalized)
            found.append(normalized)
    return found


def parse_page(html: str, url: str) -> dict:
    json_ld = extract_json_ld(html)
    text = strip_text(html)
    title_match = re.search(r"<title>(.*?)</title>", html, flags=re.I | re.S)
    title = normalize_space(unescape(title_match.group(1))) if title_match else ""
    ld = json_ld[0] if json_ld else {}
    inventors = ld.get("inventor", []) if isinstance(ld.get("inventor"), list) else []
    assignee = ld.get("assignee", [])
    if not isinstance(assignee, list):
        assignee = [assignee] if assignee else []
    payload = {
        "url": url,
        "title": title,
        "publication_number": normalize_patent(str(ld.get("publicationNumber", ""))),
        "grant_number": normalize_patent(str(ld.get("grantNumber", ""))),
        "filing_date": ld.get("filingDate", ""),
        "publication_date": ld.get("publicationDate", ""),
        "assignee": [normalize_space(str(item)) for item in assignee if normalize_space(str(item))],
        "inventors": [normalize_space(str(item)) for item in inventors if normalize_space(str(item))],
        "patent_mentions": collect_patents(text),
        "family_mentions": collect_patents(" ".join(re.findall(r"family[^<]{0,300}", html, flags=re.I))),
        "counterpart_hints": collect_patents(" ".join(re.findall(r"(?:publication of|granted as|also published as)[^<]{0,240}", html, flags=re.I))),
        "text_excerpt": text[:4000],
    }
    return payload


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", help="Google Patents URL to fetch.")
    parser.add_argument("--patent", help="Patent identifier to fetch from patents.google.com.")
    parser.add_argument("--pretty", action="store_true", help="Pretty-print JSON.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not args.url and not args.patent:
        raise SystemExit("Provide --url or --patent")
    url = args.url or f"https://patents.google.com/patent/{normalize_patent(args.patent)}/en"
    payload = parse_page(fetch_text(url), url)
    if args.pretty:
        print(json.dumps(payload, indent=2, ensure_ascii=True))
    else:
        print(json.dumps(payload, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
`;
}

function blankSkillTemplate() {
  return `# Blank Patent Skill

No baseline procedure is provided for this run.

Goal:
- given one case input, return supported patent identifiers in HIGH_RISK and RELATED buckets

Constraints:
- do not invent patent numbers
- output \`HIGH_RISK:\` and \`RELATED:\` headings
- put credible but weaker candidates under \`RELATED\` instead of omitting them
- output \`NONE\` in an empty bucket
`;
}

function evalPrompt(iter, iterDir, item) {
  const caseDir = path.join(iterDir, item.id);
  const out = path.join(caseDir, "outputs.md");
  const trace = path.join(caseDir, "trace.md");
  const retrievalHint = `Prefer the seeded local Google Patents parser under ${candidateToolsDir} when a patent page URL or candidate identifier is known. Use it to extract title, assignee, inventors, publication/grant counterparts, family evidence, claim windows, legal-status windows, and NPL/product hints before broader search. Use claim_risk_matrix.py when you have parsed patent JSON and concrete product features so the trace can separate technical fit, legal scope, and benchmark/source-label recovery.`;
  return `You are the EVAL RUNNER for one answer-blind patent-number case.

Allowed files:
- ${candidatePath}
- ${candidateToolsDir}

Case:
- id: ${item.id}
- task: ${item.task}
- input: ${item.input}

Forbidden files:
- ${inputsPath}
- ${answersPath}
- ${benchmarkPath}
- ${testSetPath}
- ${legacyAnswersPath}
- any score-report.md file

Task:
1. Read the candidate skill and candidate tools.
2. Solve only this one case.
3. Use tools/scripts from ${candidateToolsDir} if useful.
4. Write the raw result to ${out}.
5. Write the provenance trace to ${trace}.
6. ${retrievalHint}
7. Follow an FTO-lite process in the trace:
   - product identity lock: for image-only or ambiguous inputs, state the visible anchors and at least one alternate hypothesis checked before committing
   - product decomposition: product identity, functions, structure/components, consumable/refill format, control/sensing modules, and use context
   - search-point extraction: model, brand, assignee/company, feature phrases, likely competitor/leader clues, and technical modules when relevant
   - staged search: exact marking/product anchors first, source-bridge searches second, family/counterpart third, broad functional fallback fourth
   - claim/status comparison: compare key product features against patent abstracts/independent-claim windows and note jurisdiction/status where available
   - evidence reasoning: separate direct-match evidence, family/counterpart evidence, potential-risk evidence, and weaker technical analog evidence
   - stop discipline: explain briefly why you stopped where you did
8. Use recall-first bucket policy:
   - HIGH_RISK: direct product patents, same-product counterparts, or active/enforceable close risk candidates with strong product/mechanism and claim-status evidence
   - RELATED: supported but weaker family, source-label, assignee, competitor, foreign-only, expired, abandoned, historical, or adjacent-risk candidates
   - extra supported RELATED items are acceptable; do not omit credible candidates just to keep the output short

Scope guard:
- This is a retail product patent-number search and FTO-lite evidence task only.
- Do not perform cybersecurity, vulnerability research, credential, exploit, network, bypass, or access-control work.

Raw output format must be exactly:

## ${item.id}
\`\`\`text
HIGH_RISK:
<normalized patent identifiers or NONE>

RELATED:
<normalized patent identifiers or NONE>
\`\`\`

Trace format guidance:
- include sections for Product Identity Lock, Product Decomposition, Search Points, Searches Run, Sources Used, Claim/Status Comparison, Evidence Decisions, and Stop Reason
- do not include hidden chain-of-thought; include only auditable search/process notes

Do not edit dataset files. Do not read forbidden files. Do not include hidden chain-of-thought in the trace; include only searches, scripts run, sources, and evidence decisions.

Iteration: ${iter}
`;
}

function builderPrompt(iter, iterDir) {
  const privateReport = path.join(iterDir, "score-report.md");
  const caseDirs = cases.map((c) => path.join(iterDir, c.id)).join("\n- ");
  const priorArtifactsRoot = loopDir;
  const warmStartArtifacts = warmStartFrom
    ? `\n- prior warm-start artifacts under ${warmStartFrom}, including:\n  - best-skill.md\n  - current-skill.md\n  - best-tools\n  - candidate-tools\n  - iter-*/PN-*/eval-agent.log\n  - iter-*/PN-*/outputs.md\n  - iter-*/PN-*/trace.md\n  - iter-*/strategy-loop-outputs.md\n  - iter-*/strategy-loop-trace.md\n  - iter-*/score-report.md\n  - iter-*/score-report.public.md\n  - iter-*/score-report.json`
    : "";
  const experimentHint = `Active retrieval experiment: local parser plus claim-risk matrix. Prefer editing or using seeded helpers such as google_patents_parser.py, query_pack.py, claim_risk_matrix.py, and tiny deterministic ranking logic so the runner can extract counterpart, family, assignee, inventor, NPL, claim-window, status, and mechanism clues from known patent pages before broader search.`;
  return `You are the PLANNER+BUILDER in a case-split eval-improvement loop for a patent-number search skill.

You may edit only:
- ${candidatePath}
- files under ${candidateToolsDir}

You may read:
- ${inputsPath}
- ${answersPath}
- ${benchmarkPath}
- ${testSetPath}
- ${legacyAnswersPath}
- ${candidatePath}
- files under ${candidateToolsDir}
- ${privateReport}
- ${resultsTsvPath}
- ${caseLedgerTsvPath}
- ${programPath}
- ${learningMdPath}
- ${learningJsonPath}
- ${path.join(iterDir, "strategy-loop-outputs.md")}
- ${path.join(iterDir, "strategy-loop-trace.md")}
- ${caseDirs}
- any prior iteration artifacts under ${priorArtifactsRoot}, including:
  - iter-*/PN-*/eval-agent.log
  - iter-*/PN-*/outputs.md
  - iter-*/PN-*/trace.md
  - iter-*/strategy-loop-outputs.md
  - iter-*/strategy-loop-trace.md
  - iter-*/score-report.md
  - iter-*/score-report.public.md
  - iter-*/score-report.json
${warmStartArtifacts}

Goal:
Improve the candidate skill's general procedure so the next answer-blind eval run gets a higher overall score while preserving or improving high-risk recall and target recall.

Rules:
- Follow ${programPath}.
- Do not memorize exact expected patent numbers.
- Prefer simple, stable tools over giant policy engines.
- Preserve the HIGH_RISK / RELATED output contract. Use RELATED for credible weaker candidates instead of dropping them.
- Optimize no-miss behavior before precision polish; extra supported RELATED identifiers should be handled by bucket classification, not by global rejection.
- Keep audit-only source labels separate from required risk targets. Do not optimize for suspect source labels when they conflict with product-risk evidence.
- Add or preserve final verifier behavior: product identity lock, claim/status comparison, jurisdiction/status discipline, and bucket rebucketing before final raw output.
- Keep Python helpers small and deterministic. Retrieval/query planning, patent-page parsing, backend adapters, and tiny evidence rankers are good; hidden scoring logic is not.
- Avoid cybersecurity-looking search operators or generic search-dork syntax in helper-generated queries; use plain domain phrases like "Google Patents" or "Justia patents" instead of operator-heavy strings.
- Use ${resultsTsvPath}, ${caseLedgerTsvPath}, ${learningMdPath}, and ${learningJsonPath} to avoid oscillating on the same mistake.
- Treat each round as one experiment. Make at most one skill change and one tool change.
- If the last round was discarded, assume the workspace has already been restored to the best known baseline.
- ${experimentHint}
- If an unresolved case repeatedly finds plausible candidate patents but rejects them for lacking an exact product bridge, treat that as an acceptance-regime issue rather than a pure retrieval gap.
- Do not broaden acceptance across all tasks to fix one unresolved thin-storefront case. Any inferred-accept or mechanism-match rule must be narrow enough that the already-stable exact-bridge cases do not degrade.

Validation requirement:
- After editing, run at least one local validation command for any changed script, or a syntax check if no external-network run is practical.
- Do not run commands that read forbidden files.

Required output:
1. Edit ${candidatePath} directly.
2. Edit/create helper scripts under ${candidateToolsDir} if useful.
3. Write a short build note to ${path.join(iterDir, "builder-notes.md")} explaining the single experiment, why it should help, and exactly what validation command you ran.

Iteration just scored: ${iter}
`;
}
