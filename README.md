# DSH Chat Import

`Nwflower/dsh-chat-import` 为 DeepSeek Harness 补充「外部聊天记录导入」能力：把 Claude Code 的 JSONL transcript **全保真**导入为**可继续（resume）**的 DSH 会话。插件不改写源文件，也不修改 DSH 引擎内部；每次导入都通过公开的 `sessionPersistence` 追加一条全新的、事件平衡的会话日志，并把会话挂接到其 `cwd` 对应的工作区。

## 功能

- **导入 Claude Code transcript**：读取 `~/.claude/projects/<slug>/<sessionId>.jsonl`，解析 user / assistant / tool / thinking 消息。
- **全保真**：工具调用历史映射为 `tool/call` + `tool/result`（含错误标记、`sourceEventSeqs` 关联）、thinking 块映射为 `reasoning`、多步 assistant 消息完整保留。
- **可继续（resume）**：合成 `turn/start`、`step/start`、`user/message`、`assistant/message`、`tool/call`、`tool/result`、`step/end`、`turn/end` 事件，落盘为平衡、可加载的会话，点开即可续聊。
- **保留会话元数据**：源 `sessionId`、`cwd`、`ai-title`（钉为 `session/title`，不被自动标题覆盖）、创建时间。
- **自动挂接工作区**：导入后按 `cwd` 解析/创建工作区并 `attachSession`，会话归组正确（不再「未分组」）。
- **幂等导入**：目标会话已存在时跳过，不重复写入；畸形 JSONL 行计数上报，不中断。
- **批量导入**：`path` 传目录时递归扫描所有 `.jsonl`，每个文件导入为独立会话，返回逐文件汇总。

## 设计

### 事件溯源映射

插件把 Claude Code 的 transcript 记录按「直连人类提问」切轮：`type === 'user'` 且 `content` 为字符串时开新轮；其后每条 `assistant` 消息（含 `tool_use` / `thinking` 块）构成一步，`tool_result` 挂到最近一步。每轮合成一个闭合的 DSH 回合：

1. `turn/start` → `step/start` → `user/message` → `assistant/message` →（`tool/call` + `tool/result`）→ `step/end` → `turn/end`。
2. 消息体带稳定 id（`import:<sessionId>:u<turn>` / `:a<turn>:<step>` / `:t<turn>:<step>:<callId>`），并带 `surfaceOp: 'append'`。
3. assistant 的 `source` 为 `{ kind: 'model', provider: 'claude-code', model: <源模型> }`；`tool/result` 的 `source` 为 `{ kind: 'tool', callId }`，并通过 `sourceEventSeqs` 关联到对应 `tool/call`。

### 服务依赖

- Host 只依赖公开服务：`sessionPersistence`（`create` + `append`）、`fs`（读源文件）、`tools`（注册工具）、`workspaceRegistry`（`resolveByPath` / `create` / `attachSession` 归组）。
- 不发布任何服务，因此无需 isolate realm。
- 无 Browser 侧，纯 Host 插件。

## 数据模型

| Claude Code JSONL | DSH SessionEvent |
| --- | --- |
| `{ type: "user", message.content: string }`（直连提问） | `turn/start` + `step/start` + `user/message` |
| `{ type: "assistant", content: [{ type: "text", text }] }` | `assistant/message` |
| `{ type: "assistant", content: [{ type: "thinking", … }] }` | `reasoning` content block |
| `{ type: "assistant", content: [{ type: "tool_use", … }] }` | `tool/call` + `tool-call` content block |
| `{ type: "user", content: [{ type: "tool_result", … }] }` | `tool/result`（`sourceEventSeqs` 关联 `tool/call`） |
| 轮次结束 | `step/end` + `turn/end` |

会话头 `SessionHeader`：`version: 0`、`id: import-<源sessionId>`、`createdAt`（源时间戳）、`cwd`（源工作目录）。

## 构建

纯 ESM，无编译步骤：`index.mjs` 即 Host 插件入口（转换核心在无依赖的 `convert.mjs`，可独立单测），无需 `tsc` / 打包。

## 安装

```bash
dsh plugin --profile web add -w link:/path/to/dsh-chat-import
```

`dsh plugin` 是 pnpm 转发器：`add` 后识别 `dsh.bundle` 声明，把 `cordis.patch.yml` 的 `insert` 行收编进 profile 的 bundles，重启 dsh 即生效。本地开发建议用 `link:`（符号链接）。

## 兼容性

- **依赖面**：仅消费 host 公开插件 API（`sessionPersistence` / `fs` / `tools` / `workspaceRegistry`）与 `@deepseek-ai/dsh-tools`（已声明为 `peerDependencies`，实测版本 `0.1.0-rc.6`）。
- **实测**：2026-08 于 `dsh 0.1.0-rc.6` 的 web profile 验证「导入 → resume → 工作区归组」全链路；`npm test`（18 个用例）覆盖转换纯函数与 mock 集成路径。

## 卸载

从 profile 的 bundles 中移除 `import-claude`（即 `cordis.patch.yml` 的 `insert` 行），重启 dsh 后插件不再加载。已导入的会话保留在 DSH 数据目录，不受卸载影响。

## 使用

在挂载了本插件的会话里调用工具：

```
import_claude({ path: "C:\\Users\\<you>\\.claude\\projects\\<slug>\\<sessionId>.jsonl" })
```

可选 `sessionId` 覆盖目标 DSH 会话 id（默认 `import-<源sessionId>`）。返回 `{ mode: 'single', sessionId, turns, messages, toolCalls, skipped, alreadyImported }`；导入后刷新会话列表即可看到新会话，且已挂接到其工作目录。

### 批量导入（目录）

```js
import_claude({ path: "C:\\Users\\<you>\\.claude\\projects" })
```

目录模式递归扫描（`recursive: false` 可只扫顶层）所有 `.jsonl`，每个文件独立导入为一个会话；非 transcript / 空文件跳过。返回 `{ mode: 'batch', total, imported, alreadyImported, skipped, failed, results: [...] }`，`results` 每项含 `path`、`status`（`imported` / `already-imported` / `skipped` / `failed`）及会话统计。

## 范围边界

- 源 transcript 只读，绝不原地改写；DSH 历史事件同样 append-only（deep-frozen），只新增、不改写。
- 不修改 DSH 引擎、apiproxy 或官方 UI 包；不发布任何服务，无需 isolate realm。
- 读取工作区之外的 transcript 路径时，要求会话沙箱允许访问该路径。
- 已知边界：不导入 `permission`、`summary` 等辅助记录；`is_error` 的 `tool_result` 保留错误标记但丢弃其 `message.content` 之外的附加字段（计划 v1.2 补全）；目前仅支持 Claude Code JSONL 一种源格式（Codex / ChatGPT 多源导入规划中）。

## 测试

```bash
npm test
```

`test/convert.test.mjs` 覆盖纯转换逻辑（回合平衡、工具关联、标题、畸形行）；`test/index.test.mjs` 用 mock 的 `fs` / `sessionPersistence` / `tools` / `workspaceRegistry` 走完整 `apply → execute` 路径，并校验返回值符合输出 schema。
