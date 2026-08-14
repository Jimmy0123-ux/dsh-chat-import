<p align="center">
  <a href="README.md">English</a> | <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <img src="assets/import.svg" width="120" alt="dsh-chat-import">
</p>

# DSH Chat Import

> **一个插件，11 种来源** —— 全保真导入 DeepSeek Harness，无缝续聊，并可导出 / 同步回 Claude Code。

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-chat-import"><img src="https://img.shields.io/npm/v/dsh-chat-import" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/dsh-chat-import"><img src="https://img.shields.io/npm/dm/dsh-chat-import" alt="npm downloads"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="license: MIT"></a>
  <a href="package.json"><img src="https://img.shields.io/badge/node-%3E%3D22.13-339933?logo=node.js&logoColor=white" alt="Node.js >= 22.13"></a>
  <a href="https://github.com/Nwflower/dsh-chat-import/actions/workflows/ci.yml"><img src="https://github.com/Nwflower/dsh-chat-import/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/Nwflower/dsh-chat-import"><img src="https://img.shields.io/github/stars/Nwflower/dsh-chat-import" alt="GitHub stars"></a>
  <a href="https://awesome-dsh-plugin.com"><img src="https://awesome-dsh-plugin.com/badge.svg" alt="Awesome DSH Plugin"></a>
</p>

<p align="center">
  <b>已收录于：</b> <a href="https://github.com/0xsline/awesome-deepseek-harness">Awesome DeepSeek Harness</a> · <a href="https://github.com/awesome-dsh-plugin/awesome-dsh-plugin">Awesome DSH Plugin</a> · <a href="https://github.com/Dominic789654/awesome-deepseek-harness">Awesome DSH Plugins</a> · <a href="https://www.npmjs.com/package/dsh-chat-import">npm</a>
  &nbsp;&nbsp;·&nbsp;&nbsp; <b>更新日志（英文）：</b> <a href="CHANGELOG.md">CHANGELOG.md</a>
</p>

`dsh-chat-import` 从 **Claude Code、Codex、ChatGPT、Cursor、Gemini、Reasonix、opencode、ZCode、Grok Build、OpenClaw 与 Hermes** 导入聊天历史——工具调用、思考过程一应俱全——成为**全保真、可继续（resume）的 DeepSeek Harness 会话**。导入**只读**源文件（绝不改写你的原始记录）、不碰 DSH 引擎，每次导入都通过公开的 `sessionPersistence` 服务追加一条全新的、事件平衡的会话日志，并按源 `cwd` 挂接到对应工作区。

反向方向同样覆盖：`export_claude` 把 DSH 会话序列化回 Claude Code JSONL（只读——绝不修改你的 DSH 日志），Claude Code 可用 `--resume` 加载续聊；`sync_to_claude` 再把会话新增轮次增量写回 Claude Code 文件——带守卫、绝不静默覆盖。

## ✨ 功能特性

**📥 导入**

- **11 种来源，每种一条命令** — Claude Code JSONL、Codex / ChatGPT CLI rollout、ChatGPT 网页导出、Cursor agent transcript、Gemini CLI 会话、Reasonix 会话、opencode SQLite 历史库、ZCode（z.ai CLI）SQLite 历史库、Grok Build 会话目录、OpenClaw 会话 JSONL 与 Hermes SQLite / JSONL 存储。
- **🔍 全保真** — 工具调用历史映射为真实的 `tool/call` + `tool/result`（含错误标记与 `sourceEventSeqs` 关联），思考块映射为 `reasoning`，多步 assistant 消息完整保留。
- **📦 批量导入** — 指向一个目录（或整个 opencode / ZCode / Hermes 数据库），每个文件 / 每段对话都成为独立会话，并返回逐文件汇总。

**▶️ 续聊**

- **可无缝续聊** — 每次导入都合成一条平衡、可加载的会话（`turn/start` → `step/start` → `user/message` → `assistant/message` → `tool/call`/`tool/result` → `step/end` → `turn/end`）：点开即可继续对话。
- **🗂 自动归组工作区** — 会话按源 `cwd` 挂进对应工作区（不再「未分组」）；源有记录时保留 sessionId、标题、模型与创建时间。

**🔄 反向**

- **📤 导出回 Claude Code** — `export_claude` 把任意 DSH 会话（导入的或原生的）序列化为 `<outputDir>/<slug>/<uuid>.jsonl` 的 Claude Code JSONL，可直接 `--resume`：user / assistant / 工具调用与结果、思考块、会话标题都按 Claude 记录布局重建。
- **🔄 反向同步回 Claude Code** — `sync_to_claude` 把 DSH 会话的**新增完整轮次**增量写回导入源文件（或 `export_claude` 副本），链续到文件最后一条记录；文件缩小 / 外部修改 / 尾链失配 / 并发写者一律上报、绝不覆盖，格式预检失败自动回滚。

**🛡️ 护栏**

- **🔁 幂等 + 增量续写** — 重复导入未变化的源文件直接跳过（不重新读文件）；增长的源文件只把**新增轮次** append 进同一个 DSH 会话（`seq` 连续续写，已导入内容一个字节不动）；源文件被截断时检测 `sourceShrunk` 并报告、不触碰已导入会话；畸形行计数上报、绝不中断导入。
- **🧮 上下文预算保护** — 导入会话没有 provider 配置，dsh 不会自动压缩它们（routedTarget 解析失败），全量历史灌入后 resume 直接 400。超长会话按上下文预算裁剪（预算解析优先级：`budget` 参数 > 环境变量 `DSH_IMPORT_CONTEXT_BUDGET` > `agentDefaultModel` + `llm` 动态模型窗口 > 静态默认 550k）：单条内容上限（文本 ≤16K 字符、工具结果 ≤40K 字符，保留头 75% + 尾）、消息级预算截断（最早 3 条 user 文本 + 压缩摘要 + 尾部消息）、以及单条消息仍超预算一半时直接丢弃的兜底。裁剪结果显式上报（`trimmed`：预算、token 估算、裁剪计数）。

## 🚀 快速开始

**1. 安装** — 把插件加进 profile：

