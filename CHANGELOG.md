# Changelog

All notable changes to `dsh-chat-import` are documented here, newest first.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Every entry maps to commits in the repository history
(`git log --oneline --no-decorate`); the 0.1.0 boundary is anchored to the first
npm publish timestamp (cross-checked with `npm view dsh-chat-import time`).
Release dates are the npm publish timestamps in Asia/Shanghai (UTC+8).

## [0.3.0] - Unreleased

### Added

- **Incremental re-import** (REQ-24) — re-importing the same source path no
  longer just skips: a grown source file appends only its **new turns** to the
  same DSH session (contiguous `seq` continued from the authoritative stored
  log, source turn numbering, no duplicated `session/imported` marker or
  title), an unchanged file is skipped on a stat-level short path without
  re-reading it, a truncated file is detected and reported (`sourceShrunk`),
  in-place growth inside existing turns reports `changedInPlace`, and
  `force: true` creates a fresh full copy under `import-<sessionId>-<n>` while
  the old session stays untouched.
- **Source-path idempotency registry** — new `lib/imports.mjs` persists
  `$DSH_HOME/dsh-chat-import/imports.json` (source absolute path → import
  record, `{ kind, dshId, turns, events, sizeBytes, version, args, importedAt }`)
  with atomic temp+fsync+rename writes via `node:fs/promises` (never `ctx.fs`),
  in-process serialized writes, and missing/corrupted-file tolerance. Two
  different source paths sharing one session id now both import (suffix
  avoidance) instead of one silently shadowing the other; sessions imported
  before the registry existed are detected via the `session/imported` marker
  and back-filled (`backfilled`).
- **`tailSessionEvents`** — pure event-level tail extraction in `convert.mjs`
  (slice by `turn/start` boundaries, renumber `seq` from `fromSeq`, remap
  in-tail `sourceEventSeqs`, keep out-of-tail references with a
  `droppedBoundaryResults` count, strip `session/title` by default).
- **Multi-session sources go incremental** — ChatGPT (`kind:'multi'` +
  `conversations` sub-records: per-conversation append / new / removed
  `missingFromSource`, `force` = full new copies) and opencode (`kind:'multi'` +
  `sessions` sub-records: DB-level version/size fingerprinting, compaction
  shrinking turns → `sourceShrunk`, `fullHistory` in the args fingerprint →
  `argsChanged`).
- **Shared `force: boolean` parameter** on all seven import tools, and extended
  return shapes: single-mode `status` (`imported` / `already-imported` /
  `appended` / `skipped`) plus optional `appendedTurns`, `appendedEvents`,
  `appendedSkipped`, `sourceShrunk`, `changedInPlace`, `argsChanged`,
  `backfilled`, `forceImported` and `droppedBoundaryResults`; batch mode gains
  an `appended` counter, `appended` result status and `missingFromSource`.

### Changed

- Idempotency contract updated (bilingual README): "already imported → skip"
  becomes "already imported → skip if unchanged, incrementally append new
  turns if grown" — re-importing a live session now follows the source file.
- Append discipline: appended events keep `surfaceOp: 'append'`, never re-attach
  workspaces, and never re-emit the import marker or session title.


## [0.2.0] - 2026-08-14

Second minor release — shipped 2026-08-14 with two new import sources
(Reasonix, opencode), engineering guardrails (clean lockfile and CI checks,
package metadata) and P0 fixes that keep imported sessions resumable. Tagged
`v0.2.0` (`ae01548`).

### Added

