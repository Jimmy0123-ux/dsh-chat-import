# DSH Chat Import

`Nwflower/dsh-chat-import` 为 DeepSeek Harness 补充「外部聊天记录导入」能力：把 Claude Code 的 JSONL transcript 导入为**可继续（resume）**的 DSH 会话。插件不改写源文件，也不修改 DSH 引擎内部；每次导入都通过公开的 `sessionPersistence` 追加一条全新的、事件平衡的会话日志，并把会话挂接到其 `cwd` 对应的工作区。

## 功能

- **导入 Claude Code transcript**：读取 `~/.claude/projects/<slug>/<sessionId>.jsonl`，解析 user / assistant 文本。
- **可继续（resume）**：合成 `turn/start`、`step/start`、`user/message`、`assistant/message`、`step/end`、`turn/end` 事件，落盘为平衡、可加载的会话，点开即可续聊。
- **保留会话元数据**：源 `sessionId`、`cwd`、`ai-title`、创建时间。
- **自动挂接工作区**：导入后按 `cwd` 解析/创建工作区并 `attachSession`，会话归组正确（不再「未分组」）。

## 设计

### 事件溯源映射

插件把 Claude Code 的 transcript 记录按「直连人类提问」切轮：`type === 'user'` 且 `content` 为字符串时开新轮；其后所有 `assistant` 文本并入当前轮。每轮合成一个闭合的 DSH 回合：

1. `turn/start` → `step/start` → `user/message` → `assistant/message` → `step/end` → `turn/end`。
2. 消息体带稳定 id（`import:<sessionId>:u<turn>` / `import:<sessionId>:a<turn>`），并带 `surfaceOp: 'append'`。
3. assistant 的 `source` 为 `{ kind: 'model', provider: 'claude-code', model: 'claude-code' }`。

### 服务依赖

- Host 只依赖公开服务：`sessionPersistence`（`create` + `append`）、`fs`（读源文件）、`tools`（注册工具）、`workspaceRegistry`（`resolveByPath` / `create` / `attachSession` 归组）。
- 不发布任何服务，因此无需 isolate realm。
- 无 Browser 侧，纯 Host 插件。

## 数据模型

| Claude Code JSONL | DSH SessionEvent |
| --- | --- |
| `{ type: "user", message.content: string }`（直连提问） | `turn/start` + `step/start` + `user/message` |
| `{ type: "assistant", content: [{ type: "text", text }] }` | `assistant/message` |
| 轮次结束 | `step/end` + `turn/end` |

会话头 `SessionHeader`：`version: 0`、`id: import-<源sessionId>`、`createdAt`（源时间戳）、`cwd`（源工作目录）。

## 构建

纯 ESM，无编译步骤：`index.mjs` 即 Host 插件，无需 `tsc` / 打包。

## 安装

```bash
dsh plugin --profile web add -w link:/path/to/dsh-chat-import
```

`dsh plugin` 是 pnpm 转发器：`add` 后识别 `dsh.bundle` 声明，把 `cordis.patch.yml` 的 `insert` 行收编进 profile 的 bundles，重启 dsh 即生效。本地开发建议用 `link:`（符号链接）。

## 使用

在挂载了本插件的会话里调用工具：

```
import_claude({ path: "C:\\Users\\<you>\\.claude\\projects\\<slug>\\<sessionId>.jsonl" })
```

可选 `sessionId` 覆盖目标 DSH 会话 id（默认 `import-<源sessionId>`）。返回 `{ sessionId, turns, messages }`；导入后刷新会话列表即可看到新会话，且已挂接到其工作目录。

## 范围边界

- **仅文本级（v1）**：`tool_use` / `tool_result` / `thinking` 块被丢弃，工具调用历史不进上下文（v1.1 计划映射为 `tool/call` + `tool/result`）。
- 不原地改写源 transcript，也不改写 DSH 历史事件（历史 append-only、deep-frozen）。
- 不修改 DSH 引擎、apiproxy 或官方 UI 包。
- 读取工作区之外的 transcript 路径时，要求会话沙箱允许访问该路径。