```bash
dsh plugin --profile web add dsh-chat-import                    # npm 包
dsh plugin --profile web add -w link:/path/to/dsh-chat-import   # 本地源码（符号链接）
```

**2. 导入** — 在任意 DSH 会话里导入单个文件或整个目录：

```
import_claude({ path: "~/.claude/projects" })
```

**3. 续聊** — 刷新一次会话列表，打开导入的会话，继续对话——它会从源记录停下的地方无缝接上。

## 🗂 能导入 / 导出什么？

| 来源 | 存储格式 | 存储位置 | 导入工具 |
| --- | --- | --- | --- |
| **Claude Code** | JSONL 转录 | `~/.claude/projects/<slug>/<sessionId>.jsonl` | `import_claude` |
| **Codex / ChatGPT CLI** | JSONL rollout | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | `import_codex` |
| **ChatGPT**（网页导出） | ZIP → `conversations.json` | 导出压缩包（任意路径） | `import_chatgpt` |
| **Cursor** | JSONL transcript | `~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl` | `import_cursor` |
| **Gemini CLI** | JSON 会话 | `~/.gemini/history/<slot>/chats/session-*.json` | `import_gemini` |
| **Reasonix** | JSONL 会话 | `~/.reasonix/sessions/desktop-*.jsonl` | `import_reasonix` |
| **opencode** | SQLite 数据库 | `~/.local/share/opencode/opencode.db` | `import_opencode` |
| **ZCode**（z.ai CLI） | SQLite 数据库 | `~/.zcode/cli/db/db.sqlite` | `import_zcode` |
| **Grok Build** | 会话目录 | `~/.grok/sessions/<project>/<session_id>/`（`summary.json` + `chat_history.jsonl`） | `import_grokbuild` |
| **OpenClaw** | JSONL 会话 | `~/.openclaw/agents/<agent>/sessions/*.jsonl` | `import_openclaw` |
| **Hermes** | SQLite + JSONL | `~/.hermes/`（Windows `%LOCALAPPDATA%\hermes`）：`state.db` + `sessions/*.jsonl` | `import_hermes` |

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
import_zcode({ path: "C:\Users\<you>\.zcode\cli\db\db.sqlite" })
import_grokbuild({ path: "C:\Users\<you>\.grok\sessions\<project>\<session_id>" })
import_openclaw({ path: "C:\Users\<you>\.openclaw\agents\<agent>\sessions\<session>.jsonl" })
import_hermes({ path: "C:\Users\<you>\AppData\Local\hermes\state.db" })
```

**`import_claude` / `import_codex` / `import_cursor` / `import_gemini` / `import_reasonix` / `import_openclaw`** 行为一致：

- `path` 可以是**单个文件或目录**（目录递归扫描，每个文件成为独立会话）。
- 可选 `sessionId` 覆盖目标 DSH 会话 id（默认 `import-<源sessionId>`；Cursor 取文件名的 composer id，Reasonix 取文件名 stem）。重导时变更它会以新 id 另存一份完整副本（旧会话原样保留）。
- 可选 `force: true`：即使已导入也以新 id（`import-<sessionId>-<n>`，`n` 为下一个空闲后缀）另存一份**完整副本**——旧会话绝不修改、绝不归档。
- 返回 `{ mode: 'single', sessionId, turns, messages, toolCalls, skipped, alreadyImported, status }`，`status` 为 `imported` | `already-imported` | `appended` | `skipped`；另含可选 `appendedTurns` / `appendedEvents`（增长续写）、`sourceShrunk`（源截断）、`changedInPlace`（既有轮次内变化，append-only 无法改写）、`argsChanged`（导入参数变化）、`budgetChanged`（上下文预算变化）、`backfilled`（旧版本导入回填 registry 基线）、`forceImported: { previous, current }`（force / sessionId 变更副本）与 `droppedBoundaryResults`。
- 可选 `budget`（整数 token）设置本次导入的上下文预算（解析优先级：本参数 > 环境变量 `DSH_IMPORT_CONTEXT_BUDGET` > 动态模型窗口 > 静态默认 550k）。当三层保护实际生效时，返回值带 `trimmed: { budget, source, originalTokens, estimatedTokens, croppedBlocks, droppedTurns, droppedMessages, droppedToolCalls, droppedToolResults, droppedOversized, summaryInserted }`——详见数据模型的「上下文预算保护」。

**`import_chatgpt`** 不同：一个 `conversations.json` 包含**全部**会话，所以即使单文件也返回批量形态 `{ mode: 'batch', total, imported, alreadyImported, appended, skipped, failed, results: [...] }`（每个 `results` 项是一个会话，status 为 `imported` | `already-imported` | `appended` | `skipped` | `failed`）。增量逻辑逐会话生效：增长的会话被 append，从导出里消失的会话报进 `missingFromSource`（其会话原样保留），`force: true` 为每个会话建完整副本。ChatGPT 导出无 `cwd`，导入的会话不归组工作区。

**`import_opencode`** 同样恒返回批量形态——一个 `opencode.db` 包含**全部**会话。`path` 可以是 `.db` 文件或其数据目录；可选 `sessionIds` 只导入指定会话；可选 `fullHistory: true` 导入全量消息历史、忽略 opencode 的对话压缩（默认 `false`——压缩会话按「最后一次摘要 + 保留尾巴」导入）。`fullHistory` 计入导入参数指纹：换值重导会报 `argsChanged`（改用 `force: true` 切换）。数据库按 DB 级指纹（version + size）判定：未变的库不重读 SQLite 直接跳过；逐会话增长 append、压缩使轮次变少报 `sourceShrunk`。导入的会话保留 `directory` 作为 `cwd`，归组工作区。

**`import_zcode`** 同样恒返回批量形态——一个 `db.sqlite` 包含**全部** ZCode（z.ai 官方 CLI）会话。`path` 可以是 `.db` 文件、包含 `db.sqlite` 的数据目录（目录模式自动定位，无递归），或 `zcode://<sessionId>` 伪路径（走默认 `~/.zcode/cli/db/db.sqlite`，只导该会话）；可选 `sessionIds` 只导入指定会话。数据库按 DB 级指纹（version + size）判定：未变的库不重读 SQLite 直接跳过；逐会话增长 append、压缩使轮次变少报 `sourceShrunk`。导入的会话保留 `directory` 作为 `cwd`，归组工作区。db 不可用时回退旧版 `transcript.jsonl` 布局。

