# Changelog

All notable changes to `dsh-chat-import` are documented here, newest first.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Every entry maps to commits in the repository history
(`git log --oneline --no-decorate`); the 0.1.0 boundary is anchored to the first
npm publish timestamp (cross-checked with `npm view dsh-chat-import time`).
Release dates are the npm publish timestamps in Asia/Shanghai (UTC+8).

## [0.2.0] - Unreleased

Second minor release — **merged to `main` since `v0.1.1`, not yet published**
(`package.json` is still `0.1.1`). Two new import sources (Reasonix, opencode),
three import-correctness fixes, and documentation / CI housekeeping.

### Added

- **Reasonix session import** (`import_reasonix`) — OpenAI-style JSONL sessions
  with v1/v2 `tool_calls`, sibling meta-file for `cwd` and a pinned title, and a
  filename-embedded creation-time fallback ([b50b1cd](https://github.com/Nwflower/dsh-chat-import/commit/b50b1cd)).
- **opencode session import** (`import_opencode`) — reads the SQLite
  `session`/`message`/`part` tables with inline tool results, respects opencode
  conversation compaction by default, supports `sessionIds` and `fullHistory`
  ([02a87a2](https://github.com/Nwflower/dsh-chat-import/commit/02a87a2)).
- **`package-lock.json` for reproducible CI installs**, with the npm cache
  re-enabled in CI ([651f202](https://github.com/Nwflower/dsh-chat-import/commit/651f202), [67f7c2b](https://github.com/Nwflower/dsh-chat-import/commit/67f7c2b)).
- **Awesome-list badges** on the bilingual READMEs ([1f1e7ce](https://github.com/Nwflower/dsh-chat-import/commit/1f1e7ce), [e1d3faa](https://github.com/Nwflower/dsh-chat-import/commit/e1d3faa)).

### Fixed

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