- **Reasonix session import** (`import_reasonix`) — OpenAI-style JSONL sessions
  with v1/v2 `tool_calls`, sibling meta-file for `cwd` and a pinned title, and a
  filename-embedded creation-time fallback ([b50b1cd](https://github.com/Nwflower/dsh-chat-import/commit/b50b1cd)).
- **opencode session import** (`import_opencode`) — reads the SQLite
  `session`/`message`/`part` tables with inline tool results, respects opencode
  conversation compaction by default, supports `sessionIds` and `fullHistory`
  ([02a87a2](https://github.com/Nwflower/dsh-chat-import/commit/02a87a2)).
- **`package-lock.json` for reproducible CI installs**, with the npm cache
  re-enabled in CI ([651f202](https://github.com/Nwflower/dsh-chat-import/commit/651f202), [67f7c2b](https://github.com/Nwflower/dsh-chat-import/commit/67f7c2b));
  later regenerated clean, with CI moved to `npm ci` and a lockfile-drift check
  added ([0389307](https://github.com/Nwflower/dsh-chat-import/commit/0389307)).
- **Awesome-list badges** on the bilingual READMEs ([1f1e7ce](https://github.com/Nwflower/dsh-chat-import/commit/1f1e7ce), [e1d3faa](https://github.com/Nwflower/dsh-chat-import/commit/e1d3faa)).
- **CHANGELOG itself** — 0.1.0 / 0.1.1 / 0.2.0 sections following Keep a
  Changelog, shipped in the npm package ([f9a1918](https://github.com/Nwflower/dsh-chat-import/commit/f9a1918)).
- **Bilingual README structure sync check in CI** — heading hierarchy and
  anchor keys compared between `README.md` and `README.zh-CN.md`
  ([a12480d](https://github.com/Nwflower/dsh-chat-import/commit/a12480d)).
- **Headless real-load smoke job in CI** — boots the plugin with a mock LLM to
  verify it activates outside the live harness ([0e8bdd7](https://github.com/Nwflower/dsh-chat-import/commit/0e8bdd7)).

### Fixed

- **Imported sessions stay resumable when a `tool/call` has no matching
  result** (P0) — model APIs reject an assistant message whose `tool_calls`
  never get a corresponding tool message, so a synthetic empty `tool/result` is
  appended to keep continuation working ([1d9a8e5](https://github.com/Nwflower/dsh-chat-import/commit/1d9a8e5)).
- **Imported message order follows the wire rules** (P0) — `tool/result` is
  attached to the step owning its `tool/call`, and Codex imports gain the
  missing tool-call block, so the projected order no longer violates the
  assistant-`tool_calls`-then-tool-message contract and sessions stay resumable
  ([d13f790](https://github.com/Nwflower/dsh-chat-import/commit/d13f790)).
- **Claude directory imports only recognize the main transcript** — subagent /
  workflow fragments are skipped so they can never shadow or collide with the
  main conversation ([77de7cd](https://github.com/Nwflower/dsh-chat-import/commit/77de7cd)).
- **`tool/result` links its `tool/call` across steps** — `sourceEventSeqs` now
  points at the originating call even when the result lands in a later step
  ([f33824d](https://github.com/Nwflower/dsh-chat-import/commit/f33824d)).
- **Reasonix creation-time falls back to the filename timestamp** when neither
  the transcript nor the meta file carries one ([bf8b05e](https://github.com/Nwflower/dsh-chat-import/commit/bf8b05e)).
- **opencode directory import joins paths portably** instead of hard-coding a
  separator ([72238ba](https://github.com/Nwflower/dsh-chat-import/commit/72238ba)).

### Changed

- **README rewritten (bilingual)** around quick start, features and a 7-source
  overview table; test count corrected 68 → 79 ([585cece](https://github.com/Nwflower/dsh-chat-import/commit/585cece)).
- Reasonix import documented in the bilingual READMEs ([0aded42](https://github.com/Nwflower/dsh-chat-import/commit/0aded42)).
- Multi-session protocol documents the pending-merge area ([c691324](https://github.com/Nwflower/dsh-chat-import/commit/c691324)).
- Peer dependency policy relaxed to `^0.1.0-rc.6` so the plugin installs
  alongside newer DSH releases ([117e7a1](https://github.com/Nwflower/dsh-chat-import/commit/117e7a1)).
- `package.json` metadata completed and `engines` pinned to `>=22.13`, with the
  lockfile's engines entry synced to match ([7162957](https://github.com/Nwflower/dsh-chat-import/commit/7162957), [41ad12a](https://github.com/Nwflower/dsh-chat-import/commit/41ad12a)).

## [0.1.1] - 2026-08-14

First patch release — shipped the batch-import error-detail fix together with
the Cursor and Gemini sources, the bilingual README and the project LOGO.
Tagged `v0.1.1` (`586a5f9`).

### Added

- **Cursor agent transcript import** (`import_cursor`) — strips the
  `<user_query>` wrapper on the first user message, filters `[REDACTED]`
  sentinels, maps `tool_use` blocks to `tool/call` (no result in the transcript)
  ([73571f6](https://github.com/Nwflower/dsh-chat-import/commit/73571f6)).
- **Gemini CLI session import** (`import_gemini`) — user/gemini/info message
  types, `thoughts` → reasoning, inline tool calls and results
  ([20c3f17](https://github.com/Nwflower/dsh-chat-import/commit/20c3f17), [0a1aea7](https://github.com/Nwflower/dsh-chat-import/commit/0a1aea7)).
- **Bilingual README** (`README.md` + `README.zh-CN.md` with a language
  switcher), with the Chinese edition shipped in the npm package
  ([6a880cb](https://github.com/Nwflower/dsh-chat-import/commit/6a880cb), [795bf83](https://github.com/Nwflower/dsh-chat-import/commit/795bf83)).
- **Project LOGO** (`assets/import.svg`) wired into the READMEs and the npm
  publish surface ([c696178](https://github.com/Nwflower/dsh-chat-import/commit/c696178), [586a5f9](https://github.com/Nwflower/dsh-chat-import/commit/586a5f9)).
- **`npm pack --dry-run` as a publish-surface regression guard** in CI
  ([7422e48](https://github.com/Nwflower/dsh-chat-import/commit/7422e48)).

### Fixed

- **Batch import reports per-file error detail** — the completion summary now
  lists up to five failed/skipped paths with their reasons instead of aggregate
  counts only (the reason for this release; [fb657a2](https://github.com/Nwflower/dsh-chat-import/commit/fb657a2)).

### Changed

- README first-screen: badge row, tagline and a compatibility matrix for the
  then-four sources ([572222c](https://github.com/Nwflower/dsh-chat-import/commit/572222c)).
- CI npm cache dropped (no lockfile yet at the time) ([ad9ce48](https://github.com/Nwflower/dsh-chat-import/commit/ad9ce48));
  `.gitignore` extended for editor/system noise ([243fbb2](https://github.com/Nwflower/dsh-chat-import/commit/243fbb2)).

## [0.1.0] - 2026-08-13

Initial release — the plugin's first npm publish (untagged). Imports Claude
Code, Codex / ChatGPT CLI and ChatGPT web-export histories as full-fidelity,
resumable DSH sessions.

### Added

- **Claude Code JSONL import** (`import_claude`) — full-fidelity tool history
  (real `tool/call` + `tool/result` pairs with `sourceEventSeqs` linkage),
  multi-step assistant messages and thinking blocks; `ai-title` becomes the
  session title ([e791dbe](https://github.com/Nwflower/dsh-chat-import/commit/e791dbe), [775d675](https://github.com/Nwflower/dsh-chat-import/commit/775d675), [fe619d7](https://github.com/Nwflower/dsh-chat-import/commit/fe619d7)).
- **Codex / ChatGPT CLI rollout import** (`import_codex`) — `session_meta` /
  `turn_context` header, `response_item` messages, function / custom tool calls
  paired by `call_id`; harness-injection blocks and encrypted reasoning skipped
  ([681ff08](https://github.com/Nwflower/dsh-chat-import/commit/681ff08)).
- **ChatGPT web export import** (`import_chatgpt`) — `conversations.json` as a
  batch, main thread rebuilt from the `mapping` DAG, placeholder / system nodes
  skipped ([adbc8fd](https://github.com/Nwflower/dsh-chat-import/commit/adbc8fd)).
- **Batch import** — recursive directory scan, one session per file, per-file
  summary ([d39c509](https://github.com/Nwflower/dsh-chat-import/commit/d39c509)).
- **Idempotent import** — re-importing skips sessions that already exist
  ([abb930d](https://github.com/Nwflower/dsh-chat-import/commit/abb930d)).
- **Skipped-malformed reporting** — malformed records are counted and reported,
  never silently dropped ([a8a5fc4](https://github.com/Nwflower/dsh-chat-import/commit/a8a5fc4)).
- **Pure conversion core** (`convert.mjs`) split from the host-facing entry
  ([73396c8](https://github.com/Nwflower/dsh-chat-import/commit/73396c8)).

### Changed

- Project scaffolding for npm / GitHub: publish metadata, MIT license, peer
  dependency, publish-surface split, CI workflow, AGENTS.md and the
  multi-session protocol ([8de15e0](https://github.com/Nwflower/dsh-chat-import/commit/8de15e0), [4ff8390](https://github.com/Nwflower/dsh-chat-import/commit/4ff8390), [69702de](https://github.com/Nwflower/dsh-chat-import/commit/69702de), [1f0fddd](https://github.com/Nwflower/dsh-chat-import/commit/1f0fddd), [e7b1acd](https://github.com/Nwflower/dsh-chat-import/commit/e7b1acd), [8d485d2](https://github.com/Nwflower/dsh-chat-import/commit/8d485d2), [f6bfb65](https://github.com/Nwflower/dsh-chat-import/commit/f6bfb65)).
- Line endings normalized to LF via `.gitattributes` / `.editorconfig` to
  prevent cross-machine churn ([912c28d](https://github.com/Nwflower/dsh-chat-import/commit/912c28d)).