**`import_grokbuild`** 把单个会话目录（含 `summary.json` + `chat_history.jsonl`）当作单会话导入，或把 `~/.grok/sessions` / `~/.grok/archived_sessions` 根目录当作递归批量扫描（每个 `summary.json` 成为独立会话）。标题按 `generated_title` > `session_summary` 解析（显式标题钉 `session/title` 事件），空白时回退首问；`reasoning`（加密内部状态）与 `system`（harness 注入）记录过滤并计数。导入的会话保留 `summary.json` 的 `info.cwd`，归组工作区。

**`import_hermes`** 对 `state.db` 恒返回批量形态——SQLite 权威索引包含**全部** Hermes 会话（兼容列名变体 `cwd`/`directory`、`started_at`/`created_at`/`ended_at`/`updated_at`）。db 不可用时回退递归扫描 `sessions/*.jsonl`（flat 或 nested 行，每文件一个会话；单个 `.jsonl` 按单会话导入）。导入的会话保留记录的 `cwd`，归组工作区。

## 🔁 增量续写（重导）

重导**同一源路径**绝不改写已导入历史——幂等 registry 落盘在 `$DSH_HOME/dsh-chat-import/imports.json`（`$DSH_HOME` 缺省 `~/.dsh`），以源文件**绝对路径**为键（不是源 sessionId——不同文件可能共享同一 sessionId，绝不能互相覆盖）：

| 重导时的源文件状态 | 行为 |
| --- | --- |
| 未变化（内容指纹 + 大小一致） | 跳过（`already-imported`），不重新读文件 |
| 增长（新增完整轮次） | 把新轮次 append 进**同一个** DSH 会话：`seq` 从已存日志续写（以实际日志为准，即使上次导入后你在 DSH 里又聊过），`data.turn` 用源编号，不重复写 `session/imported` 标记与标题 |
| 既有轮次内增长（轮数不变） | 跳过 + `changedInPlace`（append-only 无法改写已导入轮次） |
| 截断（轮数变少） | 跳过 + `sourceShrunk`；已导入会话原样保留——需要完整新副本用 `force: true` |
| `force: true` | 以 `import-<sessionId>-<n>` 另存完整副本；旧会话绝不修改 |
| 显式 `sessionId` 变更 | 以新 id 另存完整副本（force 副本语义）；旧会话保留 |
| 导入参数变化（如 opencode `fullHistory`） | 跳过 + `argsChanged` |
| 上下文预算变化（参数 / 环境变量 / 动态解析） | 跳过 + `budgetChanged`（语义同 `argsChanged`；记录保留旧预算，直到 `force: true` 按新预算重导） |

registry 记录形如 `{ kind, dshId, turns, events, sizeBytes, version, args, budget, importedAt }`（多会话源带逐会话/逐对话子表）；缺失或损坏容错（按空 registry 处理，下次导入重建）。registry 写入全部原子化（temp + fsync + rename）并在进程内串行化，直接用 `node:fs/promises`——绝不用 `ctx.fs`（沙箱会拒 `~/.dsh` 写入）。

## 📤 导出 — DSH → Claude Code JSONL

反向方向：`export_claude` 把现有 DSH 会话（导入的或原生的）序列化为 Claude Code 可用 `--resume` 加载的 JSONL transcript。会话日志经 `sessionPersistence` **只读**读取（`list` + `readFrom`，绝不 `load` / `prepare`、绝不改写）：

```
export_claude({ sessionId: "import-019f5f27-…" })
export_claude({ sessionId: "…", cwd: "D:\work\proj", outputDir: "D:\backup\claude-projects", dryRun: true })
```

- `sessionId`（必填）— 要导出的 DSH 会话。
- `cwd`（可选）— 覆盖会话 header 的 `cwd`；缺省取 header 值，两者皆无时导出报错。
- `outputDir`（可选）— Claude Code 的 `projects` 根目录；缺省 `~/.claude/projects`。文件写到 `<outputDir>/<slug>/<uuid>.jsonl` —— 与 Claude Code 相同的 `<slug>/<uuid>.jsonl` 布局（文件名是全新的 UUID v4，且写入用 `createIfAbsent`，绝不覆盖已有文件）。
- `dryRun`（可选）— 只序列化并返回目标路径与统计，不写盘。

导出器按 DSH 事件日志的 `seq` 顺序重建 Claude 记录序列：`mode` + `permission-mode` 头，随后 `user` / `assistant` / `tool_result` 记录——工具结果挂在声明其 `tool_use` 的 assistant 上（`parentUuid` / `sourceToolAssistantUUID`，并行结果扇出到同一 assistant）、`session/title` 变成 `ai-title`、`reasoning` 变成 `thinking` 块（空 `signature`）、`tool_use` 的 input 从调用参数解析。中断的会话在末尾为未返回结果的调用补发空 `tool_result`；无对应调用的孤儿结果丢弃并计数。返回值带 `mapping` 对象（源会话 id → 新 uuid、文件路径、记录计数），为后续反向同步 registry（REQ-24/36）预留。

**边界：** 导出的 `thinking` 块带空 `signature`——Claude Code 在 resume 时会丢弃这类思考块（文档化的降级）。非人类直连的 user 消息跳过并计数（`skippedInjections`）；非 text 内容块（如图片）跳过并计数（`skippedBlocks`）。写工作区之外的目标路径需要会话沙箱放行。

## 🔄 反向同步 — 增量写回 Claude Code

反向方向的另一半：`sync_to_claude` 把 DSH 会话的**新增完整轮次**追加回 Claude Code JSONL 文件，让文件持续可被 `--resume` 加载。它绝不改写既有历史——只追加已由 `turn/end` 闭合的完整轮（`turn/start` → … → `turn/end`）；仍在进行中的半开轮次跳过（`incompleteFinalTurn`）。

