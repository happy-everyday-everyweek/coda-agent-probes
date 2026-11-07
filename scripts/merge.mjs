#!/usr/bin/env node
/** 合并各 agent 的勘察结果，并生成人类可读摘要。 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const outDir = join(root, "out");
const runId = process.env.GITHUB_RUN_ID
  ? `${new Date().toISOString().slice(0, 10)}-run${process.env.GITHUB_RUN_ID}`
  : new Date().toISOString().replace(/[:.]/g, "-");
const resultDir = join(root, "results", runId);
mkdirSync(resultDir, { recursive: true });

const KEYWORDS = [
  "--json", "stream-json", "app-server", "rpc", "acp", "mcp", "serve", "server",
  "--print", "--input-format", "--output-format", "sdk", "session", "resume", "permission",
];

const agents = [];
let files = [];
try {
  files = readdirSync(outDir).filter((f) => f.endsWith(".json")).sort();
} catch {
  files = [];
}

for (const file of files) {
  try {
    agents.push(JSON.parse(readFileSync(join(outDir, file), "utf8")));
  } catch (err) {
    console.error(`skip ${file}: ${err.message}`);
  }
}

const index = {
  schemaVersion: 1,
  runId,
  generatedAt: new Date().toISOString(),
  source: "github-actions probe matrix",
  agents: agents.map((a) => ({
    id: a.agent.id,
    package: a.agent.package ?? null,
    packageVersion: a.packageVersion,
    probes: a.probes.map((p) => ({
      cmd: p.cmd,
      exitCode: p.exitCode,
      timedOut: p.timedOut,
      durationMs: p.durationMs,
      hints: KEYWORDS.filter((k) => `${p.stdout}\n${p.stderr}`.toLowerCase().includes(k)),
      stdoutHead: p.stdout.slice(0, 4000),
      stderrHead: p.stderr.slice(0, 2000),
    })),
  })),
};

writeFileSync(join(resultDir, "index.json"), JSON.stringify(index, null, 2) + "\n");
writeFileSync(join(root, "results", "latest.json"), JSON.stringify(index, null, 2) + "\n");

const rows = index.agents.map((a) => {
  const hints = [...new Set(a.probes.flatMap((p) => p.hints))];
  const ok = a.probes.filter((p) => p.exitCode === 0 && !p.timedOut).length;
  return `| ${a.id} | ${a.packageVersion ?? "?"} | ${ok}/${a.probes.length} | ${hints.join(", ") || "-"} |`;
});
const md = [
  `# Agent 协议勘察 ${runId}`,
  "",
  "| Agent | 包版本 | 成功命令 | 暴露的公开入口 |",
  "|---|---|---|---|",
  ...rows,
  "",
  "> 仅公开 `--help/--version/JSON-RPC 握手` 观测；无凭据、无登录；结果与版本绑定。",
  "",
].join("\n");
writeFileSync(join(resultDir, "SUMMARY.md"), md);
console.log(md);
