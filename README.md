# coda-agent-probes

公开 Agent CLI 的**协议勘察**材料，供 [Coda](https://github.com/happy-everyday-everyweek/coda) 跨端平台写适配器用。

## 规则

- 只用**公开可编程接口**（`--help` / `--version` / 官方文档化的 JSON-RPC、stream-json、ACP、app-server、SDK）。
- **不使用任何账号、API Key、Token**；不绕过登录、授权、许可或 DRM；不抓取用户数据。
- 所有输出在 CI 中生成并脱敏（家目录、用户名、疑似凭据一律替换）。
- 结论只用于互操作：记录「某版本某 CLI 暴露了什么入口」，不复制闭源实现。

## 结构

- `probe.config.json`：要勘察的 CLI 与命令矩阵
- `scripts/probe.mjs`：执行单条勘察，输出 `out/<agent>.json`
- `scripts/merge.mjs`：合并为 `results/<run>/index.json` 与 `results/latest.json`
- `.github/workflows/probe.yml`：矩阵并行执行 + 自动提交结果

## 结果

CI 每次运行后把结果提交到 `results/`，也可在 Actions 的 artifacts 里下载原始输出。

> 这些结果是版本相关的观测值，不是能力承诺；适配器实现仍以 Coda 仓库 `ACCEPTANCE.md` 的验收证据为准。