```
sync_to_claude({ sessionId: "import-019f5f27-…" })                     // 写回导入源文件
sync_to_claude({ sessionId: "…", target: "copy", dryRun: true })       // 对 export_claude 副本做预览
sync_to_claude({ sessionId: "…", target: "copy", force: true })        // 越过外部修改重锚定
```

- `sessionId`（必填）— 要写回的 DSH 会话；必须是本插件导入的会话（日志以 `session/imported` 标记开头；多会话源如 ChatGPT / opencode 与原生会话拒绝写回）。
- `target`（可选）— `"source"`（默认）追加到该会话的导入源文件；`"copy"` 追加到最近一次 `export_claude` 导出的副本（必须先导出，registry 才有 exports 映射）。追加记录携带目标文件的 `sessionId`，`parentUuid` 链续到文件最后一条记录。
- `force`（可选）— 跳过下方三闸守卫并**重锚定**桥到文件当前状态（水印 = 文件现在代表的事件数、链尾 = 当前文件尾 uuid），接受外部编辑过的文件；被覆盖的守卫仍会上报。
- `dryRun`（可选）— 完整跑一遍流程（含格式预检）但不写盘、不更新 registry。

**守卫——绝不静默覆盖**（违规一律返回 `status: "skipped"`）：

| 同步时的文件 / 日志状态 | 行为 |
| --- | --- |
| 目标文件缺失 | `skipped` + `reason: source-missing` |
| 文件比水印缩小 | `skipped` + `sourceShrunk` |
| 文件 size / version 被外部修改 | `skipped` + `conflictDetected: source-modified-externally` |
| 文件尾 uuid ≠ 水印的链尾 | `skipped` + `conflictDetected: tail-mismatch` |
| 并发写者抢先赢了 CAS 写入 | `skipped` + `conflictDetected: write-version-mismatch` |
| DSH 日志比水印短 | `skipped` + `storedShrunk` |
| 追加内容未过格式预检 | 回滚为写前内容 + `precheckFailed`（水印不推进） |

首次同步尚无水印：它以目标文件的实际事件数（转换实测）+ 链尾 uuid 为**基线**，登记 writeback，之后才写。写回成功后更新 registry 记录——`turns` 重转（后续重导保持幂等、不重复 append）、`events` 取已存日志长度、刷新 size/version 指纹，并记录 `writeback: { sessionUuid, filePath, lastWrittenSeq, lastWrittenTurn, prevUuid, lastSize, lastVersion, writtenAt }`。尾部序列化复用 `export.mjs` 核心（无 mode / permission-mode / ai-title 头，首条记录链到 `prevUuid`）——调用声明在水印之前、结果落在尾部的 `tool/result` 按孤儿丢弃计数，写回绝不破坏文件布局。用真实 `claude --resume` 加载写回文件是此方向的发布门槛。

## 🧩 数据模型

导入器按「直连人类提问」（`content` 为字符串的 `user` 记录）把每个 transcript 切成轮次，每轮合成一个闭合的 DSH 回合：

```
turn/start → step/start → user/message → assistant/message → (tool/call + tool/result) → step/end → turn/end
```

消息体带稳定 id 与 `surfaceOp: 'append'`；`tool/result` 通过 `sourceEventSeqs` 关联回对应的 `tool/call`。assistant 的 `source` 为 `{ kind: 'model', provider: 'claude-code', model: <源模型> }`；`tool/result` 的 source 为 `{ kind: 'tool', callId }`。`SessionHeader` 保留 `version: 0`、`id: import-<源sessionId>`、源 `createdAt` 与 `cwd`。

**导入标记（`session/imported`）：** 每个导入会话的事件日志都以 `seq: 0` 的标记事件开头（在首个 `turn/start` 之前）。它带 `ignorable: true`，读侧全链路放行（`KNOWN_SESSION_EVENT_TYPES || ignorable`），不会被当作未知事件。`data` 记录来源信息——`{ tool, sourceId, sourcePath, importedAt }`：`tool` 是源标识（`claude-code` / `codex` / `chatgpt` / `cursor` / `gemini` / `reasonix` / `opencode` / `zcode` / `grokbuild` / `openclaw` / `hermes`），`sourceId` 是源会话 id，`sourcePath` 是导入所依据的 transcript / 数据库绝对路径（即 imports registry 的幂等键），`importedAt` 是导入时刻。仅当 transcript 产出至少一轮对话时才写标记——无可导入内容不落空会话、也不加标记。

**call/result 配对不变量：** 每个 `tool/call` 必有对应 `tool/result`（`sourceEventSeqs` 指回其 call），且每个结果挂在**声明该调用所在的 step**——保证投影出的消息顺序合法（每条 `role: 'tool'` 消息紧跟在它应答的 `tool_calls` assistant 消息之后，中间绝不插入另一条 assistant）。当 transcript 对某个调用从未记录结果（会话中断、Cursor transcript 本身无结果）时，导入器在**该调用自己的 step** 补发一个空 `tool/result`（`content: []`），保证会话仍可续聊——模型 API 会拒绝「assistant 带 `tool_calls` 但缺对应 tool 消息」的历史。空内容不是虚构文本；wire 适配器会把空内容归一为 `"(no output)"`。

**会话标题（REQ-27）：** 标题按优先级解析——`custom-title` > `ai-title`（Claude；其他源用其源记录标题，如 ChatGPT 会话标题、opencode / ZCode 的 `session.title`、Reasonix 的 meta 摘要）> **首问兜底**（首个 user 提问）。显式标题钉 `session/title` 事件；首问兜底只回填会话的 `title` 字段、不写事件——DSH 对无标题事件会话自动回退首条 user 文本，可见结果一致。标题统一归一（去首尾空白、折叠内部空白）并在 80 字符截断（超长加省略号 `…`）；空白标题绝不写 `session/title` 事件。

