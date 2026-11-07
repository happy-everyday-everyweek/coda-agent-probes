#!/usr/bin/env node
/**
 * 单个 Agent CLI 的协议勘察（CI 内运行）。
 * 只用公开入口：--version / --help / 官方文档化的 JSON-RPC 握手。
 * 不读取任何用户凭据；输出脱敏后落盘。
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname, platform, arch, release } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const agentId = process.argv[2];
if (!agentId) {
  console.error("usage: node scripts/probe.mjs <agent-id>");
  process.exit(2);
}

const config = JSON.parse(readFileSync(join(root, "probe.config.json"), "utf8"));
const agent = config.agents.find((a) => a.id === agentId);
if (!agent) {
  console.error(`unknown agent: ${agentId}`);
  process.exit(2);
}

const MAX_OUTPUT = 200_000;
const SECRET_PATTERNS = [
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /Authorization:\s*[^\s]+/gi,
  /(?<=token[=:]\s*)[^\s"']+/gi,
];

function sanitize(text) {
  let out = String(text ?? "");
  const home = homedir();
  if (home && home !== "/") out = out.split(home).join("~");
  out = out.split("/home/runner").join("~");
  out = out.split(hostname()).join("[host]");
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[REDACTED]");
  if (out.length > MAX_OUTPUT) out = out.slice(0, MAX_OUTPUT) + `\n…[TRUNCATED ${out.length - MAX_OUTPUT} chars]`;
  return out;
}

const SAFE_ENV = {};
for (const [k, v] of Object.entries(process.env)) {
  if (/TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|^AWS_|^GITHUB_|^GH_/i.test(k)) continue;
  SAFE_ENV[k] = v;
}
Object.assign(SAFE_ENV, { NO_COLOR: "1", TERM: "dumb", CI: "1", FORCE_COLOR: "0" });

function run({ cmd, timeoutMs = 20000, stdin = null }) {
  const started = Date.now();
  const result = spawnSync("bash", ["-lc", cmd], {
    cwd: root,
    env: SAFE_ENV,
    input: stdin ?? "",
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
  });
  return {
    cmd,
    timeoutMs,
    exitCode: result.status,
    signal: result.signal,
    timedOut: result.error?.code === "ETIMEDOUT" || result.signal === "SIGTERM",
    durationMs: Date.now() - started,
    stdout: sanitize(result.stdout),
    stderr: sanitize(result.stderr),
  };
}

let packageVersion = null;
if (agent.package) {
  const r = spawnSync("npm", ["view", agent.package, "version"], {
    encoding: "utf8",
    timeout: 30000,
    env: SAFE_ENV,
  });
  if (r.status === 0) packageVersion = (r.stdout ?? "").trim();
}

const probes = [];
for (const command of agent.commands ?? []) probes.push(run(command));

const output = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  agent,
  packageVersion,
  runner: { os: platform(), arch(), release: release(), node: process.version, host: hostname() },
  probes,
};

mkdirSync(join(root, "out"), { recursive: true });
writeFileSync(join(root, "out", `${agent.id}.json`), JSON.stringify(output, null, 2) + "\n");

const found = probes.map((p) => `${p.cmd} → exit=${p.exitCode}${p.timedOut ? " (timeout)" : ""}`).join("; ");
console.log(`probe ${agent.id}: ${found}`);
