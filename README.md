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

`dsh-chat-import` turns your external agent chat history into **full-fidelity, resumable DeepSeek Harness sessions** — tool calls, reasoning and all. It reads transcripts **read-only** (never rewrites your source files), never touches the DSH engine, and appends every import as a fresh, event-balanced session log through the public `sessionPersistence` service, grouped into the workspace of its `cwd`.

`7 sources` · `Copy-only` · `Seamlessly resumable` · `Auto workspace grouping`

## ✨ Features

- **📥 Import from 7 sources** — Claude Code JSONL, Codex / ChatGPT CLI rollouts, ChatGPT web exports, Cursor agent transcripts, Gemini CLI sessions, Reasonix sessions, and opencode SQLite history. One plugin, one call per source.
- **🔍 Full fidelity** — tool history becomes real `tool/call` + `tool/result` pairs (error flags and `sourceEventSeqs` linkage included), thinking blocks become `reasoning`, multi-step assistant messages are preserved.
- **▶️ Seamlessly resumable** — every import synthesizes a balanced, loadable session (`turn/start` → `step/start` → `user/message` → `assistant/message` → `tool/call`/`tool/result` → `step/end` → `turn/end`): open it and keep chatting.
- **🗂 Auto workspace grouping** — sessions land in the workspace of their source `cwd` (no more "ungrouped"); session id, title, model and creation time are preserved where the source records them.
- **🔁 Idempotent + incremental** — re-importing an unchanged source skips it without re-reading the file; a grown source appends only its **new turns** to the same DSH session (`seq` continues, nothing already imported is rewritten); a truncated source is detected (`sourceShrunk`) and reported without touching the imported session; malformed lines are counted and reported, never aborting the import.
- **📦 Batch import** — point at a directory (or the whole opencode DB) and every file / conversation becomes its own session, with a per-file summary.

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

## 🗂 What can I import?

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
- Returns `{ mode: 'single', sessionId, turns, messages, toolCalls, skipped, alreadyImported, status }` where `status` is `imported` | `already-imported` | `appended` | `skipped`, plus optional `appendedTurns` / `appendedEvents` (grew), `sourceShrunk` (truncated), `changedInPlace` (grew inside existing turns — append-only cannot rewrite them), `argsChanged` (import parameters changed), `backfilled` (registry record restored for a legacy import), `forceImported: { previous, current }` (force / sessionId-change copy) and `droppedBoundaryResults`.

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

The registry record stores `{ kind, dshId, turns, events, sizeBytes, version, args, importedAt }` (multi-session sources keep a per-conversation / per-session sub-table); it tolerates a missing or corrupted file (falls back to an empty registry and re-records on the next import). All registry writes are atomic (temp + fsync + rename) and serialized in-process, and use `node:fs/promises` directly — never `ctx.fs`, whose sandbox would refuse writes under `~/.dsh`.

## 🧩 Data model

The importer cuts each transcript into turns on "direct human prompts" (a `user` record with string `content`), and synthesizes one closed DSH round per turn:

```
turn/start → step/start → user/message → assistant/message → (tool/call + tool/result) → step/end → turn/end
```

Messages carry stable ids and `surfaceOp: 'append'`; `tool/result` events link back to their `tool/call` via `sourceEventSeqs`. Assistant `source` is `{ kind: 'model', provider: 'claude-code', model: <source model> }`; `tool/result` source is `{ kind: 'tool', callId }`. The `SessionHeader` keeps `version: 0`, `id: import-<source sessionId>`, source `createdAt` and `cwd`.

**Import marker (`session/imported`):** every imported session opens with a marker event at `seq: 0`, before the first `turn/start`. It carries `ignorable: true`, so the read pipeline accepts it as a known-but-ignorable event (`KNOWN_SESSION_EVENT_TYPES || ignorable`) instead of an unknown one. Its `data` records the provenance — `{ tool, sourceId, sourcePath, importedAt }`: `tool` is the source identifier (`claude-code` / `codex` / `chatgpt` / `cursor` / `gemini` / `reasonix` / `opencode`), `sourceId` the original source session id, `sourcePath` the absolute transcript / database path the session was imported from (the idempotency key for the imports registry), and `importedAt` the import timestamp. The marker is written only when the transcript yields at least one turn — empty imports are skipped without a session or marker.

