<p align="center">
  <a href="README.md">English</a> | <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <img src="assets/import.svg" width="120" alt="dsh-chat-import">
</p>

# DSH Chat Import

> 把 Claude Code、Codex、ChatGPT、Cursor、Gemini、Reasonix 与 opencode 的聊天记录导入 DeepSeek Harness，并在上次停下的地方继续聊下去。

[![npm version](https://img.shields.io/npm/v/dsh-chat-import)](https://www.npmjs.com/package/dsh-chat-import)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/Nwflower/dsh-chat-import)](https://github.com/Nwflower/dsh-chat-import)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)
**已收录于：** [Awesome DeepSeek Harness](https://github.com/0xsline/awesome-deepseek-harness) · [Awesome DSH Plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) · [Awesome DSH Plugins](https://github.com/Dominic789654/awesome-deepseek-harness) · [npm](https://www.npmjs.com/package/dsh-chat-import)
**更新日志（英文）：** [CHANGELOG.md](CHANGELOG.md)

`dsh-chat-import` 把外部 Agent 的聊天记录变成 **全保真、可继续（resume）的 DeepSeek Harness 会话**——工具调用、思考过程一应俱全。它**只读**源文件（绝不改写你的原始记录）、不碰 DSH 引擎，每次导入都通过公开的 `sessionPersistence` 服务追加一条全新的、事件平衡的会话日志，并按源 `cwd` 挂接到对应工作区。

`7 种来源` · `复制式、只读源` · `可无缝续聊` · `自动归组工作区`

## ✨ 功能特性

- **📥 导入 7 种来源** — Claude Code JSONL、Codex / ChatGPT CLI rollout、ChatGPT 网页导出、Cursor agent transcript、Gemini CLI 会话、Reasonix 会话与 opencode SQLite 历史库。一个插件，每种来源一条命令。
- **🔍 全保真** — 工具调用历史映射为真实的 `tool/call` + `tool/result`（含错误标记与 `sourceEventSeqs` 关联），思考块映射为 `reasoning`，多步 assistant 消息完整保留。
- **▶️ 可无缝续聊** — 每次导入都合成一条平衡、可加载的会话（`turn/start` → `step/start` → `user/message` → `assistant/message` → `tool/call`/`tool/result` → `step/end` → `turn/end`）：点开即可继续对话。
- **🗂 自动归组工作区** — 会话按源 `cwd` 挂进对应工作区（不再「未分组」）；源有记录时保留 sessionId、标题、模型与创建时间。
- **🔁 幂等** — 重复导入自动跳过已存在的会话；畸形行计数上报、绝不中断导入。
- **📦 批量导入** — 指向一个目录（或整个 opencode 数据库），每个文件 / 每段对话都成为独立会话，并返回逐文件汇总。

## 🚀 快速开始

```bash
# 1. 安装（npm 包）
dsh plugin --profile web add dsh-chat-import

# 或从本地源码安装
dsh plugin --profile web add -w link:/path/to/dsh-chat-import
```

2. 在任意 DSH 会话里导入单个文件或整个目录：

```
import_claude({ path: "~/.claude/projects" })
```

3. 刷新一次会话列表，打开导入的会话，继续对话——它会从源记录停下的地方无缝接上。

## 🗂 能导入什么？

| 来源 | 存储位置 | 导入工具 |
| --- | --- | --- |
| Claude Code | `~/.claude/projects/<slug>/<sessionId>.jsonl` | `import_claude` |
| Codex / ChatGPT CLI | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | `import_codex` |
| ChatGPT（网页导出） | 导出 ZIP → `conversations.json` | `import_chatgpt` |
| Cursor | `~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl` | `import_cursor` |
| Gemini CLI | `~/.gemini/history/<slot>/chats/session-*.json` | `import_gemini` |
| Reasonix | `~/.reasonix/sessions/desktop-*.jsonl` | `import_reasonix` |
| opencode | `~/.local/share/opencode/opencode.db`（SQLite） | `import_opencode` |

每次导入都会保留源实际记录的内容——sessionId、`cwd`、标题、模型、创建时间、工具调用与结果、思考过程；数据较少的格式（Cursor transcript、ChatGPT 导出）导入其已有的内容，并明确报告缺失的部分。

## 🛠 使用

> **注意**：导入会即时落盘，但 DSH 的会话列表不会自动刷新——导入后请刷新页面（或会话列表）才能看到新会话。

```
import_claude({ path: "C:\Users\<you>\.claude\projects\<slug>\<sessionId>.jsonl" })
import_codex({ path: "C:\Users\<you>\.codex\sessions\2026\05\18\rollout-2026-05-18T21-14-16-xxxx.jsonl" })
import_chatgpt({ path: "C:\Users\<you>\Downloads\chatgpt-export\conversations.json" })
import_cursor({ path: "C:\Users\<you>\.cursor\projects\<slug>\agent-transcripts\<composer-id>\<composer-id>.jsonl" })
import_gemini({ path: "C:\Users\<you>\.gemini\history\<slot>\chats\session-2026-04-17T18-09-b26d7f99.json" })
import_reasonix({ path: "C:\Users\<you>\.reasonix\sessions\desktop-202606020721-1.jsonl" })
import_opencode({ path: "C:\Users\<you>\.local\share\opencode\opencode.db" })
```

`import_claude` / `import_codex` / `import_cursor` / `import_gemini` / `import_reasonix` 行为一致：

- `path` 可以是**单个文件或目录**（目录递归扫描，每个文件成为独立会话）。
- 可选 `sessionId` 覆盖目标 DSH 会话 id（默认 `import-<源sessionId>`；Cursor 取文件名的 composer id，Reasonix 取文件名 stem）。
- 返回 `{ mode: 'single', sessionId, turns, messages, toolCalls, skipped, alreadyImported }`。

`import_chatgpt` 不同：一个 `conversations.json` 包含**全部**会话，所以即使单文件也返回批量形态 `{ mode: 'batch', total, imported, alreadyImported, skipped, failed, results: [...] }`（每个 `results` 项是一个会话）。ChatGPT 导出无 `cwd`，导入的会话不归组工作区。

`import_opencode` 同样恒返回批量形态——一个 `opencode.db` 包含**全部**会话。`path` 可以是 `.db` 文件或其数据目录；可选 `sessionIds` 只导入指定会话；可选 `fullHistory: true` 导入全量消息历史、忽略 opencode 的对话压缩（默认 `false`——压缩会话按「最后一次摘要 + 保留尾巴」导入）。导入的会话保留 `directory` 作为 `cwd`，归组工作区。

## 🧩 数据模型

导入器按「直连人类提问」（`content` 为字符串的 `user` 记录）把每个 transcript 切成轮次，每轮合成一个闭合的 DSH 回合：

```
turn/start → step/start → user/message → assistant/message → (tool/call + tool/result) → step/end → turn/end
```

消息体带稳定 id 与 `surfaceOp: 'append'`；`tool/result` 通过 `sourceEventSeqs` 关联回对应的 `tool/call`。assistant 的 `source` 为 `{ kind: 'model', provider: 'claude-code', model: <源模型> }`；`tool/result` 的 source 为 `{ kind: 'tool', callId }`。`SessionHeader` 保留 `version: 0`、`id: import-<源sessionId>`、源 `createdAt` 与 `cwd`。

**call/result 配对不变量：** 每个 `tool/call` 必有对应 `tool/result`（`sourceEventSeqs` 指回其 call），且每个结果挂在**声明该调用所在的 step**——保证投影出的消息顺序合法（每条 `role: 'tool'` 消息紧跟在它应答的 `tool_calls` assistant 消息之后，中间绝不插入另一条 assistant）。当 transcript 对某个调用从未记录结果（会话中断、Cursor transcript 本身无结果）时，导入器在**该调用自己的 step** 补发一个空 `tool/result`（`content: []`），保证会话仍可续聊——模型 API 会拒绝「assistant 带 `tool_calls` 但缺对应 tool 消息」的历史。空内容不是虚构文本；wire 适配器会把空内容归一为 `"(no output)"`。

### Claude Code JSONL

主 transcript 在 `~/.claude/projects/<slug>/<sessionId>.jsonl`；`<sessionId>/subagents/**` 下的辅助 subagent / workflow 片段复用父 `sessionId`，会被跳过（绝不会顶替或并入主会话）。Claude 源格式先输出连续 assistant 记录、后置 `tool_result` 记录——结果按 `tool_use_id` 挂到**声明该调用所在的 step**，保证投影消息顺序合法；同一步内多个结果按该 step 的工具调用顺序对齐。`tool_use` 的结果未返回（会话中断）时，在**其所属 step** 补发空 `tool/result`。没有对应 `tool_use` 的孤儿 `tool_result` 会被丢弃并计数（`droppedToolResults`），绝不发出模型 API 会拒绝的孤儿 tool 消息。

| Claude Code JSONL | DSH SessionEvent |
| --- | --- |
| `{ type: "user", message.content: string }`（直连提问） | `turn/start` + `step/start` + `user/message` |
| `{ type: "assistant", content: [{ type: "text", text }] }` | `assistant/message` |
| `{ type: "assistant", content: [{ type: "thinking", … }] }` | `reasoning` content block |
| `{ type: "assistant", content: [{ type: "tool_use", … }] }` | `tool/call` + `tool-call` content block |
| `{ type: "user", content: [{ type: "tool_result", … }] }` | 挂到声明该调用所在 step 的 `tool/result`（`sourceEventSeqs` 关联 `tool/call`） |
| 轮次结束 | `step/end` + `turn/end` |

### Codex / ChatGPT CLI rollout

行 envelope：`{ timestamp, type, payload }`。`event_msg` 的 user/agent 消息是 `response_item` 的重复、被忽略；以 `<` 开头的用户消息块（`<environment_context>`、`<user_instructions>` 等）是 harness 注入，不进入 prompt。Codex `reasoning` 内容加密，跳过。`function_call` / `custom_tool_call` 无对应 `*_output` 记录（会话中断）时补发空 `tool/result`。

| Codex rollout | DSH SessionEvent |
| --- | --- |
| `session_meta` / `turn_context` | `SessionHeader`（id / cwd / createdAt / model） |
| `response_item message role=user`（`input_text`） | `turn/start` + `step/start` + `user/message` |
| `response_item message role=assistant`（`output_text`） | `assistant/message` |
| `response_item function_call` / `custom_tool_call` | `tool/call` + 最近 assistant 步骤的 `tool-call` content block |
| `response_item function_call_output` / `custom_tool_call_output` | `tool/result`（按 `call_id` 配对，`sourceEventSeqs` 关联） |
| `response_item reasoning` | 跳过（加密不可读） |
| 轮次结束 | `step/end` + `turn/end` |

### ChatGPT 网页导出（conversations.json）

顶层是 JSON 数组（一个文件、全部会话），每个会话含 `mapping` DAG。沿 active branch（最后一个 `children` 项）重建主线程；`message: null` 的占位节点与 `author.role === 'system'` 跳过；时间戳是 Unix 秒（×1000 转 ms）。导出无 `cwd`，会话不归组。

| conversations.json | DSH SessionEvent |
| --- | --- |
| 会话对象（`id` / `title` / `create_time`） | `SessionHeader` + `session/title` |
| `mapping` 中 `author.role: "user"` 节点 | `turn/start` + `step/start` + `user/message` |
| `author.role: "assistant"` 节点 | `assistant/message` |
| `author.role: "tool"` 节点 | 降级为最近一步 assistant 消息的文本块（导出无结构化 tool call） |
| `author.role: "system"` / `message: null` | 跳过 |
| 轮次结束 | `step/end` + `turn/end` |

### Cursor agent transcript

行结构：`{ role: "user" | "assistant", message: { content: [...] } }`。用户首条消息包在 `<user_query>` 里（剥离）；`[REDACTED]` 哨兵被过滤。transcript **不含 `tool_result`**（工具结果只在 UI 的 bubble store）、无时间戳 / model——会话 id 取文件名，无 `cwd`。因无任何结果，每个工具调用都会补发空 `tool/result`，保证导入的会话仍可续聊。

| Cursor transcript | DSH SessionEvent |
| --- | --- |
| `role: "user"`（`<user_query>` 包裹的 text） | `turn/start` + `step/start` + `user/message` |
| `role: "assistant"` 的 text 块 | `assistant/message` |
| `role: "assistant"` 的 `tool_use` 块 | `tool/call` + 合成空 `tool/result`（transcript 无结果） |
| `[REDACTED]` 哨兵 | 过滤 |
| 轮次结束 | `step/end` + `turn/end` |

### Gemini CLI 会话 JSON

`~/.gemini/history/<slot>/chats/session-*.json`，一文件一 JSON 对象。消息类型：`user`（parts 数组）开新轮；`gemini`（字符串 content，可带 `thoughts` 与 `toolCalls`）是一步 assistant；`info`（CLI 通知）跳过。工具结果**内联**在与调用同一对象上；无结果的调用补发空 `tool/result`。

| Gemini 会话 JSON | DSH SessionEvent |
| --- | --- |
| 顶层（`sessionId` / `startTime` / `directories[0]`） | `SessionHeader`（id / createdAt / cwd） |
| `type: "user"`（parts 数组） | `turn/start` + `step/start` + `user/message` |
| `type: "gemini"` 字符串 content | `assistant/message` |
| `thoughts` 条目 | `reasoning` content block |
| `toolCalls[].args` + 内联 `result` | `tool/call` + `tool/result`（`status: "error"` → `isError`） |
| `type: "info"` | 跳过 |
| 轮次结束 | `step/end` + `turn/end` |

### Reasonix 会话 JSONL

`~/.reasonix/sessions/<stem>.jsonl`，无 envelope 的 OpenAI 风格消息；兼容 v1（嵌套 `{ id, type: "function", function: { name, arguments } }`）与 v2（扁平 `{ id, name, arguments }`）两种 `tool_calls`。工具结果（`role: "tool"` 带 `tool_call_id`）按 `tool_calls[].id` 配对；`tool_calls` 块之后没有 `role: "tool"` 消息时补发空 `tool/result`。同目录 `<stem>.meta.json` 提供 `workspace` → `cwd` 与 `summary` → 钉住标题；转录与 meta 均无时间戳时，创建时间回退到文件名内嵌时刻。V2 WAL 伴生文件（`.events.jsonl` / `.conflicts.jsonl` / `.guardian.jsonl`）在目录扫描时排除。

| Reasonix JSONL | DSH SessionEvent |
| --- | --- |
| `role: "user"`（字符串 content） | `turn/start` + `step/start` + `user/message` |
| `role: "assistant"` 字符串 content | `assistant/message` |
| `reasoning_content` | `reasoning` content block |
| `tool_calls[].function`（v1 嵌套 / v2 扁平） | `tool/call` |
| `role: "tool"` 带 `tool_call_id` | `tool/result`（按 `tool_call_id` 配对） |
| `<stem>.meta.json`（`workspace` / `summary`） | `cwd` / `session/title` |
| 轮次结束 | `step/end` + `turn/end` |

### opencode 会话数据库（SQLite）

读取 `~/.local/share/opencode/opencode.db` 的 `session` / `message` / `part` 三表（`event` 表只是部分镜像、`session_message` / `session_input` 为空，忽略）。工具结果**内联**在 tool part 的 `state` 里，因此一个 part 同时产出 `tool/call` + `tool/result`；没有 output 的 tool part 也发空结果，保证 call/result 配对。默认尊重 opencode 的**对话压缩**：只导入最后一次压缩摘要（前置 reasoning 块）+ `tail_start_id` 之后的消息；`fullHistory: true` 导入全量。

| opencode DB | DSH SessionEvent |
| --- | --- |
| `session` 行（`id` / `title` / `directory` / `time_created` / `model`） | `SessionHeader` + `session/title` |
| `message` 为 `role: "user"`（text part） | `turn/start` + `step/start` + `user/message` |
| `message` 为 `role: "assistant"` | `assistant/message` |
| part `type: "text"` | `text` content block |
| part `type: "reasoning"` | `reasoning` content block |
| part `type: "tool"` | `tool/call` + `tool/result`（`state.status === "error"` → `isError`） |
| part `type: "file"` | `text` 块 `[image: <filename>]` |
| part `type: "patch"` | `text` 块 `[patch: <N> files]` |
| part `type: "subtask"` | `text` 块 `[subtask: <command> — <description>]` |
| part `type: "compaction"`（`tail_start_id`） | 丢弃 `tail_start_id` 之前的历史；摘要成为前置 reasoning |
| 轮次结束 | `step/end` + `turn/end` |

## ⚙️ 兼容性

- 只消费 host 公开插件 API（`sessionPersistence` / `fs` / `tools` / `workspaceRegistry`）与 `@deepseek-ai/dsh-tools`（声明为 `peerDependencies` 范围 `^0.1.0-rc.6`，当前解析到 `0.1.0-rc.6`，即插件实测版本）。
- 需要 **Node.js >= 22.13**——`node:sqlite`（`DatabaseSync`，`import_opencode` 使用）免 `--experimental-sqlite` flag 的首个版本（见 `package.json` 的 `engines`）。

| 源格式 | 导入工具 | 实测 |
| --- | --- | --- |
| Claude Code | `import_claude` | ✅ 44 tool/call + 44 tool/result 落盘、`load OK` |
| Codex / ChatGPT CLI | `import_codex` | ✅ 单测 + mock 集成（`npm test`） |
| ChatGPT 网页导出 | `import_chatgpt` | ✅ 单测 + mock 集成（`npm test`） |
| Cursor | `import_cursor` | ✅ 单测 + mock 集成（`npm test`） |
| Gemini CLI | `import_gemini` | ✅ 单测 + mock 集成（`npm test`） |
| Reasonix | `import_reasonix` | ✅ 单测 + mock 集成（`npm test`）；55 个真实会话 dry-run |
| opencode | `import_opencode` | ✅ 单测 + mock 集成（`npm test`） |

- **实测（Tested）**：`dsh 0.1.0-rc.6` + `dsh-tools 0.1.0-rc.6`——2026-08 于 web profile 验证「导入 → resume → 工作区归组」全链路；`npm test`（79 个用例）覆盖七种源格式的转换纯函数与 mock 集成路径。
- **预期兼容（Expected）**：`dsh-tools ^0.1.0-rc.6`——`dsh 0.1.x` 线，与宿主安装使用同一区间。
- **区间外（Out of band）**：`<0.1.0-rc.6` 与 `>=0.2.0` 未测试——`dsh` 主版本升级后先跑 headless 冒烟，再更新本矩阵。

## 🔒 安全与边界

- 源 transcript 只读、绝不原地改写；DSH 历史事件 append-only（deep-frozen）——只新增、绝不修改既有事件。
- 插件不修改 DSH 引擎、apiproxy 或官方 UI 包；不发布任何服务，无需 isolate realm。
- 读取工作区之外的 transcript 需要会话沙箱允许访问该路径。
- 已知边界：不导入 `permission` / `summary` 等辅助记录；`is_error` 的 `tool_result` 保留错误标记但丢弃 `message.content` 之外的附加字段；Claude subagent / workflow 片段 transcript 跳过（只有主 `<sessionId>.jsonl` 成为会话），无对应 `tool_use` 的孤儿 `tool_result` 丢弃并计数（`droppedToolResults`）；Codex `reasoning` 加密跳过；ChatGPT 导出只重建主线程（分支取最后 child）、工具消息降级为最近一步的文本块（导出无结构化 tool call，不再产生孤儿 `tool/result`）；Cursor transcript 无 `tool_result`（每个调用补发合成空 `tool/result`）、`[REDACTED]` 文本被过滤；Gemini 按 2026-04 观测格式导入（官方无稳定 schema）；Reasonix 读取 JSONL checkpoint（V2 WAL 排除）；opencode `patch` part 无 diff（只发 `[patch: <N> files]` 占位）、工具输出可能原样保留 ANSI 转义。
- **本次修复后需重新导入：** 已导入的会话是不可变日志——插件绝不改写既有历史，因此旧版本导入、缺少 call/result 配对的会话无法就地修复。删除旧会话后重新导入，即可获得配对不变量。

## 🧪 测试

```bash
npm test
```

`test/convert.test.mjs` 覆盖七种源格式的纯转换逻辑（回合平衡、工具关联、标题、畸形行、注入过滤、去重、mapping 分支、REDACTED 过滤、内联工具结果、v1/v2 工具调用形状、opencode part 映射与模型回退）；`test/index.test.mjs` 用 mock 的 `fs` / `sessionPersistence` / `tools` / `workspaceRegistry`（`import_opencode` 另用真实 SQLite 临时库）走完整 `apply → execute` 路径，并校验返回值符合输出 schema。

## 📦 安装与卸载

```bash
dsh plugin --profile web add dsh-chat-import        # npm 包
dsh plugin --profile web add -w link:/path/to/dsh-chat-import   # 本地源码（符号链接，开发推荐）
```

`dsh plugin` 是 pnpm 转发器：`add` 后识别 `dsh.bundle` 声明，把 `cordis.patch.yml` 的 `insert` 行收编进 profile 的 bundles，重启 dsh 即生效。

卸载：从 profile 的 bundles 移除 `import-claude` insert 行并重启 dsh。已导入的会话保留在 DSH 数据目录，不受影响。

## 📄 许可证

MIT — 见 [LICENSE](LICENSE)。
