#!/usr/bin/env node
/**
 * 单个 Agent CLI 的协议勘察（CI 内运行）。
 * 只用公开入口：--version / --help / 官方文档化的 JSON-RPC 握手。
 * 不读取任何用户凭据；输出脱敏后落盘。
 */
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
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

const CAPTURE_DIR_FULL = join(root, "out", "captured");

function copyCapturedFiles(agentId, dirPath, limit = 10, maxBytes = 512 * 1024) {
  const manifest = [];
  const walk = (dir, depth = 0) => {
    if (manifest.length >= limit || depth > 3) return;
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }
    for (const entry of entries) {
      if (manifest.length >= limit) return;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.isFile()) {
        try {
          const stat = statSync(full);
          if (stat.size > maxBytes) {
            manifest.push({ path: full.replace("/tmp/probe-out", "out"), bytes: stat.size, copied: false, reason: "too-large" });
            continue;
          }
          const dest = join(CAPTURE_DIR_FULL, agentId, full.replace("/tmp/probe-out/", ""));
          mkdirSync(dirname(dest), { recursive: true });
          copyFileSync(full, dest);
          manifest.push({ path: dest.replace(root + "/", ""), bytes: stat.size, copied: true });
        } catch {
          /* ignore */
        }
      }
    }
  };
  walk(dirPath);
  return manifest;
}

function collectDir(dirPath, limit = 20) {
  const out = [];
  const walk = (dir, depth = 0) => {
    if (out.length >= limit || depth > 3) return;
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= limit) return;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.isFile()) {
        try {
          const stat = statSync(full);
          const head = readFileSync(full, "utf8").slice(0, 3000);
          out.push({ path: full.replace("/tmp/probe-out", "out"), bytes: stat.size, head: sanitize(head) });
        } catch {
          /* ignore */
        }
      }
    }
  };
  walk(dirPath);
  return out;
}

function runSync({ cmd, timeoutMs = 20000, stdin = null, captureDir = null, captureFull = false, agentIdForCapture = "capture" }) {
  const started = Date.now();
  if (captureDir) {
    try {
      mkdirSync(captureDir, { recursive: true });
    } catch {
      /* ignore */
    }
  }
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
    ...(captureDir
      ? {
          capturedFiles:
            captureFull && captureDir
              ? copyCapturedFiles(agentIdForCapture, captureDir)
              : collectDir(captureDir),
        }
      : {}),
  };
}

/** ACP 动态流程：initialize → session/new → session/prompt，收集全部帧直到结束或超时。 */
function runAcpFlow({ cmd, acpFlow, timeoutMs = 120000 }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn("bash", ["-lc", cmd], { cwd: root, env: SAFE_ENV, stdio: ["pipe", "pipe", "pipe"] });
    const lines = [];
    let stderr = "";
    let finished = false;
    let nextId = 1;
    let sessionId = null;
    const timers = [];
    const finish = (extra = {}) => {
      if (finished) return;
      finished = true;
      for (const t of timers) clearTimeout(t);
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      const raw = lines.join("\n");
      const parsed = lines.map((line) => {
        try { return JSON.parse(line); } catch { return { raw: line.slice(0, 500) }; }
      });
      resolve({
        cmd,
        timeoutMs,
        exitCode: extra.exitCode ?? null,
        signal: extra.signal ?? null,
        timedOut: !!extra.timedOut,
        durationMs: Date.now() - started,
        frames: parsed,
        stdout: sanitize(raw),
        stderr: sanitize(stderr),
      });
    };
    child.on("error", () => finish({ exitCode: -1 }));
    child.on("close", (code, signal) => finish({ exitCode: code, signal }));
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const send = (msg) => { try { child.stdin.write(`${JSON.stringify(msg)}\n`); } catch { /* ignore */ } };
    const handle = (msg) => {
      if (msg.method === "initialize" || msg.id === 1) send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } }, clientInfo: { name: "coda-probe", version: "0.0.1" } } });
    };
    const reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
    reader.on("line", (line) => {
      lines.push(line);
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.id === 1 && msg.result) {
        send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "/tmp", mcpServers: [] } });
        return;
      }
      if (msg.id === 2 && msg.result) {
        sessionId = msg.result.sessionId ?? null;
        if (sessionId) {
          send({
            jsonrpc: "2.0", id: 3, method: "session/prompt",
            params: { sessionId, prompt: [{ type: "text", text: String(acpFlow.prompt ?? "ping") }] },
          });
        }
        return;
      }
      if (msg.id === 3) {
        // prompt 响应（含 stopReason）即回合结束
        finish({ exitCode: 0 });
      }
      if (msg.method === "session/update" && msg.params?.update?.sessionUpdate === "turn_end") {
        finish({ exitCode: 0 });
      }
    });
    // 首次走 initialize
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } }, clientInfo: { name: "coda-probe", version: "0.0.1" } } });
    timers.push(setTimeout(() => finish({ timedOut: true, signal: "SIGKILL" }), acpFlow.timeoutMs ?? timeoutMs));
  });
}

/** 多行 stdin 交互：先写 line1，等 delay，再写 line2……直到进程退出。 */
function runInteractive({ cmd, lines = [], timeoutMs = 20000, lineDelayMs = 800 }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn("bash", ["-lc", cmd], { cwd: root, env: SAFE_ENV, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let finished = false;
    let idx = 0;
    const timers = [];

    const finish = (extra = {}) => {
      if (finished) return;
      finished = true;
      for (const t of timers) clearTimeout(t);
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      resolve({
        cmd,
        timeoutMs,
        exitCode: extra.exitCode ?? null,
        signal: extra.signal ?? null,
        timedOut: !!extra.timedOut,
        durationMs: Date.now() - started,
        stdout: sanitize(stdout),
        stderr: sanitize(stderr),
      });
    };

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", () => finish({ exitCode: -1 }));
    child.on("close", (code, signal) => finish({ exitCode: code, signal }));

    const writeNext = () => {
      if (idx >= lines.length) {
        try {
          child.stdin.end();
        } catch {
          /* ignore */
        }
        return;
      }
      try {
        child.stdin.write(`${lines[idx++]}\n`);
      } catch {
        /* ignore */
      }
      timers.push(setTimeout(writeNext, lineDelayMs));
    };
    writeNext();
    timers.push(setTimeout(() => finish({ timedOut: true, signal: "SIGKILL" }), timeoutMs));
  });
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
for (const command of agent.commands ?? []) {
  if (command.acpFlow) {
    probes.push(await runAcpFlow(command));
  } else if (Array.isArray(command.stdinLines) && command.stdinLines.length) {
    probes.push(await runInteractive({ ...command, lines: command.stdinLines }));
  } else {
    probes.push(runSync({ ...command, agentIdForCapture: agent.id }));
  }
}

const output = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  agent,
  packageVersion,
  runner: { os: platform(), arch: arch(), release: release(), node: process.version, host: hostname() },
  probes,
};

mkdirSync(join(root, "out"), { recursive: true });
writeFileSync(join(root, "out", `${agent.id}.json`), JSON.stringify(output, null, 2) + "\n");

const found = probes.map((p) => `${p.cmd} → exit=${p.exitCode}${p.timedOut ? " (timeout)" : ""}`).join("; ");
console.log(`probe ${agent.id}: ${found}`);
