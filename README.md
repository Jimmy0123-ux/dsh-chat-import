<p align="center">
  <a href="README.md">English</a> | <a href="README.zh-CN.md">简体中文</a>
</p>

# DSH Chat Import

> Import Claude Code / Codex / ChatGPT / Cursor / Gemini conversation histories into DeepSeek Harness as resumable sessions.

[![npm version](https://img.shields.io/npm/v/dsh-chat-import)](https://www.npmjs.com/package/dsh-chat-import)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/Nwflower/dsh-chat-import)](https://github.com/Nwflower/dsh-chat-import)

`Nwflower/dsh-chat-import` adds external chat-history import to DeepSeek Harness: it brings Claude Code JSONL transcripts, Codex / ChatGPT CLI rollout JSONL, ChatGPT web-export `conversations.json`, Cursor agent transcripts, and Gemini CLI session JSON into DSH as **full-fidelity, resumable** sessions. The plugin never rewrites source files and never touches the DSH engine; every import appends a fresh, event-balanced session log through the public `sessionPersistence` service and attaches the session to the workspace of its `cwd`.

## Features

- **Import Claude Code transcripts**: reads `~/.claude/projects/<slug>/<sessionId>.jsonl`, parses user / assistant / tool / thinking messages.
- **Import Codex / ChatGPT CLI rollouts**: reads `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (the OpenAI Codex CLI has been folded into ChatGPT; format unchanged), parses `response_item` messages / function_call / custom_tool_call / reasoning.
- **Import ChatGPT web exports**: reads `conversations.json` from an exported ZIP (one file holds all conversations), rebuilds each conversation along the main mapping thread.
- **Import Cursor agent transcripts**: reads `~/.cursor/projects/<slug>/agent-transcripts/<composer-id>/<composer-id>.jsonl`, parses text / tool_use, filters `[REDACTED]` sentinels.
- **Import Gemini CLI sessions**: reads `~/.gemini/history/<slot>/chats/session-*.json` (one JSON object per file), parses user/gemini messages, `thoughts` → `reasoning`, and inline `toolCalls` (results live on the same object); `info` system notices are skipped.
- **Full fidelity**: tool history maps to `tool/call` + `tool/result` (with error flags and `sourceEventSeqs` linkage), thinking blocks map to `reasoning`, multi-step assistant messages are preserved.
- **Resumable**: synthesizes `turn/start`, `step/start`, `user/message`, `assistant/message`, `tool/call`, `tool/result`, `step/end`, `turn/end` events into a balanced, loadable session — open it and continue chatting.
- **Session metadata preserved**: source `sessionId`, `cwd`, `ai-title` (Claude; pinned as `session/title` so auto-titles can't override), real model name (where the source records one), creation time.
- **Auto workspace attach**: resolves/creates the workspace by `cwd` and `attachSession`s, so imported sessions are grouped correctly (no more "ungrouped"); ChatGPT exports and Cursor transcripts carry no `cwd` and are left ungrouped.
- **Idempotent**: skips when the target session already exists; malformed lines are counted and reported, never aborting the import.
- **Batch import**: pass a directory to `path` to recursively scan `.jsonl` (Claude / Codex / Cursor) or `.json` (ChatGPT / Gemini) files; each file becomes its own session (likewise each conversation inside a ChatGPT file), returning per-file / per-session summaries.

## Design

### Event-sourcing mapping

The plugin cuts the Claude Code transcript into turns on "direct human prompts": a record with `type === 'user'` and string `content` opens a new turn; every following `assistant` message (including `tool_use` / `thinking` blocks) is one step, and `tool_result` records attach to the most recent step. Each turn becomes one closed DSH round:

1. `turn/start` → `step/start` → `user/message` → `assistant/message` →（`tool/call` + `tool/result`）→ `step/end` → `turn/end`.
2. Messages carry stable ids (`import:<sessionId>:u<turn>` / `:a<turn>:<step>` / `:t<turn>:<step>:<callId>`) and `surfaceOp: 'append'`.
3. Assistant `source` is `{ kind: 'model', provider: 'claude-code', model: <source model> }`; `tool/result` `source` is `{ kind: 'tool', callId }`, linked to its `tool/call` via `sourceEventSeqs`.

### Service dependencies

- The host only consumes public services: `sessionPersistence` (`create` + `append`), `fs` (reading source files), `tools` (registering tools), `workspaceRegistry` (`resolveByPath` / `create` / `attachSession` grouping).
- No services are published, so no isolate realm is needed.
- Host-only plugin: no Browser side.

## Data model

### Claude Code JSONL

| Claude Code JSONL | DSH SessionEvent |
| --- | --- |
| `{ type: "user", message.content: string }` (direct prompt) | `turn/start` + `step/start` + `user/message` |
| `{ type: "assistant", content: [{ type: "text", text }] }` | `assistant/message` |
| `{ type: "assistant", content: [{ type: "thinking", … }] }` | `reasoning` content block |
| `{ type: "assistant", content: [{ type: "tool_use", … }] }` | `tool/call` + `tool-call` content block |
| `{ type: "user", content: [{ type: "tool_result", … }] }` | `tool/result` (`sourceEventSeqs` links its `tool/call`) |
| turn ends | `step/end` + `turn/end` |

### Codex / ChatGPT CLI rollout

Line envelope: `{ timestamp, type, payload }`. The `event_msg` `user_message` / `agent_message` are duplicates of `response_item` records and are ignored to avoid double counting; user message blocks starting with `<` (`<environment_context>`, `<user_instructions>`, `<system-reminder>`, …) are harness injections and never enter the prompt.

| Codex rollout | DSH SessionEvent |
| --- | --- |
| `session_meta` / `turn_context` | `SessionHeader` (id / cwd / createdAt / model) |
| `response_item message role=user` (`input_text`) | `turn/start` + `step/start` + `user/message` |
| `response_item message role=assistant` (`output_text`) | `assistant/message` |
| `response_item function_call` / `custom_tool_call` | `tool/call` (attached to the latest assistant step) |
| `response_item function_call_output` / `custom_tool_call_output` | `tool/result` (paired by `call_id` across lines, `sourceEventSeqs` linkage) |
| `response_item reasoning` | skipped (content is encrypted, unreadable) |
| turn ends | `step/end` + `turn/end` |

### ChatGPT web export `conversations.json`

The top level is a JSON array (one file holds all conversations); each conversation object has a `mapping` (a DAG: nodeId → `{ id, message, parent, children }`). Traverse from the root along the active branch (last `children` entry) to rebuild the main thread; placeholder nodes with `message: null` and `author.role === 'system'` are skipped; timestamps are Unix seconds (×1000 → ms). ChatGPT is a chat, the export has no `cwd`, so sessions are not grouped into workspaces.

| conversations.json | DSH SessionEvent |
| --- | --- |
| conversation object (`id` / `title` / `create_time`) | `SessionHeader` (id / createdAt) + `session/title` |
| `mapping` node with `author.role: "user"` | `turn/start` + `step/start` + `user/message` |
| node with `author.role: "assistant"` | `assistant/message` |
| node with `author.role: "tool"` | `tool/result` (attached to the latest step) |
| `author.role: "system"` / `message: null` | skipped |
| turn ends | `step/end` + `turn/end` |

### Cursor agent transcript

Line structure: `{ role: "user" | "assistant", message: { content: [...] } }`, no envelope. Content has only `text` / `tool_use` blocks (`input` is already an object). The first user message is wrapped in `<user_query>` tags (stripped); assistant text frequently contains `"[REDACTED]"` sentinels (client-side privacy stripping, filtered); the transcript contains **no `tool_result`** (tool results live only in the UI bubble store) → only call history is imported; there are no timestamps / model, the session id comes from the file name (composer uuid), and there is no `cwd`.

| Cursor transcript | DSH SessionEvent |
| --- | --- |
| `role: "user"` (text wrapped in `<user_query>`) | `turn/start` + `step/start` + `user/message` |
| `role: "assistant"` text blocks | `assistant/message` |
| `role: "assistant"` `tool_use` blocks | `tool/call` (no `tool/result` — the transcript has no results) |
| `[REDACTED]` sentinels | filtered |
| turn ends | `step/end` + `turn/end` |

### Gemini CLI session JSON

Storage: `~/.gemini/history/<slot>/chats/session-*.json` — one JSON object per file (not JSONL). Top level: `{ sessionId, projectHash, startTime, directories, kind, messages: [...] }`. Message types: `user` (content is a parts array) starts a turn; `gemini` (string content, optional `thoughts` and `toolCalls`) is one assistant step; `info` (CLI system notices such as error banners / cancellations) is skipped. Tool results are **inline** on the same object as the call (unlike Claude's split messages).

| Gemini session JSON | DSH SessionEvent |
| --- | --- |
| top-level (`sessionId` / `startTime` / `directories[0]`) | `SessionHeader` (id / createdAt / cwd) |
| `type: "user"` (parts array) | `turn/start` + `step/start` + `user/message` |
| `type: "gemini"` string content | `assistant/message` |
| `thoughts` entries | `reasoning` content blocks |
| `toolCalls[].args` + inline `result` | `tool/call` + `tool/result` (same step, `sourceEventSeqs` linkage; `status: "error"` → `isError`) |
| `type: "info"` | skipped |
| turn ends | `step/end` + `turn/end` |

`SessionHeader`: `version: 0`, `id: import-<source sessionId>`, `createdAt` (source timestamp; import time when the source has none, e.g. Cursor), `cwd` (source working directory; absent for ChatGPT exports and Cursor transcripts).

## Build

Pure ESM, no build step: `index.mjs` is the Host plugin entry (the conversion core lives in dependency-free `convert.mjs`, unit-testable on its own); no `tsc` / bundling.

## Install

```bash
dsh plugin --profile web add -w link:/path/to/dsh-chat-import
```

Or, once published to npm:

```bash
dsh plugin --profile web add dsh-chat-import
```

`dsh plugin` is a pnpm forwarder: after `add` it reads the `dsh.bundle` declaration, folds the `cordis.patch.yml` `insert` lines into the profile's bundles, and the plugin is active after restarting dsh. For local development a `link:` (symlink) is recommended.

## Compatibility

- **Dependency surface**: consumes only public host plugin APIs (`sessionPersistence` / `fs` / `tools` / `workspaceRegistry`) and `@deepseek-ai/dsh-tools` (declared as `peerDependencies`, tested against `0.1.0-rc.6`).

| Source format | Location | Import tool | Verified |
| --- | --- | --- | --- |
| Claude Code | `~/.claude/projects/<slug>/<sessionId>.jsonl` | `import_claude` | ✅ 44 tool/call + 44 tool/result persisted, `load OK` |
| Codex / ChatGPT CLI | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | `import_codex` | ✅ unit + mock integration (`npm test`) |
| ChatGPT web export | ZIP → `conversations.json` | `import_chatgpt` | ✅ unit + mock integration (`npm test`) |
| Cursor | `~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl` | `import_cursor` | ✅ unit + mock integration (`npm test`) |
| Gemini CLI | `~/.gemini/history/<slot>/chats/session-*.json` | `import_gemini` | ✅ unit + mock integration (`npm test`) |

- **Verified**: 2026-08 on `dsh 0.1.0-rc.6` web profile — full "import → resume → workspace attach" run; `npm test` (50 cases) covers the pure conversion logic and mock integration paths for all five source formats.

## Uninstall

Remove `import-claude` from the profile's bundles (the `insert` line in `cordis.patch.yml`) and restart dsh; the plugin stops loading. Already-imported sessions stay in the DSH data directory and are unaffected.

## Usage

In a session with this plugin mounted, call the tools:

```
import_claude({ path: "C:\\Users\\<you>\\.claude\\projects\\<slug>\\<sessionId>.jsonl" })
import_codex({ path: "C:\\Users\\<you>\\.codex\\sessions\\2026\\05\\18\\rollout-2026-05-18T21-14-16-xxxx.jsonl" })
import_chatgpt({ path: "C:\\Users\\<you>\\Downloads\\chatgpt-export\\conversations.json" })
import_cursor({ path: "C:\\Users\\<you>\\.cursor\\projects\\<slug>\\agent-transcripts\\<composer-id>\\<composer-id>.jsonl" })
import_gemini({ path: "C:\\Users\\<you>\\.gemini\\history\\<slot>\\chats\\session-2026-04-17T18-09-b26d7f99.json" })
```

`import_claude` / `import_codex` / `import_cursor` / `import_gemini` behave alike: `path` can be a single file or a directory; optional `sessionId` overrides the target DSH session id (default `import-<source sessionId>`; Cursor uses the file-name composer id). They return `{ mode: 'single', sessionId, turns, messages, toolCalls, skipped, alreadyImported }`; after importing, refresh the session list to see the new session, already attached to its working directory.

`import_chatgpt` differs: `conversations.json` holds **all** conversations in one file, so even a single file returns the batch shape `{ mode: 'batch', total, imported, alreadyImported, skipped, failed, results: [...] }` (`total` is the conversation count, each `results` entry is one conversation); ChatGPT exports have no `cwd`, so imported sessions are not grouped into workspaces.

### Batch import (directory)

```js
import_claude({ path: "C:\\Users\\<you>\\.claude\\projects" })
import_codex({ path: "C:\\Users\\<you>\\.codex\\sessions" })
import_chatgpt({ path: "C:\\Users\\<you>\\Downloads\\chatgpt-export" })
import_cursor({ path: "C:\\Users\\<you>\\.cursor\\projects" })
import_gemini({ path: "C:\\Users\\<you>\\.gemini\\history" })
```

Directory mode recursively scans (`recursive: false` for top level only) all `.jsonl` (Claude / Codex / Cursor) or `.json` (ChatGPT / Gemini) files; each file imports as one session (likewise each conversation inside a ChatGPT file); non-transcript / empty files are skipped. Returns `{ mode: 'batch', total, imported, alreadyImported, skipped, failed, results: [...] }`, where each `results` entry carries `path`, `status` (`imported` / `already-imported` / `skipped` / `failed`) and session stats.

## Scope & boundaries

- Source transcripts are read-only, never rewritten in place; DSH history events are likewise append-only (deep-frozen) — new events are added, existing ones are never modified.
- Does not modify the DSH engine, apiproxy, or official UI packages; publishes no services, so no isolate realm is needed.
- Reading transcripts outside the workspace requires the session sandbox to allow access to that path.
- Known boundaries: auxiliary records like `permission` / `summary` are not imported; `tool_result` with `is_error` keeps the error flag but drops fields beyond `message.content`; Codex `reasoning` content is encrypted and unreadable, so it is skipped (planned for v1.2); ChatGPT exports rebuild only the main thread (branch = last child), tool messages attach to the nearest step as text without restoring the tool-argument structure; Cursor transcripts contain no `tool_result` (results live only in the UI bubble store) — only `tool/call` history is imported, and `[REDACTED]` text is filtered; Gemini imports follow observed format as of 2026-04 (Gemini publishes no stable schema) — `thoughts` map to `reasoning`, inline tool results are honored when present; five source formats are supported today: Claude Code JSONL, Codex / ChatGPT CLI rollout, ChatGPT web export, Cursor agent transcripts, and Gemini CLI sessions.

## Tests

```bash
npm test
```

`test/convert.test.mjs` covers the pure conversion logic for all five source formats (turn balance, tool linkage, titles, malformed lines, injection filtering, duplicate-message dedup, mapping branches / placeholder nodes, REDACTED filtering, inline tool results); `test/index.test.mjs` runs the full `apply → execute` path with mock `fs` / `sessionPersistence` / `tools` / `workspaceRegistry` and validates the return value against the output schema.