**上下文预算保护（REQ-37）：** turns 交合成前，导入器先估算 seed token（`estimateTokens`：CJK 1 token/字、ASCII 1 token/4 字符，约为字节估算的 2.0 倍），再按解析出的预算施加三层保护：
  1. **单条内容上限** — 任何单条 text / reasoning 块超过 16K 字符、任何工具结果超过 40K 字符都会被裁剪（保留头 75% + 尾 25%，中间以裁剪标记衔接）。该上限对**每次导入**都生效，是第一道防线。
  2. **消息级预算截断** — 整个会话仍超预算时，只保留最早 3 条 user 文本（开头锚点）、一条压缩摘要（前置到首个保留尾部轮 assistant 步骤的 `reasoning` 块，opencode compaction 同款模式）以及剩余预算能容纳的尽量多尾部轮；中间轮次丢弃。
  3. **单条兜底** — 裁剪后仍超预算一半的单条消息直接丢弃（丢弃工具结果时调用保留，由空结果兜底补发 `"(no output)"`）；首条 user 文本永不丢弃，保证至少一轮可续聊。
落盘会话的 seed 估算绝不超预算。预算解析优先级：`budget` 参数 > 环境变量 `DSH_IMPORT_CONTEXT_BUDGET` > 动态模型窗口（`agentDefaultModel.currentSelection()` + `llm.resolveModelInfo()` → `contextWindow − defaultMaxTokens − max(25% 窗口, 40k)`；服务不可用静默回退）> 静态默认 550k，并落进 imports registry。保护实际生效时返回值带 `trimmed`（见使用章节；`source` 为 `param` | `env` | `dynamic` | `default`），重导时预算变化上报 `budgetChanged`。

### Claude Code — JSONL 转录

主 transcript 在 `~/.claude/projects/<slug>/<sessionId>.jsonl`；`<sessionId>/subagents/**` 下的辅助 subagent / workflow 片段复用父 `sessionId`，会被跳过（绝不会顶替或并入主会话）。Claude 源格式先输出连续 assistant 记录、后置 `tool_result` 记录——结果按 `tool_use_id` 挂到**声明该调用所在的 step**，保证投影消息顺序合法；同一步内多个结果按该 step 的工具调用顺序对齐。`tool_use` 的结果未返回（会话中断）时，在**其所属 step** 补发空 `tool/result`。没有对应 `tool_use` 的孤儿 `tool_result` 会被丢弃并计数（`droppedToolResults`），绝不发出模型 API 会拒绝的孤儿 tool 消息。

| Claude Code JSONL | DSH SessionEvent |
| --- | --- |
| `{ type: "user", message.content: string }`（直连提问） | `turn/start` + `step/start` + `user/message` |
| `{ type: "assistant", content: [{ type: "text", text }] }` | `assistant/message` |
| `{ type: "assistant", content: [{ type: "thinking", … }] }` | `reasoning` content block |
| `{ type: "assistant", content: [{ type: "tool_use", … }] }` | `tool/call` + `tool-call` content block |
| `{ type: "user", content: [{ type: "tool_result", … }] }` | 挂到声明该调用所在 step 的 `tool/result`（`sourceEventSeqs` 关联 `tool/call`） |
| 轮次结束 | `step/end` + `turn/end` |

### Codex / ChatGPT CLI — rollout JSONL

行 envelope：`{ timestamp, type, payload }`。`event_msg` 的 user/agent 消息是 `response_item` 的重复、被忽略；以 `<` 开头的用户消息块（`<environment_context>`、`<user_instructions>` 等）是 harness 注入，不进入 prompt。Codex `reasoning` 内容加密，跳过。`function_call` / `custom_tool_call` 无对应 `*_output` 记录（会话中断）时补发空 `tool/result`。`custom_tool_call` 的 input 若是 JS 调用形态（如 `tools.exec_command({cmd: "...", workdir: "..."})`、直接对象字面量或括号/箭头包裹的调用）会自动转成标准 JSON 作为 `tool/call` 参数，避免模型学到 JS/XML 混合的调用格式；无法转换的（如 `apply_patch` 自由文本）原样保留并计数（`droppedMalformedArgs`）。

| Codex rollout | DSH SessionEvent |
| --- | --- |
| `session_meta` / `turn_context` | `SessionHeader`（id / cwd / createdAt / model） |
| `response_item message role=user`（`input_text`） | `turn/start` + `step/start` + `user/message` |
| `response_item message role=assistant`（`output_text`） | `assistant/message` |
| `response_item function_call` / `custom_tool_call` | `tool/call` + 最近 assistant 步骤的 `tool-call` content block |
| `response_item function_call_output` / `custom_tool_call_output` | `tool/result`（按 `call_id` 配对，`sourceEventSeqs` 关联） |
| `response_item reasoning` | 跳过（加密不可读） |
| 轮次结束 | `step/end` + `turn/end` |

### ChatGPT — 网页导出（conversations.json）

顶层是 JSON 数组（一个文件、全部会话），每个会话含 `mapping` DAG。沿 active branch（最后一个 `children` 项）重建主线程；`message: null` 的占位节点与 `author.role === 'system'` 跳过；时间戳是 Unix 秒（×1000 转 ms）。导出无 `cwd`，会话不归组。

| conversations.json | DSH SessionEvent |
| --- | --- |
| 会话对象（`id` / `title` / `create_time`） | `SessionHeader` + `session/title` |
| `mapping` 中 `author.role: "user"` 节点 | `turn/start` + `step/start` + `user/message` |
| `author.role: "assistant"` 节点 | `assistant/message` |
| `author.role: "tool"` 节点 | 降级为最近一步 assistant 消息的文本块（导出无结构化 tool call） |
| `author.role: "system"` / `message: null` | 跳过 |
| 轮次结束 | `step/end` + `turn/end` |

### Cursor — agent transcript

行结构：`{ role: "user" | "assistant", message: { content: [...] } }`。用户首条消息包在 `<user_query>` 里（剥离）；`[REDACTED]` 哨兵被过滤。transcript **不含 `tool_result`**（工具结果只在 UI 的 bubble store）、无时间戳 / model——会话 id 取文件名，无 `cwd`。因无任何结果，每个工具调用都会补发空 `tool/result`，保证导入的会话仍可续聊。

