import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const root = process.cwd();
const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (!arg.startsWith("--")) continue;
  const key = arg.slice(2);
  const next = process.argv[i + 1];
  if (next && !next.startsWith("--")) {
    args.set(key, next);
    i++;
  } else {
    args.set(key, "1");
  }
}

const runner = args.get("runner") ?? "codex";
const model = args.get("model") ?? (runner === "claude" ? "claude-sonnet-4-6" : "gpt-5.4");
const datasetDir = path.resolve(args.get("dataset-dir") ?? process.env.PATENT_DATASET_DIR ?? path.join(root, "dataset"));
const runDir = path.resolve(args.get("run-dir") ?? path.join(root, "tmp", `cli-baseline-noskill-${runner}`));
const isolatedCwd = path.join(runDir, "_isolated-cwd");
const caseFilter = new Set((args.get("cases") ?? "").split(",").map((value) => value.trim()).filter(Boolean));
const cases = parseInputCases(fs.readFileSync(path.join(datasetDir, "patent-number-inputs.md"), "utf8"))
  .filter((row) => caseFilter.size === 0 || caseFilter.has(row.id));
const metadata = {
  generatedAt: new Date().toISOString(),
  runner,
  model,
  runDir,
  datasetDir,
  promptPolicy: "No patent-find skill seed is injected. The CLI sees only the case input, a minimal task statement, and the required bucket output contract.",
  cases: [],
};

fs.mkdirSync(runDir, { recursive: true });
fs.mkdirSync(isolatedCwd, { recursive: true });
const outputPath = path.join(runDir, "strategy-loop-outputs.md");
const metadataPath = path.join(runDir, "cli-baseline-metadata.json");
const rendered = [];

for (const row of cases) {
  const caseDir = path.join(runDir, row.id);
  fs.mkdirSync(caseDir, { recursive: true });
  const prompt = buildPrompt(row);
  const promptPath = path.join(caseDir, "prompt.txt");
  const rawPath = path.join(caseDir, "raw-output.txt");
  const stdoutPath = path.join(caseDir, "stdout.txt");
  const stderrPath = path.join(caseDir, "stderr.txt");
  fs.writeFileSync(promptPath, prompt, "utf8");

  const started = Date.now();
  console.log(`[${runner}] ${row.id} starting`);
  const result = runner === "claude"
    ? await runClaude(prompt, rawPath)
    : await runCodex(prompt, rawPath, row);
  fs.writeFileSync(stdoutPath, result.stdout, "utf8");
  fs.writeFileSync(stderrPath, result.stderr, "utf8");
  if (result.code !== 0) {
    throw new Error(`${runner} failed for ${row.id} with code ${result.code}. See ${stderrPath}`);
  }

  const raw = fs.existsSync(rawPath) ? fs.readFileSync(rawPath, "utf8") : result.stdout;
  const answer = runner === "claude" ? extractClaudeResult(raw) : raw;
  const normalized = normalizeRawResult(answer);
  rendered.push(`## ${row.id}\n\n\`\`\`text\n${normalized}\n\`\`\`\n`);
  fs.writeFileSync(outputPath, rendered.join("\n"), "utf8");

  metadata.cases.push({
    id: row.id,
    elapsedMs: Date.now() - started,
    code: result.code,
    rawLength: answer.length,
  });
  fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  console.log(`[${runner}] ${row.id} done`);
}

console.log(outputPath);

function parseInputCases(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\| (PN-\d{3}) \| (.*?) \| `(.*?)` \|$/);
    if (!match) continue;
    rows.push({ id: match[1], task: match[2], input: match[3] });
  }
  return rows;
}

function buildPrompt(row) {
  return [
    "Run a blind patent-number search for this single benchmark case.",
    "Do not read dataset/patent-number-answers.md, dataset/patent-number-benchmark.md, score reports, prior tmp eval outputs, or any patent-find skill file.",
    "Do not use the repository's patent-find skill/policy. Use only your normal CLI capabilities and the case input below.",
    "Find patent identifiers that are directly tied to the product or meaningfully related to product-risk review.",
    "",
    "Output only this exact bucket format, with normalized patent identifiers or NONE:",
    "HIGH_RISK:",
    "<direct or close-risk patent numbers, or NONE>",
    "",
    "RELATED:",
    "<related/lower-confidence patent numbers, or NONE>",
    "",
    "Case:",
    `id: ${row.id}`,
    `task: ${row.task}`,
    `input: ${row.input}`,
  ].join("\n");
}

async function runCodex(prompt, rawPath, row) {
  const cliArgs = [];
  if (args.get("codex-search") !== "0") cliArgs.push("--search");
  cliArgs.push(
    "exec",
    "-m", model,
    "-C", runDir,
    "--skip-git-repo-check",
    "-s", "workspace-write",
    "--output-last-message", rawPath,
  );
  if (/\.(png|jpg|jpeg|webp)$/i.test(row.input)) {
    const rootImage = path.resolve(root, row.input);
    const datasetImage = path.resolve(datasetDir, row.input);
    cliArgs.push("-i", fs.existsSync(rootImage) ? rootImage : datasetImage);
  }
  cliArgs.push("-");
  return spawnCapture("codex", cliArgs, prompt, Number(args.get("timeout-ms") ?? 900000));
}

async function runClaude(prompt, rawPath) {
  const cliArgs = [
    "-p",
    "--output-format", "json",
    "--permission-mode", "bypassPermissions",
    "--model", model,
    "--effort", args.get("effort") ?? "medium",
    "--no-session-persistence",
    "--disable-slash-commands",
    "--setting-sources", args.get("setting-sources") ?? "user",
  ];
  const maxBudget = args.get("max-budget-usd");
  if (maxBudget) cliArgs.push("--max-budget-usd", maxBudget);
  const result = await spawnCapture("claude", cliArgs, prompt, Number(args.get("timeout-ms") ?? 900000));
  fs.writeFileSync(rawPath, result.stdout, "utf8");
  return result;
}

function spawnCapture(command, cliArgs, stdinText, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, cliArgs, {
      cwd: args.get("cwd") === "root" ? root : isolatedCwd,
      shell: process.platform === "win32",
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ stdout, stderr, code });
    });
    if (stdinText) child.stdin.write(stdinText);
    child.stdin.end();
  });
}

function extractClaudeResult(text) {
  try {
    const json = JSON.parse(text);
    return json.result ?? text;
  } catch {
    return text;
  }
}

function normalizeRawResult(text) {
  const cleaned = String(text || "").trim();
  const highMatch = cleaned.match(/HIGH[_\s-]*RISK\s*:?\s*([\s\S]*?)(?:\n\s*RELATED\s*:|$)/i);
  const relatedMatch = cleaned.match(/RELATED\s*:?\s*([\s\S]*)$/i);
  const high = cleanBucket(highMatch?.[1]);
  const related = cleanBucket(relatedMatch?.[1]);
  return `HIGH_RISK:\n${high}\n\nRELATED:\n${related}`;
}

function cleanBucket(value) {
  const lines = String(value || "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean)
    .filter((line) => !/^```/.test(line))
    .filter((line) => !/^ANALYSIS_REPORT\s*:/i.test(line));
  return lines.length > 0 ? lines.join("\n") : "NONE";
}