**Call/result pairing invariant:** every `tool/call` is paired with a `tool/result` (`sourceEventSeqs` points back to its call), and each result is attached to the step that declared its call — so the projected message order stays wire-legal (every `role: 'tool'` message sits immediately after the assistant message whose `tool_calls` it answers, never separated by another assistant). When the transcript never recorded a result for a call (interrupted sessions, Cursor transcripts that contain no results), the importer synthesizes an empty `tool/result` (`content: []`) in the call's own step so the session still resumes — model APIs reject history in which an assistant `tool_calls` block has no matching tool message. The empty content is not fabricated text; wire adapters normalize it to `"(no output)"`.

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

Line envelope: `{ timestamp, type, payload }`. `event_msg` user/agent messages duplicate `response_item` records and are ignored; user blocks starting with `<` (`<environment_context>`, `<user_instructions>`, …) are harness injections and never enter the prompt. Codex `reasoning` content is encrypted and skipped. A `function_call` / `custom_tool_call` without a matching `*_output` record (session cut off) gets a synthesized empty `tool/result`.

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

- Consumes only public host plugin APIs (`sessionPersistence` / `fs` / `tools` / `workspaceRegistry`) and `@deepseek-ai/dsh-tools`, declared as a `peerDependencies` range `^0.1.0-rc.6` (currently resolving to `0.1.0-rc.6`, the version the plugin is tested against).
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

- **Tested**: `dsh 0.1.0-rc.6` + `dsh-tools 0.1.0-rc.6` — full "import → resume → workspace attach" run on the web profile (2026-08); `npm test` (109 cases) covers the pure conversion logic and mock integration paths for all seven source formats.
- **Expected**: `dsh-tools ^0.1.0-rc.6` — the `dsh 0.1.x` line, the same range the host install uses.
- **Out of band**: `<0.1.0-rc.6` and `>=0.2.0` are untested — after a `dsh` major upgrade, run a headless smoke test first, then update this matrix.

## 🔒 Safety & boundaries

- Source transcripts are read-only, never rewritten; DSH history events are append-only (deep-frozen) — new events are added, existing ones are never modified.
- The plugin never modifies the DSH engine, apiproxy, or official UI packages; it publishes no services, so no isolate realm is needed.
- Reading transcripts outside the workspace requires the session sandbox to allow access to that path.
- Known boundaries: `permission` / `summary` auxiliary records are not imported; `tool_result` with `is_error` keeps the error flag but drops fields beyond `message.content`; Claude subagent / workflow fragment transcripts are skipped (only the main `<sessionId>.jsonl` becomes a session) and a `tool_result` with no matching `tool_use` is dropped and counted (`droppedToolResults`); Codex `reasoning` is encrypted and skipped; ChatGPT exports rebuild only the main thread (branch = last child) and tool messages degrade to text blocks on the nearest step (exports carry no structured tool calls, so no orphan `tool/result` is produced); Cursor transcripts have no `tool_result` (every call gets a synthesized empty `tool/result`) and `[REDACTED]` text is filtered; Gemini follows the format observed 2026-04 (no stable official schema); Reasonix reads the JSONL checkpoint (the V2 WAL is excluded); opencode `patch` parts carry no diff (placeholder `[patch: <N> files]` only) and tool output may keep ANSI escapes verbatim.
- **Re-import after this fix:** already-imported sessions are immutable logs — the plugin never rewrites existing history. Growth is appended incrementally; sessions imported by an older version that lack the call/result pairing cannot be repaired in place (delete the stale session and re-import to pick up the pairing invariant). A source that shrank (`sourceShrunk`) or changed inside already-imported turns (`changedInPlace`) is skipped and reported — `force: true` gives a complete fresh copy.

## 🧪 Tests

```bash
npm test
```

`test/convert.test.mjs` covers the pure conversion logic for all seven source formats (turn balance, tool linkage, titles, malformed lines, injection filtering, dedup, mapping branches, REDACTED filtering, inline tool results, v1/v2 tool-call shapes, opencode part mapping and model fallback); `test/index.test.mjs` runs the full `apply → execute` path with mock `fs` / `sessionPersistence` / `tools` / `workspaceRegistry` (and a real SQLite temp DB for `import_opencode`) and validates the return value against the output schema.

## 📦 Install & uninstall

```bash
dsh plugin --profile web add dsh-chat-import        # npm package
dsh plugin --profile web add -w link:/path/to/dsh-chat-import   # local checkout (symlink, recommended for development)
```

`dsh plugin` is a pnpm forwarder: after `add` it reads the `dsh.bundle` declaration, folds the `cordis.patch.yml` `insert` lines into the profile’s bundles, and the plugin is active after restarting dsh.

To uninstall, remove the `import-claude` insert line from the profile’s bundles and restart dsh. Already-imported sessions stay in the DSH data directory and are unaffected.

## 📄 License

MIT — see [LICENSE](LICENSE).
