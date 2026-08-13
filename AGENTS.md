# AGENTS.md

`dsh-chat-import` 是 DeepSeek Harness 的 Host 插件：把 Claude Code 的 JSONL transcript **全保真**导入为**可继续（resume）**的 DSH 会话。DSH 的哲学是 **everything is a plugin**——本仓库只做插件，不碰引擎。改代码前先读 `README.md`（对外契约）与 `test/`（现有行为）。

## 仓库布局：发布面 / 本地工程面

根目录只放发布到 GitHub / npm 的文件；本地工程文件一律收进 `dev/`（gitignore，永不提交）。

```
index.mjs        插件入口（唯一 host 面文件）：注册 import_claude 工具
convert.mjs      转换核心（纯函数、零 DSH 依赖、可独立单测）
cordis.patch.yml bundle 声明（insert import-claude）
package.json     npm 包元数据；files 白名单 = 发布内容
README.md        对外契约，行为变更必须同步
LICENSE          MIT
test/            单测 + mock ctx 集成测试（进 GitHub，不进 npm 包）
dev/             ❌ 本地工程面：HANDOFF.md、GROWTH.md、脚本、夹具——永不提交
```

- `package.json` 的 `files` 白名单就是 npm 发布面：`index.mjs`、`convert.mjs`、`cordis.patch.yml`、`README.md`、`LICENSE`。新增被 `index.mjs` import 的模块必须同步加进 `files`。
- **永不提交**：`dev/`、`node_modules/`、`.prev-session*.jsonl`、真实用户 transcript（含敏感内容）、任何凭据/密钥。

## 命令

```sh
npm test        # node --test 跑 test/*.test.mjs（convert 单测 + index mock 集成测试）
```

无构建步骤：纯 ESM，`index.mjs` / `convert.mjs` 即发布产物。DSH 手工验证：`dsh plugin --profile web add -w link:<本仓库路径>` 后重启 dsh，在会话里调 `import_claude`。

## 提交纪律（保持仓库干净）

- **conventional commit 前缀**：`feat:` / `fix:` / `refactor:` / `chore:` / `docs:` / `test:`，中文描述，沿用现有历史风格（如 `feat: batch import (#7) — directory scan, per-file sessions, summary`）。
- **一个逻辑变更一个 commit**：不混改（重构不带新功能，修 bug 不带 docs），不提交 WIP / 中间态。
- **提交前必过**：
  1. `npm test` 全绿；
  2. `git status` 无杂物（`dev/`、`node_modules/`、快照不得出现在待提交里）；
  3. `git diff --cached --check` 无空白错误。
- **行为变更同 commit 更新 README 与测试**：README 是对外契约，测试描述现有行为；改行为必须连测试一起改，并在 commit 信息里说明为什么。
- 提交信息说明「为什么」而非复述代码；指向关联 issue/PR 编号。
- push 前自查：`git log --oneline` 每一条都是一个完整、可读的逻辑单元；工作树干净。
- 重写已推送历史时只用 `--force-with-lease`，远程有变动立即中止——本仓库是单人直推 `main`，尽量不重写。

## DSH 插件约束

- **只消费 host 公开服务**：`sessionPersistence`（create + append）、`fs`、`tools`、`workspaceRegistry`。不发布服务 → 无需 isolate realm；无 Browser 侧。
- **插件，不是引擎改动**：新行为走公开扩展点（工具注册）；绝不修改 DSH 引擎 / apiproxy / 官方 UI 包。
- **会话日志 append-only、deep-frozen**：只 `create` + `append`，绝不改写历史事件。
- **模型可见 ⟺ 落盘**：进入模型上下文的任何内容必须能从会话日志重建；新模型可见输入必须对应会话事件。
- **事件纪律**：`seq` 从 0 连续；surface 事件（`user/message` / `assistant/message` / `tool/result`）必须带 `surfaceOp: 'append'`；`tool/result` 用 `sourceEventSeqs` 关联其 `tool/call`；`SessionHeader` version 保持 `0`，只做结构性变更才 bump。
- **幂等**：目标会话已存在时跳过（`sessionPersistence.list()` 判重），不重复写入。
- **归组**：`workspaceRegistry.resolveByPath(cwd)` → `workspace.attachSession(id)`，否则会话显示「未分组」。
- **失败要大声**：畸形 JSONL 行计数上报（`skipped`），绝不静默吞掉；读取工作区外的 transcript 需会话沙箱允许。

## 质量约定

- 文件以**恰好一个**换行结尾；空 `catch` 必须说明吞掉什么且 `try` 只包一条语句；不注释代码里显而易见的事实。
- 保持 `convert.mjs` 零依赖纯函数：任何 DSH 依赖只允许出现在 `index.mjs`。
- 测试描述行为而非背书正确性；fixtures 用合成数据，永不掺真实 transcript。
- 不写行内文档废话：注释写契约与上下文，不叙述控制流。

## 编辑本文件

规则保持自包含；改完须与仓库现状一致（目录、命令、约束过时了要同步更新）。
