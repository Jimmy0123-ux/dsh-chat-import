<p align="center">
  <a href="README.md">English</a> | <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <img src="assets/import.svg" width="120" alt="dsh-chat-import">
</p>

# DSH Chat Import

> Bring your Claude Code, Codex, ChatGPT, Cursor, Gemini, Reasonix and opencode conversations into DeepSeek Harness — and keep talking exactly where you left off.

[![npm version](https://img.shields.io/npm/v/dsh-chat-import)](https://www.npmjs.com/package/dsh-chat-import)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/Nwflower/dsh-chat-import)](https://github.com/Nwflower/dsh-chat-import)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)
**Listed in:** [Awesome DeepSeek Harness](https://github.com/0xsline/awesome-deepseek-harness) · [Awesome DSH Plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) · [Awesome DSH Plugins](https://github.com/Dominic789654/awesome-deepseek-harness) · [npm](https://www.npmjs.com/package/dsh-chat-import)
**Changelog:** [CHANGELOG.md](CHANGELOG.md)

`dsh-chat-import` turns your external agent chat history into **full-fidelity, resumable DeepSeek Harness sessions** — tool calls, reasoning and all. During import it reads transcripts **read-only** (your source files are never rewritten), never touches the DSH engine, and appends every import as a fresh, event-balanced session log through the public `sessionPersistence` service, grouped into the workspace of its `cwd`. It also works in reverse: `export_claude` serializes a DSH session back into a Claude Code JSONL transcript (read-only — your DSH log is never modified) that Claude Code can load with `--resume`, and `sync_to_claude` incrementally appends a session's new turns back to a Claude Code file — guarded, never silently overwriting.

`7 sources` · `Import + export` · `Seamlessly resumable` · `Auto workspace grouping`

## ✨ Features

- **📥 Import from 7 sources** — Claude Code JSONL, Codex / ChatGPT CLI rollouts, ChatGPT web exports, Cursor agent transcripts, Gemini CLI sessions, Reasonix sessions, and opencode SQLite history. One plugin, one call per source.
- **🔍 Full fidelity** — tool history becomes real `tool/call` + `tool/result` pairs (error flags and `sourceEventSeqs` linkage included), thinking blocks become `reasoning`, multi-step assistant messages are preserved.
- **▶️ Seamlessly resumable** — every import synthesizes a balanced, loadable session (`turn/start` → `step/start` → `user/message` → `assistant/message` → `tool/call`/`tool/result` → `step/end` → `turn/end`): open it and keep chatting.
- **🗂 Auto workspace grouping** — sessions land in the workspace of their source `cwd` (no more "ungrouped"); session id, title, model and creation time are preserved where the source records them.
- **🔁 Idempotent + incremental** — re-importing an unchanged source skips it without re-reading the file; a grown source appends only its **new turns** to the same DSH session (`seq` continues, nothing already imported is rewritten); a truncated source is detected (`sourceShrunk`) and reported without touching the imported session; malformed lines are counted and reported, never aborting the import.
- **📤 Export back to Claude Code** — `export_claude` serializes any DSH session (imported or native) into Claude Code JSONL at `<outputDir>/<slug>/<uuid>.jsonl`, ready for `--resume`: user / assistant / tool calls & results, thinking blocks and the session title are rebuilt in the Claude record layout.
- **🔄 Sync back to Claude Code** — `sync_to_claude` incrementally appends a DSH session's **new complete turns** back to the import source (or the `export_claude` copy), chaining to the file's last record; guards report shrink / external edits / tail mismatches / concurrent writers instead of overwriting, and a format pre-check rolls bad writes back.
- **📦 Batch import** — point at a directory (or the whole opencode DB) and every file / conversation becomes its own session, with a per-file summary.
- **🧮 Context budget protection** — imported sessions have no provider configuration, so dsh never auto-compacts them and an all-in history fails with 400 on resume. Oversize sessions are trimmed to fit a context budget (resolved as the `budget` parameter > `DSH_IMPORT_CONTEXT_BUDGET` env > the dynamic model window via `agentDefaultModel` + `llm` > a 550k static default): per-message caps (text ≤16K chars, tool results ≤40K chars, head 75% + tail kept), a message-level truncation (earliest 3 user texts + a compressed summary + the tail), and a last-resort drop of any single message still exceeding half the budget. The trimming is reported back (`trimmed` with budget, token estimates and drop counts).

## 🚀 Quick start

```bash
# 1. Install (npm package)
dsh plugin --profile web add dsh-chat-import

# or from a local checkout
dsh plugin --profile web add -w link:/path/to/dsh-chat-import
```

2. In any DSH session, import a single file or a whole directory:

```
import_claude({ path: "~/.claude/projects" })
```

3. Refresh the session list once, open the imported session, and continue chatting — it resumes exactly where the source left off.

## 🗂 What can I import / export?

| Source | Storage location | Import tool |
| --- | --- | --- |
| Claude Code | `~/.claude/projects/<slug>/<sessionId>.jsonl` | `import_claude` |
| Codex / ChatGPT CLI | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | `import_codex` |
| ChatGPT (web export) | exported ZIP → `conversations.json` | `import_chatgpt` |
| Cursor | `~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl` | `import_cursor` |
| Gemini CLI | `~/.gemini/history/<slot>/chats/session-*.json` | `import_gemini` |
| Reasonix | `~/.reasonix/sessions/desktop-*.jsonl` | `import_reasonix` |
| opencode | `~/.local/share/opencode/opencode.db` (SQLite) | `import_opencode` |

Each import preserves what the source actually records — session id, `cwd`, title, model, creation time, tool calls & results, reasoning — and formats with less data (Cursor transcripts, ChatGPT exports) import what exists and clearly report what they don’t.

## 🛠 Usage

> **Note:** imports persist to disk immediately, but the DSH session list does not auto-refresh — refresh the page (or the session list) after importing to see the new sessions.

```
import_claude({ path: "C:\Users\<you>\.claude\projects\<slug>\<sessionId>.jsonl" })
import_codex({ path: "C:\Users\<you>\.codex\sessions\2026\05\18\rollout-2026-05-18T21-14-16-xxxx.jsonl" })
import_chatgpt({ path: "C:\Users\<you>\Downloads\chatgpt-export\conversations.json" })
import_cursor({ path: "C:\Users\<you>\.cursor\projects\<slug>\agent-transcripts\<composer-id>\<composer-id>.jsonl" })
import_gemini({ path: "C:\Users\<you>\.gemini\history\<slot>\chats\session-2026-04-17T18-09-b26d7f99.json" })
import_reasonix({ path: "C:\Users\<you>\.reasonix\sessions\desktop-202606020721-1.jsonl" })
import_opencode({ path: "C:\Users\<you>\.local\share\opencode\opencode.db" })
```

`import_claude` / `import_codex` / `import_cursor` / `import_gemini` / `import_reasonix` behave alike:

- `path` can be a **single file or a directory** (directories are scanned recursively; each file becomes its own session).
- Optional `sessionId` overrides the target DSH session id (default `import-<source sessionId>`; Cursor uses the file-name composer id, Reasonix the file-name stem). Changing it on a re-import creates a new full copy under the new id (the old session stays untouched).
- Optional `force: true` creates a **fresh full copy** under a new id (`import-<sessionId>-<n>`, `n` = next free suffix) even when the source was already imported — the old session is never modified or archived.
- Returns `{ mode: 'single', sessionId, turns, messages, toolCalls, skipped, alreadyImported, status }` where `status` is `imported` | `already-imported` | `appended` | `skipped`, plus optional `appendedTurns` / `appendedEvents` (grew), `sourceShrunk` (truncated), `changedInPlace` (grew inside existing turns — append-only cannot rewrite them), `argsChanged` (import parameters changed), `budgetChanged` (context budget changed), `backfilled` (registry record restored for a legacy import), `forceImported: { previous, current }` (force / sessionId-change copy) and `droppedBoundaryResults`.
- Optional `budget` (integer tokens) sets the context budget for this import (resolution order: this parameter > `DSH_IMPORT_CONTEXT_BUDGET` env > dynamic model window > 550k static default). When the three-layer protection actually engages, the result carries `trimmed: { budget, source, originalTokens, estimatedTokens, croppedBlocks, droppedTurns, droppedMessages, droppedToolCalls, droppedToolResults, droppedOversized, summaryInserted }` — see "Context budget protection" under Data model.

`import_chatgpt` differs: one `conversations.json` holds **all** conversations, so even a single file returns the batch shape `{ mode: 'batch', total, imported, alreadyImported, appended, skipped, failed, results: [...] }` (each `results` entry is one conversation, status `imported` | `already-imported` | `appended` | `skipped` | `failed`). Incremental logic applies per conversation: grown conversations are appended, conversations removed from the export are reported in `missingFromSource` (their sessions stay untouched), and `force: true` copies every conversation. ChatGPT exports carry no `cwd`, so imported sessions are not grouped into workspaces.

`import_opencode` also always returns the batch shape — one `opencode.db` holds **all** sessions. `path` may be the `.db` file or its data directory; optional `sessionIds` restricts the import to the listed sessions; optional `fullHistory: true` imports the full message history instead of respecting opencode’s conversation compaction (default `false` — compacted sessions import as their last summary plus the retained tail). `fullHistory` is part of the import-args fingerprint: re-importing with a different value reports `argsChanged` (use `force: true` to switch). The database is fingerprinted at the DB level (version + size): an unchanged DB is skipped without re-reading SQLite; per-session growth appends, compaction that removes turns reports `sourceShrunk`. Imported sessions keep their `directory` as `cwd` and are grouped into workspaces.

## 🔁 Incremental re-import

Re-importing the **same source path** never rewrites imported history — it follows an idempotency registry stored at `$DSH_HOME/dsh-chat-import/imports.json` (`$DSH_HOME` defaults to `~/.dsh`), keyed by the source file’s absolute path (not the source session id, because different files may share one session id and must not overwrite each other):

| Source state on re-import | Behaviour |
| --- | --- |
| unchanged (same content fingerprint + size) | skipped (`already-imported`), without re-reading the file |
| grew by whole turns | new turns appended to the **same** DSH session: `seq` continues from the stored log (authoritative, even if you chatted in DSH after the last import), `data.turn` keeps source numbering, no duplicate `session/imported` marker or title |
| grew inside existing turns (same turn count) | skipped + `changedInPlace` (append-only cannot rewrite already-imported turns) |
| truncated (fewer turns) | skipped + `sourceShrunk`; the imported session stays intact — use `force: true` for a complete fresh copy |
| `force: true` | fresh full copy under `import-<sessionId>-<n>`; the old session is never modified |
| explicit `sessionId` changed | new full copy under the new id (force-copy semantics); the old session stays |
| import args changed (e.g. opencode `fullHistory`) | skipped + `argsChanged` |
| context budget changed (parameter / env / dynamic resolution) | skipped + `budgetChanged` (same semantics as `argsChanged`; the stored record keeps the old budget until `force: true` re-imports under the new one) |

The registry record stores `{ kind, dshId, turns, events, sizeBytes, version, args, budget, importedAt }` (multi-session sources keep a per-conversation / per-session sub-table); it tolerates a missing or corrupted file (falls back to an empty registry and re-records on the next import). All registry writes are atomic (temp + fsync + rename) and serialized in-process, and use `node:fs/promises` directly — never `ctx.fs`, whose sandbox would refuse writes under `~/.dsh`.

## 📤 Export — DSH → Claude Code JSONL

The reverse direction: `export_claude` serializes an existing DSH session — imported or native — into a Claude Code JSONL transcript that Claude Code can load with `--resume`. The session log is read **read-only** via `sessionPersistence` (`list` + `readFrom`, never `load` / `prepare`, never rewritten):

```
export_claude({ sessionId: "import-019f5f27-…" })
export_claude({ sessionId: "…", cwd: "D:\work\proj", outputDir: "D:\backup\claude-projects", dryRun: true })
```

- `sessionId` (required) — the DSH session to export.
- `cwd` (optional) — overrides the session's header `cwd`; defaults to the header value, and the export fails when neither exists.
- `outputDir` (optional) — the Claude Code `projects` root; defaults to `~/.claude/projects`. The file is written to `<outputDir>/<slug>/<uuid>.jsonl` — the same `<slug>/<uuid>.jsonl` layout Claude Code uses (the file name is a fresh UUID v4, and writes use `createIfAbsent`, so an existing file is never overwritten).
- `dryRun` (optional) — serialize and return the target path and statistics without writing.

The exporter rebuilds the Claude record sequence from the DSH event log in `seq` order: a `mode` + `permission-mode` header, then `user` / `assistant` / `tool_result` records — tool results chained to the assistant that declared their `tool_use` (`parentUuid` / `sourceToolAssistantUUID`, so parallel results fan out to the same assistant), an `ai-title` record from the session title, `thinking` blocks from `reasoning` (with an empty `signature`), and `tool_use` input parsed from the call arguments. Interrupted sessions get a trailing empty `tool_result` for calls that never returned; orphan results with no matching call are dropped and counted. The return value carries a `mapping` object (source session id → new UUID, file path, record counts) reserved for the upcoming reverse-sync registry.

**Boundaries:** exported `thinking` blocks carry an empty `signature` — Claude Code drops such thinking blocks when resuming (documented degradation). User messages whose source is not a direct human prompt are skipped and counted (`skippedInjections`); non-text content blocks (e.g. images) are skipped and counted (`skippedBlocks`). Writing outside the workspace requires the session sandbox to allow the target path.

## 🔄 Sync back — incremental write-back to Claude Code

The second half of the reverse direction: `sync_to_claude` appends a DSH session's **new complete turns** back to a Claude Code JSONL file, so the file keeps being resumable with `--resume`. It never rewrites existing history — it only appends whole closed turns (`turn/start` → … → `turn/end`); a half-open turn still in progress is skipped (`incompleteFinalTurn`).

```
sync_to_claude({ sessionId: "import-019f5f27-…" })                     // write back to the import source
sync_to_claude({ sessionId: "…", target: "copy", dryRun: true })       // preview against the export_claude copy
sync_to_claude({ sessionId: "…", target: "copy", force: true })        // re-anchor past external edits
```

- `sessionId` (required) — the DSH session to write back; it must be a session imported by this plugin (its log opens with the `session/imported` marker; multi-session sources such as ChatGPT / opencode and native sessions are rejected).
- `target` (optional) — `"source"` (default) appends to the file the session was imported from; `"copy"` appends to the copy created by the last `export_claude` (which must have run first, so the registry holds the export mapping). The appended records carry the target file's `sessionId` and chain their `parentUuid` to the file's last record.
- `force` (optional) — skip the three file guards below and **re-anchor** the bridge to the file's current state (watermark = how many events the file now represents, chain tail = the file's current tail uuid), so an externally edited file is accepted instead of rejected; the overridden guard is still reported.
- `dryRun` (optional) — run the full pipeline (including the format pre-check) without writing or updating the registry.

**Guards — never silently overwrite** (violations return `status: "skipped"`):

| File / log state on sync | Behaviour |
| --- | --- |
| target file missing | `skipped` + `reason: source-missing` |
| file shrank below the watermark | `skipped` + `sourceShrunk` |
| file size or version changed externally | `skipped` + `conflictDetected: source-modified-externally` |
| file tail uuid ≠ the watermark's chain tail | `skipped` + `conflictDetected: tail-mismatch` |
| a concurrent writer won the CAS write | `skipped` + `conflictDetected: write-version-mismatch` |
| DSH log shorter than the watermark | `skipped` + `storedShrunk` |
| appended content fails the format pre-check | rolled back to the pre-write content + `precheckFailed` (watermark not advanced) |

The first sync has no watermark yet: it reads the target file's actual event count (by converting it) and chain tail as the **baseline**, registers the writeback, and only writes from there on. After a successful sync the registry record is updated — `turns` re-converted so a later re-import stays idempotent (no duplicate append), `events` set to the stored log length, size/version fingerprint refreshed, and `writeback: { sessionUuid, filePath, lastWrittenSeq, lastWrittenTurn, prevUuid, lastSize, lastVersion, writtenAt }` recorded. Tail serialization reuses the `export.mjs` core (no mode / permission-mode / ai-title header, first record chained to `prevUuid`), so a `tool/result` whose call was declared before the watermark is dropped and counted as an orphan — the write never breaks the file's layout. Real `claude --resume` verification of a synced file is the release gate for this direction.

## 🧩 Data model

The importer cuts each transcript into turns on "direct human prompts" (a `user` record with string `content`), and synthesizes one closed DSH round per turn:

```
turn/start → step/start → user/message → assistant/message → (tool/call + tool/result) → step/end → turn/end
```

Messages carry stable ids and `surfaceOp: 'append'`; `tool/result` events link back to their `tool/call` via `sourceEventSeqs`. Assistant `source` is `{ kind: 'model', provider: 'claude-code', model: <source model> }`; `tool/result` source is `{ kind: 'tool', callId }`. The `SessionHeader` keeps `version: 0`, `id: import-<source sessionId>`, source `createdAt` and `cwd`.

**Import marker (`session/imported`):** every imported session opens with a marker event at `seq: 0`, before the first `turn/start`. It carries `ignorable: true`, so the read pipeline accepts it as a known-but-ignorable event (`KNOWN_SESSION_EVENT_TYPES || ignorable`) instead of an unknown one. Its `data` records the provenance — `{ tool, sourceId, sourcePath, importedAt }`: `tool` is the source identifier (`claude-code` / `codex` / `chatgpt` / `cursor` / `gemini` / `reasonix` / `opencode`), `sourceId` the original source session id, `sourcePath` the absolute transcript / database path the session was imported from (the idempotency key for the imports registry), and `importedAt` the import timestamp. The marker is written only when the transcript yields at least one turn — empty imports are skipped without a session or marker.

**Call/result pairing invariant:** every `tool/call` is paired with a `tool/result` (`sourceEventSeqs` points back to its call), and each result is attached to the step that declared its call — so the projected message order stays wire-legal (every `role: 'tool'` message sits immediately after the assistant message whose `tool_calls` it answers, never separated by another assistant). When the transcript never recorded a result for a call (interrupted sessions, Cursor transcripts that contain no results), the importer synthesizes an empty `tool/result` (`content: []`) in the call's own step so the session still resumes — model APIs reject history in which an assistant `tool_calls` block has no matching tool message. The empty content is not fabricated text; wire adapters normalize it to `"(no output)"`.

**Context budget protection (REQ-37):** before the turns are synthesized, the importer estimates the seed tokens (`estimateTokens`: CJK 1 token per char, ASCII 1 token per 4 chars, ≈2.0× the byte estimate) and applies three layers against the resolved budget:
  1. **Per-message caps** — any single text / reasoning block over 16K chars and any tool result over 40K chars is cropped (head 75% + tail 25%, joined by a crop marker). These caps apply to every import; they are the first line of defense.
  2. **Message-level truncation** — when the whole session still exceeds the budget, only the earliest 3 user texts (the anchor), a compressed summary (a leading `reasoning` block on the first kept tail turn, opencode-compaction style) and as many tail turns as fit the remaining budget are kept; the middle turns are dropped.
  3. **Single-message fallback** — any single message that still exceeds half the budget after cropping is dropped (a dropped tool result leaves its call in place and the empty-result fill emits `"(no output)"`); the very first user text is never dropped, so at least one turn always survives.
The seed estimate of the stored session never exceeds the budget. The budget resolves as `budget` parameter > `DSH_IMPORT_CONTEXT_BUDGET` env > dynamic model window (`agentDefaultModel.currentSelection()` + `llm.resolveModelInfo()` → `contextWindow − defaultMaxTokens − max(25% window, 40k)`; unavailable services fall back silently) > 550k static default, and is recorded in the imports registry. When protection engages, the result carries `trimmed` (see Usage) — with `source` one of `param` | `env` | `dynamic` | `default` — and a budget change on re-import reports `budgetChanged`.

### Claude Code JSONL

Main transcript at `~/.claude/projects/<slug>/<sessionId>.jsonl`; auxiliary subagent / workflow fragments under `<sessionId>/subagents/**` reuse the parent `sessionId` and are skipped (they can never shadow or merge into the main conversation). Claude emits consecutive assistant records first and their `tool_result` records after — results attach to the step that declared their `tool_use` (paired by `tool_use_id`), so the projected messages stay wire-legal; results inside one step are ordered to match the step's tool calls. A `tool_use` whose result never arrived (session interrupted) gets a synthesized empty `tool/result` in its own step. A `tool_result` with no matching `tool_use` in the transcript is an orphan: it is dropped and counted (`droppedToolResults`) instead of emitting an orphan tool message the model API would reject.

| Claude Code JSONL | DSH SessionEvent |
| --- | --- |
| `{ type: "user", message.content: string }` (direct prompt) | `turn/start` + `step/start` + `user/message` |
| `{ type: "assistant", content: [{ type: "text", text }] }` | `assistant/message` |
| `{ type: "assistant", content: [{ type: "thinking", … }] }` | `reasoning` content block |
| `{ type: "assistant", content: [{ type: "tool_use", … }] }` | `tool/call` + `tool-call` content block |
| `{ type: "user", content: [{ type: "tool_result", … }] }` | `tool/result` on the step that declared the call (`sourceEventSeqs` links its `tool/call`) |
| turn ends | `step/end` + `turn/end` |

### Codex / ChatGPT CLI rollout

Line envelope: `{ timestamp, type, payload }`. `event_msg` user/agent messages duplicate `response_item` records and are ignored; user blocks starting with `<` (`<environment_context>`, `<user_instructions>`, …) are harness injections and never enter the prompt. Codex `reasoning` content is encrypted and skipped. A `function_call` / `custom_tool_call` without a matching `*_output` record (session cut off) gets a synthesized empty `tool/result`. `custom_tool_call` inputs in JS call form (e.g. `tools.exec_command({cmd: "...", workdir: "..."})`, a bare object literal, or a wrapped call) are parsed to standard JSON for the `tool/call` arguments so the model never learns a JS/XML-mixed call format; inputs that cannot be parsed (e.g. `apply_patch` free text) stay verbatim and are counted (`droppedMalformedArgs`).

| Codex rollout | DSH SessionEvent |
| --- | --- |
| `session_meta` / `turn_context` | `SessionHeader` (id / cwd / createdAt / model) |
| `response_item message role=user` (`input_text`) | `turn/start` + `step/start` + `user/message` |
| `response_item message role=assistant` (`output_text`) | `assistant/message` |
| `response_item function_call` / `custom_tool_call` | `tool/call` + `tool-call` content block on the nearest assistant step |
| `response_item function_call_output` / `custom_tool_call_output` | `tool/result` (paired by `call_id`, `sourceEventSeqs` linkage) |
| `response_item reasoning` | skipped (encrypted, unreadable) |
| turn ends | `step/end` + `turn/end` |

### ChatGPT web export (`conversations.json`)

Top level is a JSON array (one file, all conversations); each conversation has a `mapping` DAG. The active branch (last `children` entry) is rebuilt as the main thread; placeholder nodes with `message: null` and `author.role === 'system'` are skipped; timestamps are Unix seconds (×1000 → ms). No `cwd` exists, so sessions are not grouped.

| conversations.json | DSH SessionEvent |
| --- | --- |
| conversation object (`id` / `title` / `create_time`) | `SessionHeader` + `session/title` |
| `mapping` node with `author.role: "user"` | `turn/start` + `step/start` + `user/message` |
| node with `author.role: "assistant"` | `assistant/message` |
| node with `author.role: "tool"` | text block appended to the latest step's assistant message (degraded — exports carry no structured tool calls) |
| `author.role: "system"` / `message: null` | skipped |
| turn ends | `step/end` + `turn/end` |

### Cursor agent transcript

Line structure: `{ role: "user" | "assistant", message: { content: [...] } }`. First user message is wrapped in `<user_query>` (stripped); `[REDACTED]` sentinels are filtered. Transcripts contain **no `tool_result`** (results live only in the UI bubble store) and no timestamps / model — the session id comes from the file name, and there is no `cwd`. Because no results exist, every tool call is paired with a synthesized empty `tool/result` so imported sessions still resume.

| Cursor transcript | DSH SessionEvent |
| --- | --- |
| `role: "user"` (text in `<user_query>`) | `turn/start` + `step/start` + `user/message` |
| `role: "assistant"` text blocks | `assistant/message` |
| `role: "assistant"` `tool_use` blocks | `tool/call` + synthesized empty `tool/result` (transcript has no results) |
| `[REDACTED]` sentinels | filtered |
| turn ends | `step/end` + `turn/end` |

### Gemini CLI session JSON

One JSON object per file at `~/.gemini/history/<slot>/chats/session-*.json`. Message types: `user` (parts array) opens a turn; `gemini` (string content, optional `thoughts` and `toolCalls`) is one assistant step; `info` (CLI notices) is skipped. Tool results are **inline** on the same object as the call; a call without a result gets a synthesized empty `tool/result`.

| Gemini session JSON | DSH SessionEvent |
| --- | --- |
| top level (`sessionId` / `startTime` / `directories[0]`) | `SessionHeader` (id / createdAt / cwd) |
| `type: "user"` (parts array) | `turn/start` + `step/start` + `user/message` |
| `type: "gemini"` string content | `assistant/message` |
| `thoughts` entries | `reasoning` content blocks |
| `toolCalls[].args` + inline `result` | `tool/call` + `tool/result` (`status: "error"` → `isError`) |
| `type: "info"` | skipped |
| turn ends | `step/end` + `turn/end` |

### Reasonix session JSONL

OpenAI-style messages without envelope at `~/.reasonix/sessions/<stem>.jsonl`; both v1 (nested `{ id, type: "function", function: { name, arguments } }`) and v2 (flat `{ id, name, arguments }`) `tool_calls` are accepted. Tool results (`role: "tool"` with `tool_call_id`) pair by `tool_calls[].id`; a `tool_calls` block without a following `role: "tool"` message gets a synthesized empty `tool/result`. A sibling `<stem>.meta.json` provides `workspace` → `cwd` and `summary` → pinned title; when neither the transcript nor the meta carries a timestamp, the creation time falls back to the one embedded in the file name. V2 WAL sidecars (`.events.jsonl` / `.conflicts.jsonl` / `.guardian.jsonl`) are excluded from directory scans.

| Reasonix JSONL | DSH SessionEvent |
| --- | --- |
| `role: "user"` (string content) | `turn/start` + `step/start` + `user/message` |
| `role: "assistant"` string content | `assistant/message` |
| `reasoning_content` | `reasoning` content block |
| `tool_calls[].function` (v1 nested / v2 flat) | `tool/call` |
| `role: "tool"` with `tool_call_id` | `tool/result` (paired by `tool_call_id`) |
| `<stem>.meta.json` (`workspace` / `summary`) | `cwd` / `session/title` |
| turn ends | `step/end` + `turn/end` |

### opencode session database (SQLite)

Reads the `session` / `message` / `part` tables of `~/.local/share/opencode/opencode.db` (the `event` table is only a partial mirror and `session_message` / `session_input` are empty — ignored). Tool results are **inline** in the tool part’s `state`, so `tool/call` + `tool/result` are emitted together; a tool part without output still emits an empty result so calls and results stay paired. opencode **compaction** is respected by default: only the last compaction summary (a leading `reasoning` block) plus the messages from `tail_start_id` onward are imported; `fullHistory: true` imports everything.

| opencode DB | DSH SessionEvent |
| --- | --- |
| `session` row (`id` / `title` / `directory` / `time_created` / `model`) | `SessionHeader` + `session/title` |
| `message` with `role: "user"` (text parts) | `turn/start` + `step/start` + `user/message` |
| `message` with `role: "assistant"` | `assistant/message` |
| part `type: "text"` | `text` content block |
| part `type: "reasoning"` | `reasoning` content block |
| part `type: "tool"` | `tool/call` + `tool/result` (`state.status === "error"` → `isError`) |
| part `type: "file"` | `text` block `[image: <filename>]` |
| part `type: "patch"` | `text` block `[patch: <N> files]` |
| part `type: "subtask"` | `text` block `[subtask: <command> — <description>]` |
| part `type: "compaction"` (`tail_start_id`) | drop pre-`tail_start_id` history; summary becomes leading `reasoning` |
| turn ends | `step/end` + `turn/end` |

## ⚙️ Compatibility

- Consumes only public host plugin APIs (`sessionPersistence` / `fs` / `tools` / `workspaceRegistry`, plus optional `agentDefaultModel` / `llm` for the dynamic context-budget resolution — absent or failing services fall back to the static default silently) and `@deepseek-ai/dsh-tools`, declared as a `peerDependencies` range `^0.1.0-rc.6` (currently resolving to `0.1.0-rc.6`, the version the plugin is tested against).
- Requires **Node.js >= 22.13** — the first release where `node:sqlite` (`DatabaseSync`, used by `import_opencode`) is available without the `--experimental-sqlite` flag (see `engines` in `package.json`).

| Source format | Import tool | Verified |
| --- | --- | --- |
| Claude Code | `import_claude` | ✅ 44 tool/call + 44 tool/result persisted, `load OK` |
| Codex / ChatGPT CLI | `import_codex` | ✅ unit + mock integration (`npm test`) |
| ChatGPT web export | `import_chatgpt` | ✅ unit + mock integration (`npm test`) |
| Cursor | `import_cursor` | ✅ unit + mock integration (`npm test`) |
| Gemini CLI | `import_gemini` | ✅ unit + mock integration (`npm test`) |
| Reasonix | `import_reasonix` | ✅ unit + mock integration (`npm test`); dry-run on 55 real sessions |
| opencode | `import_opencode` | ✅ unit + mock integration (`npm test`) |
| DSH → Claude Code | `export_claude` | ✅ unit + mock integration (`npm test`) |
| DSH → Claude Code (incremental) | `sync_to_claude` | ✅ unit + mock integration (`npm test`) |

- **Tested**: `dsh 0.1.0-rc.6` + `dsh-tools 0.1.0-rc.6` — full "import → resume → workspace attach" run on the web profile (2026-08); `npm test` (183 cases) covers the pure conversion logic (including the REQ-37 `estimateTokens` / `cropContentBlocks` / `trimTurns` pure functions), the pure `export.mjs` serializer (full + incremental tail + format pre-check), and mock integration paths for all seven source formats plus `export_claude`, `sync_to_claude` and the budget-adaptive import (env / parameter / dynamic / default resolution, `trimmed` reporting, `budgetChanged`).
- **Expected**: `dsh-tools ^0.1.0-rc.6` — the `dsh 0.1.x` line, the same range the host install uses.
- **Out of band**: `<0.1.0-rc.6` and `>=0.2.0` are untested — after a `dsh` major upgrade, run a headless smoke test first, then update this matrix.
- **Export / sync gate**: `export_claude` / `sync_to_claude` output is covered by unit + mock integration tests; loading an exported or synced file with real Claude Code `--resume` is the release gate for the reverse direction (the written format may be rejected by Claude Code's validator — validate before relying on it).

## 🔒 Safety & boundaries

- Import never rewrites source transcripts (read-only); DSH history events are append-only (deep-frozen) — new events are added, existing ones are never modified. `export_claude` reads the session log read-only and never modifies it; `sync_to_claude` only appends complete turns to the target file through a guarded CAS write (shrink / external edits / tail mismatches / concurrent writers are reported, never overwritten; a failed format pre-check rolls the write back).
- The plugin never modifies the DSH engine, apiproxy, or official UI packages; it publishes no services, so no isolate realm is needed.
- Reading transcripts outside the workspace requires the session sandbox to allow access to that path; exporting writes `<outputDir>/<slug>/<uuid>.jsonl`, so a target outside the workspace likewise requires the session sandbox to allow it.
- Known boundaries: `permission` / `summary` auxiliary records are not imported; `tool_result` with `is_error` keeps the error flag but drops fields beyond `message.content`; Claude subagent / workflow fragment transcripts are skipped (only the main `<sessionId>.jsonl` becomes a session) and a `tool_result` with no matching `tool_use` is dropped and counted (`droppedToolResults`); Codex `reasoning` is encrypted and skipped; Codex `custom_tool_call` inputs in JS call form are converted to standard JSON arguments — unconvertible ones stay verbatim and are counted (`droppedMalformedArgs`); ChatGPT exports rebuild only the main thread (branch = last child) and tool messages degrade to text blocks on the nearest step (exports carry no structured tool calls, so no orphan `tool/result` is produced); Cursor transcripts have no `tool_result` (every call gets a synthesized empty `tool/result`) and `[REDACTED]` text is filtered; Gemini follows the format observed 2026-04 (no stable official schema); Reasonix reads the JSONL checkpoint (the V2 WAL is excluded); opencode `patch` parts carry no diff (placeholder `[patch: <N> files]` only) and tool output may keep ANSI escapes verbatim.
- **Context budget protection:** the three layers described under Data model — per-message caps (16K / 40K chars, applied to every import), message-level budget truncation (anchor 3 user texts + summary + tail), and single-message drop above half the budget — run purely in `convert.mjs` before session synthesis and are reported in `trimmed`. Dropped turns are counted (`droppedTurns` / `droppedMessages` / `droppedToolCalls` / `droppedToolResults` / `droppedOversized`) and a compressed summary (`reasoning`) is inserted so the session still reads coherently; the full source history stays untouched on disk.
- **Re-import after this fix:** already-imported sessions are immutable logs — the plugin never rewrites existing history. Growth is appended incrementally; sessions imported by an older version that lack the call/result pairing cannot be repaired in place (delete the stale session and re-import to pick up the pairing invariant). A source that shrank (`sourceShrunk`) or changed inside already-imported turns (`changedInPlace`) is skipped and reported — `force: true` gives a complete fresh copy. A context-budget change on re-import reports `budgetChanged` and skips (like `argsChanged`): the stored session was trimmed under the old budget, so switching budgets requires `force: true` (or a new `sessionId`) to rebuild it.
- **Export boundaries:** exported `thinking` blocks carry an empty `signature` (Claude Code drops such thinking on resume — documented degradation); non-human prompt injections and non-text content blocks (e.g. images) are skipped and counted (`skippedInjections` / `skippedBlocks`); orphan `tool_result` records with no matching `tool/call` in the DSH log are dropped and counted (`droppedToolResults`); interrupted sessions get a trailing empty `tool_result`.

## 🧪 Tests

```bash
npm test
```

`test/convert.test.mjs` covers the pure conversion logic for all seven source formats (turn balance, tool linkage, titles, malformed lines, injection filtering, dedup, mapping branches, REDACTED filtering, inline tool results, v1/v2 tool-call shapes, opencode part mapping and model fallback); `test/export.test.mjs` covers the pure `export.mjs` serializer (record mapping, tool pairing, parallel fan-out, cross-step results, trailing empty results, orphan dropping, injection skipping, slugify, deterministic uuids, timestamps) plus the REQ-36 incremental tail (`tailClaudeEvents`, `serializeClaudeJsonlTail`, `verifyClaudeJsonl`); `test/index.test.mjs` runs the full `apply → execute` path with mock `fs` / `sessionPersistence` / `tools` / `workspaceRegistry` (and a real SQLite temp DB for `import_opencode`), validates the return value against the output schema, and covers the `sync_to_claude` write-back guards, CAS race, rollback and idempotent re-import paths.

## 📦 Install & uninstall

```bash
dsh plugin --profile web add dsh-chat-import        # npm package
dsh plugin --profile web add -w link:/path/to/dsh-chat-import   # local checkout (symlink, recommended for development)
```

`dsh plugin` is a pnpm forwarder: after `add` it reads the `dsh.bundle` declaration, folds the `cordis.patch.yml` `insert` lines into the profile’s bundles, and the plugin is active after restarting dsh.

To uninstall, remove the `import-claude` insert line from the profile’s bundles and restart dsh. Already-imported sessions stay in the DSH data directory and are unaffected.

## 📄 License

MIT — see [LICENSE](LICENSE).