| Cursor transcript | DSH SessionEvent |
| --- | --- |
| `role: "user"`（`<user_query>` 包裹的 text） | `turn/start` + `step/start` + `user/message` |
| `role: "assistant"` 的 text 块 | `assistant/message` |
| `role: "assistant"` 的 `tool_use` 块 | `tool/call` + 合成空 `tool/result`（transcript 无结果） |
| `[REDACTED]` 哨兵 | 过滤 |
| 轮次结束 | `step/end` + `turn/end` |

### Gemini CLI — 会话 JSON

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

### Reasonix — 会话 JSONL

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

### opencode — 会话数据库（SQLite）

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

### ZCode — 会话数据库（SQLite）

读取 `~/.zcode/cli/db/db.sqlite` 的 `session` / `message` / `part` 三表——z.ai 官方 CLI 的 SQLite 权威索引。`message` / `part` 行**无 `sequence` 列**，消息流按 `ORDER BY time_created, id` 重建；只导入主会话（`parent_id IS NULL` 或 `''`）。工具结果**内联**在 tool part 的 `state` 里，因此一个 part 同时产出 `tool/call` + `tool/result`；没有 output 的 tool part 也发空结果，保证 call/result 配对。**compaction** part（`type: "compaction"`）把其压缩上下文摘要（`data.summary.body`）还原为首个 assistant 步骤的前置 `reasoning` 块——模型能看到被压掉的历史概要，但前段全量历史不再灌入上下文；压缩正文本身绝不进入对话。含 `<system-reminder>` 的 user 消息整条过滤（系统注入不进 prompt）。db 不可用时回退旧版 `transcript.jsonl`（取最后一条 `model_request` 的消息，工具结果回填到对应 tool part 的 `state.output`）。一个库包含全部会话，因此恒返回批量形态；`zcode://<id>` 走默认库只导该会话。

| ZCode DB | DSH SessionEvent |
| --- | --- |
| `session` 行（`id` / `title` / `directory` / `time_updated`） | `SessionHeader` + `session/title` |
| `message` 为 `role: "user"`（text part，不含 `<system-reminder>`） | `turn/start` + `step/start` + `user/message` |
| `message` 为 `role: "assistant"` | `assistant/message` |
| part `type: "text"` | `text` content block |
| part `type: "reasoning"` | `reasoning` content block |
| part `type: "tool"`（`state.input` / `state.output`） | `tool/call` + `tool/result`（`state.status === "failed"` / `"error"` → `isError`） |
| part `type: "file"` | `text` 块 `[image: <name>]` |
| part `type: "compaction"` | 摘要还原为前置 reasoning 块（压缩正文跳过） |
| part `type: "step-start"` / `"step-finish"` / `"timeline"` | 跳过（结构性块） |
| 含 `<system-reminder>` 的 user 消息 | 过滤（注入） |
| 轮次结束 | `step/end` + `turn/end` |

### Grok Build — 会话目录

每个会话在 `~/.grok/sessions/<project>/<session_id>/`（归档会话在 `~/.grok/archived_sessions/`）下各占一个目录，内含 `summary.json`（元数据）+ `chat_history.jsonl`（对话）。记录形如 `{ type, content, timestamp }`，`type` ∈ `user` / `assistant` / `tool` / `system` / `reasoning`：`reasoning`（加密内部状态）与 `system`（harness 注入）记录过滤并计数（`filtered`）。`content` 为字符串或 Claude 风格 block 数组（`text` / `input_text` / `output_text` / `thinking` / `tool_use` / `tool_result`）；`input_text` / `output_text` 归一为文本块。

| Grok Build 存储 | DSH SessionEvent |
| --- | --- |
| `summary.json` 的 `info.id` / `info.cwd` / `created_at`→`updated_at`→`last_active_at` | `SessionHeader`（id / cwd / createdAt） |
| `generated_title` > `session_summary` | `session/title`（钉事件；空白标题回退首问只填 `title` 字段） |
| `chat_history.jsonl` 的 `type: "user"`（文本 content） | `turn/start` + `step/start` + `user/message` |
| `type: "assistant"` 的 text / `thinking` 块 | `assistant/message` / `reasoning` content block |
| `type: "assistant"` 的 `tool_use` 块 | `tool/call` + `tool-call` content block |
| `type: "tool"` 记录 / `tool_result` 块（`tool_use_id`，或唯一未覆盖调用） | 挂到声明该调用所在 step 的 `tool/result`（`sourceEventSeqs` 关联） |
| 孤儿工具结果 | 丢弃并计数（`droppedToolResults`） |
| `type: "reasoning"` / `type: "system"` | 过滤并计数（`filtered`） |
| 轮次结束 | `step/end` + `turn/end` |

### OpenClaw — 会话 JSONL

`~/.openclaw/agents/<agent>/sessions/*.jsonl`，每文件一个会话；同目录 `sessions.json` 索引提供 displayName 作钉住的标题。行是事件流：`{ type: "session", id, cwd, timestamp }` 元数据行 + `{ type: "message", message: { role, content }, timestamp }` 消息行，`role` ∈ `user` / `assistant` / `toolResult`（→ 工具结果）。`content` 为字符串或 Claude 风格 block 数组；OpenClaw gateway 追加的 `[message_id: …]` 元数据尾缀被剥离。标题优先级：`sessions.json` 的 `displayName` > 首条 user 文本 > `cwd` basename（后两者只回填 `title` 字段）。

| OpenClaw JSONL | DSH SessionEvent |
| --- | --- |
| `{ type: "session" }`（`id` / `cwd` / `timestamp`） | `SessionHeader`（id / cwd / createdAt） |
| `sessions.json` 的 `displayName`（按 `sessionId`） | `session/title`（钉事件；首问 / cwd basename 只回填 `title` 字段） |
| `{ type: "message", role: "user" }` | `turn/start` + `step/start` + `user/message` |
| `role: "assistant"` 的 text / `thinking` 块 | `assistant/message` / `reasoning` content block |
| `role: "assistant"` 的 `tool_use` 块 | `tool/call` + `tool-call` content block |
| `role: "toolResult"`（`tool_use_id`，纯文本结果回填最近未配对调用） | 挂到声明该调用所在 step 的 `tool/result`（`sourceEventSeqs` 关联） |
| 孤儿 / 重复工具结果 | 丢弃并计数（`droppedToolResults`） |
| 轮次结束 | `step/end` + `turn/end` |

