<p align="center">
  <a href="README.md">English</a> | <a href="README.zh-CN.md">简体中文</a>
</p>

# DSH Chat Import

> 把 Claude Code / Codex / ChatGPT / Cursor / Gemini 的聊天记录导入 DeepSeek Harness，成为可继续（resume）的会话。

[![npm version](https://img.shields.io/npm/v/dsh-chat-import)](https://www.npmjs.com/package/dsh-chat-import)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/Nwflower/dsh-chat-import)](https://github.com/Nwflower/dsh-chat-import)

`Nwflower/dsh-chat-import` 为 DeepSeek Harness 补充「外部聊天记录导入」能力：把 Claude Code 的 JSONL transcript、Codex / ChatGPT CLI 的 rollout JSONL、ChatGPT 网页导出的 conversations.json、Cursor 的 agent transcript 与 Gemini CLI 的会话 JSON **全保真**导入为**可继续（resume）**的 DSH 会话。插件不改写源文件，也不修改 DSH 引擎内部；每次导入都通过公开的 `sessionPersistence` 追加一条全新的、事件平衡的会话日志，并把会话挂接到其 `cwd` 对应的工作区。

## 功能

- **导入 Claude Code transcript**：读取 `~/.claude/projects/<slug>/<sessionId>.jsonl`，解析 user / assistant / tool / thinking 消息。
- **导入 Codex / ChatGPT rollout**：读取 `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`（OpenAI Codex CLI 已并入 ChatGPT，格式不变），解析 `response_item` 的 message / function_call / custom_tool_call / reasoning。
- **导入 ChatGPT 网页导出**：读取导出 ZIP 解压出的 `conversations.json`（一个文件含全部会话），沿 mapping 主线程重建对话。
- **导入 Cursor agent transcript**：读取 `~/.cursor/projects/<slug>/agent-transcripts/<composer-id>/<composer-id>.jsonl`，解析 text / tool_use，过滤 `[REDACTED]` 哨兵。
- **导入 Gemini CLI 会话**：读取 `~/.gemini/history/<slot>/chats/session-*.json`（一文件一 JSON 对象），解析 user/gemini 消息、`thoughts` → `reasoning`、内联 `toolCalls`（结果与调用同对象）；`info` 系统通知跳过。
- **全保真**：工具调用历史映射为 `tool/call` + `tool/result`（含错误标记、`sourceEventSeqs` 关联）、thinking 块映射为 `reasoning`、多步 assistant 消息完整保留。
- **可继续（resume）**：合成 `turn/start`、`step/start`、`user/message`、`assistant/message`、`tool/call`、`tool/result`、`step/end`、`turn/end` 事件，落盘为平衡、可加载的会话，点开即可续聊。
- **保留会话元数据**：源 `sessionId`、`cwd`、`ai-title`（Claude，钉为 `session/title`，不被自动标题覆盖）、真实 model 名（源有记录时）、创建时间。
- **自动挂接工作区**：导入后按 `cwd` 解析/创建工作区并 `attachSession`，会话归组正确（不再「未分组」）；ChatGPT 导出与 Cursor transcript 无 `cwd` 字段，不归组。
- **幂等导入**：目标会话已存在时跳过，不重复写入；畸形 JSONL 行计数上报，不中断。
- **批量导入**：`path` 传目录时递归扫描 `.jsonl`（Claude / Codex / Cursor）或 `.json`（ChatGPT / Gemini），每个文件导入为独立会话（ChatGPT 文件内每个会话独立），返回逐文件/逐会话汇总。

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

### Claude Code JSONL

| Claude Code JSONL | DSH SessionEvent |
| --- | --- |
| `{ type: "user", message.content: string }`（直连提问） | `turn/start` + `step/start` + `user/message` |
| `{ type: "assistant", content: [{ type: "text", text }] }` | `assistant/message` |
| `{ type: "assistant", content: [{ type: "thinking", … }] }` | `reasoning` content block |
| `{ type: "assistant", content: [{ type: "tool_use", … }] }` | `tool/call` + `tool-call` content block |
| `{ type: "user", content: [{ type: "tool_result", … }] }` | `tool/result`（`sourceEventSeqs` 关联 `tool/call`） |
| 轮次结束 | `step/end` + `turn/end` |

### Codex / ChatGPT CLI rollout

行 envelope：`{ timestamp, type, payload }`。`event_msg` 的 `user_message` / `agent_message` 是 `response_item` 的重复，忽略避免重复计数；以 `<` 开头的用户消息块（`<environment_context>`、`<user_instructions>`、`<system-reminder>` 等）是 harness 注入，不进入 prompt。

| Codex rollout | DSH SessionEvent |
| --- | --- |
| `session_meta` / `turn_context` | `SessionHeader`（id / cwd / createdAt / model） |
| `response_item message role=user`（`input_text`） | `turn/start` + `step/start` + `user/message` |
| `response_item message role=assistant`（`output_text`） | `assistant/message` |
| `response_item function_call` / `custom_tool_call` | `tool/call`（挂到最近 assistant 步骤） |
| `response_item function_call_output` / `custom_tool_call_output` | `tool/result`（按 `call_id` 跨行配对，`sourceEventSeqs` 关联） |
| `response_item reasoning` | 跳过（内容加密不可读） |
| 轮次结束 | `step/end` + `turn/end` |

### ChatGPT 网页导出 conversations.json

顶层是 JSON 数组（一个文件含全部会话），每个会话对象含 `mapping`（DAG：nodeId → `{ id, message, parent, children }`）。沿 active branch（`children` 最后一个）从 root 遍历得到主线程；`message: null` 的占位节点与 `author.role === 'system'` 跳过；时间戳是 Unix 秒（×1000 转 ms）。ChatGPT 是聊天，导出无 `cwd`，不归组工作区。

| conversations.json | DSH SessionEvent |
| --- | --- |
| 会话对象（`id` / `title` / `create_time`） | `SessionHeader`（id / createdAt）+ `session/title` |
| `mapping` 中 `author.role: "user"` 节点 | `turn/start` + `step/start` + `user/message` |
| `author.role: "assistant"` 节点 | `assistant/message` |
| `author.role: "tool"` 节点 | `tool/result`（挂最近一步） |
| `author.role: "system"` / `message: null` | 跳过 |
| 轮次结束 | `step/end` + `turn/end` |

### Cursor agent transcript

行结构：`{ role: "user" | "assistant", message: { content: [...] } }`，无 envelope。content 只有 `text` / `tool_use` 两种块（`input` 已是对象）。用户首条消息包在 `<user_query>` 标签里（剥离）；assistant 文本常有 `"[REDACTED]"` 哨兵（客户端隐私剥离，过滤）；transcript **不含 `tool_result`**（工具结果只在 UI 的 bubble store）→ 只导入调用历史；无时间戳 / model，会话 id 取文件名（composer uuid），无 `cwd`。

| Cursor transcript | DSH SessionEvent |
| --- | --- |
| `role: "user"`（`<user_query>` 包裹的 text） | `turn/start` + `step/start` + `user/message` |
| `role: "assistant"` 的 text 块 | `assistant/message` |
| `role: "assistant"` 的 `tool_use` 块 | `tool/call`（无 `tool/result`，transcript 不含结果） |
| `[REDACTED]` 哨兵 | 过滤 |
| 轮次结束 | `step/end` + `turn/end` |

### Gemini CLI 会话 JSON

存储：`~/.gemini/history/<slot>/chats/session-*.json`（一文件一 JSON 对象，非 JSONL）。顶层：`{ sessionId, projectHash, startTime, directories, kind, messages: [...] }`。消息类型：`user`（content 是 parts 数组）开新轮；`gemini`（字符串 content，可带 `thoughts` 与 `toolCalls`）是一步 assistant；`info`（CLI 系统通知：错误横幅、取消等）跳过。工具结果**内联**在与调用同一对象上（不同于 Claude 拆分消息）。

| Gemini 会话 JSON | DSH SessionEvent |
| --- | --- |
| 顶层（`sessionId` / `startTime` / `directories[0]`） | `SessionHeader`（id / createdAt / cwd） |
| `type: "user"`（parts 数组） | `turn/start` + `step/start` + `user/message` |
| `type: "gemini"` 字符串 content | `assistant/message` |
| `thoughts` 条目 | `reasoning` content block |
| `toolCalls[].args` + 内联 `result` | `tool/call` + `tool/result`（同一步，`sourceEventSeqs` 关联；`status: "error"` → `isError`） |
| `type: "info"` | 跳过 |
| 轮次结束 | `step/end` + `turn/end` |

会话头 `SessionHeader`：`version: 0`、`id: import-<源sessionId>`、`createdAt`（源时间戳，Cursor 无则取导入时刻）、`cwd`（源工作目录，ChatGPT 导出与 Cursor transcript 无）。

## 构建

纯 ESM，无编译步骤：`index.mjs` 即 Host 插件入口（转换核心在无依赖的 `convert.mjs`，可独立单测），无需 `tsc` / 打包。

## 安装

```bash
dsh plugin --profile web add -w link:/path/to/dsh-chat-import
```

或（已发布 npm 后）：

```bash
dsh plugin --profile web add dsh-chat-import
```

`dsh plugin` 是 pnpm 转发器：`add` 后识别 `dsh.bundle` 声明，把 `cordis.patch.yml` 的 `insert` 行收编进 profile 的 bundles，重启 dsh 即生效。本地开发建议用 `link:`（符号链接）。

## 兼容性

- **依赖面**：仅消费 host 公开插件 API（`sessionPersistence` / `fs` / `tools` / `workspaceRegistry`）与 `@deepseek-ai/dsh-tools`（已声明为 `peerDependencies`，实测版本 `0.1.0-rc.6`）。

| 源格式 | 存储位置 | 导入工具 | 实测 |
| --- | --- | --- | --- |
| Claude Code | `~/.claude/projects/<slug>/<sessionId>.jsonl` | `import_claude` | ✅ 44 tool/call + 44 tool/result 落盘、`load OK` |
| Codex / ChatGPT CLI | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | `import_codex` | ✅ 单测 + mock 集成（`npm test`） |
| ChatGPT 网页导出 | 导出 ZIP → `conversations.json` | `import_chatgpt` | ✅ 单测 + mock 集成（`npm test`） |
| Cursor | `~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl` | `import_cursor` | ✅ 单测 + mock 集成（`npm test`） |
| Gemini CLI | `~/.gemini/history/<slot>/chats/session-*.json` | `import_gemini` | ✅ 单测 + mock 集成（`npm test`） |

- **实测**：2026-08 于 `dsh 0.1.0-rc.6` 的 web profile 验证「导入 → resume → 工作区归组」全链路；`npm test`（50 个用例）覆盖五种源格式的转换纯函数与 mock 集成路径。

## 卸载

从 profile 的 bundles 中移除 `import-claude`（即 `cordis.patch.yml` 的 `insert` 行），重启 dsh 后插件不再加载。已导入的会话保留在 DSH 数据目录，不受卸载影响。

## 使用

在挂载了本插件的会话里调用工具：

```
import_claude({ path: "C:\\Users\\<you>\\.claude\\projects\\<slug>\\<sessionId>.jsonl" })
import_codex({ path: "C:\\Users\\<you>\\.codex\\sessions\\2026\\05\\18\\rollout-2026-05-18T21-14-16-xxxx.jsonl" })
import_chatgpt({ path: "C:\\Users\\<you>\\Downloads\\chatgpt-export\\conversations.json" })
import_cursor({ path: "C:\\Users\\<you>\\.cursor\\projects\\<slug>\\agent-transcripts\\<composer-id>\\<composer-id>.jsonl" })
import_gemini({ path: "C:\\Users\\<you>\\.gemini\\history\\<slot>\\chats\\session-2026-04-17T18-09-b26d7f99.json" })
```

`import_claude` / `import_codex` / `import_cursor` / `import_gemini` 行为一致：`path` 可以是单个文件，也可以是目录；可选 `sessionId` 覆盖目标 DSH 会话 id（默认 `import-<源sessionId>`，Cursor 取文件名 composer id）。返回 `{ mode: 'single', sessionId, turns, messages, toolCalls, skipped, alreadyImported }`；导入后刷新会话列表即可看到新会话，且已挂接到其工作目录。

`import_chatgpt` 不同：conversations.json 一个文件含**全部**会话，单文件也返回批量形态 `{ mode: 'batch', total, imported, alreadyImported, skipped, failed, results: [...] }`（`total` 是会话数，`results` 每项是一个会话）；ChatGPT 导出无 `cwd`，导入的会话不归组工作区。

### 批量导入（目录）

```js
import_claude({ path: "C:\\Users\\<you>\\.claude\\projects" })
import_codex({ path: "C:\\Users\\<you>\\.codex\\sessions" })
import_chatgpt({ path: "C:\\Users\\<you>\\Downloads\\chatgpt-export" })
import_cursor({ path: "C:\\Users\\<you>\\.cursor\\projects" })
import_gemini({ path: "C:\\Users\\<you>\\.gemini\\history" })
```

目录模式递归扫描（`recursive: false` 可只扫顶层）所有 `.jsonl`（Claude / Codex / Cursor）或 `.json`（ChatGPT / Gemini）；每个文件独立导入为一个会话（ChatGPT 文件内每个会话独立导入）；非 transcript / 空文件跳过。返回 `{ mode: 'batch', total, imported, alreadyImported, skipped, failed, results: [...] }`，`results` 每项含 `path`、`status`（`imported` / `already-imported` / `skipped` / `failed`）及会话统计。

## 范围边界

- 源 transcript 只读，绝不原地改写；DSH 历史事件同样 append-only（deep-frozen），只新增、不改写。
- 不修改 DSH 引擎、apiproxy 或官方 UI 包；不发布任何服务，无需 isolate realm。
- 读取工作区之外的 transcript 路径时，要求会话沙箱允许访问该路径。
- 已知边界：不导入 `permission`、`summary` 等辅助记录；`is_error` 的 `tool_result` 保留错误标记但丢弃其 `message.content` 之外的附加字段；Codex 的 `reasoning` 内容加密不可读，跳过（计划 v1.2 补全）；ChatGPT 导出只重建主线程（分支取最后 child），工具消息按文本挂最近一步、不还原工具参数结构；Cursor transcript 不含 `tool_result`（工具结果只在 UI bubble store），仅导入 `tool/call` 历史，且 `[REDACTED]` 文本被过滤；Gemini 按 2026-04 观测格式导入（官方未发布稳定 schema），`thoughts` 映射 `reasoning`、内联工具结果有则导入；目前支持 Claude Code JSONL、Codex/ChatGPT rollout、ChatGPT 网页导出、Cursor agent transcript 与 Gemini CLI 会话五种源格式。

## 测试

```bash
npm test
```

`test/convert.test.mjs` 覆盖五种源格式的纯转换逻辑（回合平衡、工具关联、标题、畸形行、注入过滤、重复消息去重、mapping 分支/占位节点、REDACTED 过滤、内联工具结果）；`test/index.test.mjs` 用 mock 的 `fs` / `sessionPersistence` / `tools` / `workspaceRegistry` 走完整 `apply → execute` 路径，并校验返回值符合输出 schema。