### Hermes — SQLite + JSONL 存储

Hermes 历史存于 `~/.hermes/`（Windows `%LOCALAPPDATA%\hermes`）。`state.db`（SQLite `sessions` + `messages` 两表）是权威索引、优先读取——兼容列名变体（`cwd`/`directory`、`started_at`/`created_at`、`ended_at`/`updated_at`），messages 按时间升序；db 不可用时回退 `sessions/*.jsonl`（flat `{ role, content, ts }` 或 nested `{ type: "session" | "message", message, timestamp }`）。`content` 为字符串或 Claude 风格 block 数组；`session` / `init` 行提供 `id` / `title` / `cwd` / `model` 元数据。

| Hermes 存储 | DSH SessionEvent |
| --- | --- |
| `sessions` 行 / `session` 行（`id` / `title` / `cwd` / `started_at`） | `SessionHeader` + `session/title` |
| `messages` 行 / JSONL 的 `role: "user"`（文本 content） | `turn/start` + `step/start` + `user/message` |
| `role: "assistant"` 的 text / `thinking` 块 | `assistant/message` / `reasoning` content block |
| `role: "assistant"` 的 `tool_use` 块 | `tool/call` + `tool-call` content block |
| user 的 `tool_result` 块（`tool_use_id`） | 挂到声明该调用所在 step 的 `tool/result`（`sourceEventSeqs` 关联） |
| 孤儿工具结果 | 丢弃并计数（`droppedToolResults`） |
| 轮次结束 | `step/end` + `turn/end` |

## ⚙️ 兼容性

- 只消费 host 公开插件 API（`sessionPersistence` / `fs` / `tools` / `workspaceRegistry`，另有可选 `agentDefaultModel` / `llm` 用于动态上下文预算解析——服务缺失或抛错静默回退静态默认）与 `@deepseek-ai/dsh-tools`（声明为 `peerDependencies` 范围 `^0.1.0-rc.6`，当前解析到 `0.1.0-rc.6`，即插件实测版本）。
- 需要 **Node.js >= 22.13**——`node:sqlite`（`DatabaseSync`，`import_opencode`、`import_zcode` 与 `import_hermes` 使用）免 `--experimental-sqlite` flag 的首个版本（见 `package.json` 的 `engines`）。

| 源格式 | 导入工具 | 实测 |
| --- | --- | --- |
| Claude Code | `import_claude` | ✅ 44 tool/call + 44 tool/result 落盘、`load OK` |
| Codex / ChatGPT CLI | `import_codex` | ✅ 单测 + mock 集成（`npm test`） |
| ChatGPT 网页导出 | `import_chatgpt` | ✅ 单测 + mock 集成（`npm test`） |
| Cursor | `import_cursor` | ✅ 单测 + mock 集成（`npm test`） |
| Gemini CLI | `import_gemini` | ✅ 单测 + mock 集成（`npm test`） |
| Reasonix | `import_reasonix` | ✅ 单测 + mock 集成（`npm test`）；55 个真实会话 dry-run |
| opencode | `import_opencode` | ✅ 单测 + mock 集成（`npm test`） |
| ZCode（z.ai CLI） | `import_zcode` | ✅ 单测 + mock 集成（`npm test`） |
| Grok Build | `import_grokbuild` | ✅ 单测 + mock 集成（`npm test`） |
| OpenClaw | `import_openclaw` | ✅ 单测 + mock 集成（`npm test`） |
| Hermes | `import_hermes` | ✅ 单测 + mock 集成（`npm test`） |
| DSH → Claude Code | `export_claude` | ✅ 单测 + mock 集成（`npm test`） |
| DSH → Claude Code（增量） | `sync_to_claude` | ✅ 单测 + mock 集成（`npm test`） |

- **实测（Tested）**：`dsh 0.1.0-rc.6` + `dsh-tools 0.1.0-rc.6`——2026-08 于 web profile 验证「导入 → resume → 工作区归组」全链路；`npm test`（269 个用例）覆盖十一种源格式的转换纯函数（含 REQ-37 的 `estimateTokens` / `cropContentBlocks` / `trimTurns` 纯函数）、`export.mjs` 序列化纯函数（全量 + 增量尾部 + 格式预检）与 mock 集成路径（含 `export_claude`、`sync_to_claude` 与预算自适应导入——参数 / 环境变量 / 动态 / 默认解析、`trimmed` 上报、`budgetChanged`）。
- **预期兼容（Expected）**：`dsh-tools ^0.1.0-rc.6`——`dsh 0.1.x` 线，与宿主安装使用同一区间。
- **区间外（Out of band）**：`<0.1.0-rc.6` 与 `>=0.2.0` 未测试——`dsh` 主版本升级后先跑 headless 冒烟，再更新本矩阵。
- **导出 / 写回门槛（Export / sync gate）**：`export_claude` / `sync_to_claude` 输出由单测 + mock 集成覆盖；用真实 Claude Code `--resume` 加载导出或写回文件是反向方向的发布门槛（写出的格式可能被 Claude Code 校验拒绝——依赖前务必实测）。

## 🔒 安全与边界

- 导入绝不改写源 transcript（只读）；DSH 历史事件 append-only（deep-frozen）——只新增、绝不修改既有事件。`export_claude` 只读会话日志、绝不修改；`sync_to_claude` 只通过守卫 CAS 写入把完整轮追加到目标文件（缩小 / 外部修改 / 尾链失配 / 并发写者一律上报、绝不覆盖；格式预检失败自动回滚）。
- 插件不修改 DSH 引擎、apiproxy 或官方 UI 包；不发布任何服务，无需 isolate realm。
- 读取工作区之外的 transcript 需要会话沙箱允许访问该路径；导出写入 `<outputDir>/<slug>/<uuid>.jsonl`，目标在工作区之外同样需要会话沙箱放行。

**各来源已知边界：**

- **通用** — 不导入 `permission` / `summary` 等辅助记录；`is_error` 的 `tool_result` 保留错误标记但丢弃 `message.content` 之外的附加字段。
- **Claude Code** — subagent / workflow 片段 transcript 跳过（只有主 `<sessionId>.jsonl` 成为会话）；无对应 `tool_use` 的孤儿 `tool_result` 丢弃并计数（`droppedToolResults`）。
- **Codex / ChatGPT CLI** — `reasoning` 加密跳过；`custom_tool_call` 的 JS 形态参数自动转标准 JSON——无法转换的原样保留并计数（`droppedMalformedArgs`）。
- **ChatGPT 网页导出** — 只重建主线程（分支取最后 child）；工具消息降级为最近一步的文本块（导出无结构化 tool call，不再产生孤儿 `tool/result`）。
- **Cursor** — transcript 无 `tool_result`（每个调用补发合成空 `tool/result`）；`[REDACTED]` 文本被过滤。
- **Gemini CLI** — 按 2026-04 观测格式导入（官方无稳定 schema）。
- **Reasonix** — 读取 JSONL checkpoint（V2 WAL 排除）。
- **opencode** — `patch` part 无 diff（只发 `[patch: <N> files]` 占位）；工具输出可能原样保留 ANSI 转义。
- **ZCode** — 导入 z.ai CLI 的 SQLite 索引（无 `sequence` 列——消息流按 `time_created, id` 重建）；compaction part 以前置 reasoning 摘要导入（压缩正文本身绝不进入对话）；db 不可用时回退旧版 `transcript.jsonl`。
- **Grok Build** — 过滤 `reasoning`（加密内部状态）与 `system`（harness 注入）记录；会话目录以 `summary.json` 识别。
- **OpenClaw** — 剥离 `[message_id: …]` gateway 尾缀；钉住标题来自同目录 `sessions.json` 索引。
- **Hermes** — 读取 SQLite `state.db` 权威索引（兼容列名变体），`sessions/*.jsonl` 作回退。

- **上下文预算保护：** 数据模型所述三层——单条内容上限（16K / 40K 字符，每次导入生效）、消息级预算截断（锚点 3 条 user 文本 + 摘要 + 尾部）、超预算一半的单条消息丢弃——全部在 `convert.mjs` 合成前纯函数执行并上报 `trimmed`。丢弃轮次计数（`droppedTurns` / `droppedMessages` / `droppedToolCalls` / `droppedToolResults` / `droppedOversized`）并插入压缩摘要（`reasoning`）保证会话仍连贯；源文件在磁盘上一字不动。
- **重导与不可变日志：** 已导入的会话是不可变日志——插件绝不改写既有历史。增长按增量续写 append；旧版本导入、缺少 call/result 配对的会话无法就地修复（删除旧会话后重新导入即可获得配对不变量）。源文件截断（`sourceShrunk`）或在已导入轮次内变化（`changedInPlace`）时跳过并报告——`force: true` 可另存完整副本。上下文预算变化重导时上报 `budgetChanged` 并跳过（同 `argsChanged`）：已存会话是按旧预算裁剪的，切换预算需要 `force: true`（或换 `sessionId`）重建。
- **导出边界：** 导出的 `thinking` 块带空 `signature`（Claude Code 在 resume 时丢弃这类思考块——文档化的降级）；非人类直连的注入与非 text 内容块（如图片）跳过并计数（`skippedInjections` / `skippedBlocks`）；DSH 日志里没有对应 `tool/call` 的孤儿 `tool_result` 丢弃并计数（`droppedToolResults`）；中断会话末尾补发空 `tool_result`。

## 🧪 测试

```bash
npm test
```

`test/convert.test.mjs` 覆盖十一种源格式的纯转换逻辑（回合平衡、工具关联、标题、畸形行、注入过滤、去重、mapping 分支、REDACTED 过滤、内联工具结果、v1/v2 工具调用形状、opencode part 映射与模型回退、zcode db 重建与 compaction 还原、grokbuild summary/chat-history 配对与 reasoning/system 过滤、openclaw displayName 标题与 toolResult 配对、hermes db 中间 JSON 与 flat/nested JSONL 形态）以及 REQ-37 预算保护纯函数（`estimateTokens` / `cropContentBlocks` / `trimTurns` 与各源在预算下的裁剪集成）；`test/export.test.mjs` 覆盖 `export.mjs` 序列化纯函数（记录映射、工具配对、并行扇出、跨 step 结果、末尾补发空结果、孤儿丢弃、注入跳过、slugify、确定性 uuid、时间戳）与 REQ-36 增量尾部（`tailClaudeEvents`、`serializeClaudeJsonlTail`、`verifyClaudeJsonl`）；`test/index.test.mjs` 用 mock 的 `fs` / `sessionPersistence` / `tools` / `workspaceRegistry`（`import_opencode`、`import_zcode` 与 `import_hermes` 另用真实 SQLite 临时库）走完整 `apply → execute` 路径，校验返回值符合输出 schema，并覆盖 `sync_to_claude` 的写回守卫、CAS 竞态、回滚与重导幂等路径，以及 REQ-37 预算解析（参数 / 环境变量 / 动态模型窗口 / 默认 550k）、`trimmed` 上报与 `budgetChanged` 跳过。各源单测另见 `test/grokbuild.test.mjs`、`test/openclaw.test.mjs` 与 `test/hermes.test.mjs`。

## 📦 安装与卸载

```bash
dsh plugin --profile web add dsh-chat-import        # npm 包
dsh plugin --profile web add -w link:/path/to/dsh-chat-import   # 本地源码（符号链接，开发推荐）
```

`dsh plugin` 是 pnpm 转发器：`add` 后识别 `dsh.bundle` 声明，把 `cordis.patch.yml` 的 `insert` 行收编进 profile 的 bundles，重启 dsh 即生效。

卸载：从 profile 的 bundles 移除 `import-claude` insert 行并重启 dsh。已导入的会话保留在 DSH 数据目录，不受影响。

## 📄 许可证

MIT — 见 [LICENSE](LICENSE)。
