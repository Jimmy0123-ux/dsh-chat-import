# Roadmap

> dsh-chat-import 的需求总览与路线图。状态标记：✅ 已完成 · ◐ 部分完成 · ☐ 未完成。
> 实现细节与历史见 [CHANGELOG.md](CHANGELOG.md) 与 git 历史。

## 生态收录

`dsh-chat-import` 已收录于：[awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) · [AdamPlatin123/awesome-dsh-plugins](https://github.com/AdamPlatin123/awesome-dsh-plugins)（PR #4 已 merged，行尾 ✅）· [0xsline/awesome-deepseek-harness](https://github.com/0xsline/awesome-deepseek-harness) · [Dominic789654/awesome-deepseek-harness](https://github.com/Dominic789654/awesome-deepseek-harness) · [Alex-Yanggg/awesome-DSH-plugin](https://github.com/Alex-Yanggg/awesome-DSH-plugin) · [Zhiyuan-Fan/Awesome-DeepSeek-Harness-Plugins](https://github.com/Zhiyuan-Fan/Awesome-DeepSeek-Harness-Plugins) · [bruc3van/awesome-dsh-plugin](https://github.com/bruc3van/awesome-dsh-plugin) · [kejixiaoliang/awesome-dsh-plugins](https://github.com/kejixiaoliang/awesome-dsh-plugins) · [dshbase.com 插件目录](https://dshbase.com/plugins/dsh-chat-import/) · [awesome-dsh-plugin.com 兼容性徽章](https://awesome-dsh-plugin.com) · npm registry。

自动收录渠道（打 `dsh-plugin` topic 即收录）：ZASENJC/dsh-plugins-store、YELEBAI/dsh-plugin-marketplace、bradeGithub/DSH-Plugins-Marketplace 等。

## 能力对照（DSH 生态会话导入工具）

| 能力 | dsh-chat-import | 生态内其他 |
| --- | --- | --- |
| 来源数 | 14 源 + 本地 JSONL（15 工具） | 单源 ~ 4 源 |
| 全保真（tool/result + thinking + sourceEventSeqs） | ✅ | 部分 |
| 增量续写（append 新轮次） | ✅ | 部分（复制式） |
| 上下文预算保护 | ✅ | — |
| 反向导出（DSH → Claude Code JSONL） | ✅ | — |
| 反向同步（增量写回，带守卫） | ✅ | — |
| agents / skills 落盘资产（`import_agents`） | ✅ | 部分 |
| Browser 面板 + `/import` 命令 | ✅ | 部分 |
| 会话开始迁移提示 | ✅ | 部分 |

生态内同类工具：[dsh-claude-move](https://github.com/PerryLink/dsh-claude-move)（Claude 会话+资产 copy，REQ-61 跟进点）· [dsh-plugin-cc](https://github.com/cpj-dev/dsh-plugin-cc)（DSH↔Claude 控制面桥）· [dsh-movein](https://github.com/sjh9714/dsh-movein)（Claude 配置迁移，README 指向我们补会话——互补）· [dsh-plugin-session-import](https://github.com/huguangyu666/dsh-plugin-session-import) · [dsh-import-agents](https://github.com/Chang-Tong/dsh-import-agents) · [opencode-dsh-importer](https://github.com/wang-xudong/opencode-dsh-importer) · [dsh-resume-plugin](https://github.com/Demogorgon314/dsh-resume-plugin) · [dsh-session-import](https://github.com/kinyokun/dsh-session-import) · [dsh-plugin-codex-import](https://github.com/Gordonynh/dsh-plugin-codex-import)。

## 需求总览

| ID | 优先级 | 标题 | 状态 |
| --- | --- | --- | --- |
| REQ-01 | P0 | 重生成干净 lockfile + CI 改 `npm ci` + 防漂移检查 | ✅ |
| REQ-02 | P0 | 收口版本漂移：bump 0.2.0 发布（含 Reasonix/opencode） | ✅ |
| REQ-03 | P1 | 标签纪律：统一 `npm version` bump + tag 流程 | ✅ |
| REQ-04 | P1 | 引入 CHANGELOG | ✅ |
| REQ-05 | P1 | CI 增加 headless 真实加载冒烟 | ✅ |
| REQ-06 | P1 | CI 检查双语 README 同步 | ✅ |
| REQ-07 | P1 | peer 版本策略与兼容矩阵 | ✅ |
| REQ-08 | P2 | `index.mjs` 按职责拆分 | ✅ |
| REQ-09 | P2 | `makeImportTool` 参数收敛 | ☐ |
| REQ-10 | P2 | 引入 eslint + CI 检查 | ✅ |
| REQ-11 | P2 | 修正 dev 文档过时信息 | ✅ |
| REQ-12 | P3 | package.json 元数据补齐 + engines 精确化 | ✅ |
| REQ-13 | P3 | CI 覆盖报告（line ≥ 75% 护栏） | ✅ |
| REQ-14 | P1 | 多源：Kimi CLI 适配（`import_kimi`，第 13 源） | ✅ |
| REQ-15 | P1 | 多源：ZCode 格式侦察 | ✅ 并入 REQ-38 |
| REQ-16 | P1 | 互转：反向导出 MVP — DSH → Claude Code JSONL（`export_claude`） | ✅ |
| REQ-17 | P1 | 保真度：导入 dry-run 预览 | ✅ |
| REQ-18 | P2 | 互转：IR 协议化（interchange v1 schema + 文档） | ☐ |
| REQ-19 | P2 | 保真度：ChatGPT 分支还原 + tool 参数结构化 | ☐ |
| REQ-20 | P2 | 保真度：Cursor tool_result / opencode patch diff 复查 | ✅ 边界确认 |
| REQ-21 | P2 | 互转：保真度降级策略显式化 | ☐ |
| REQ-22 | P3 | 保真度：Reasonix V2 WAL 合并 + Claude compacted 摘要选项 | ☐ |
| REQ-23 | P3 | 互转：矩阵化互转 + repair 校验工具 | ☐ |
| REQ-24 | P0 | 增量续写（重导 append 新轮次 + 源路径幂等键 + force 副本 + sourceShrunk） | ✅ |
| REQ-25 | P1 | 自动发现 + 扫描缓存（scan_discover） | ✅ |
| REQ-26 | P1 | 畸形行行号 + secrets 位置上报 + permission 计数 | ✅ |
| REQ-27 | P1 | 标题兜底（custom-title > ai-title > 首问） | ✅ |
| REQ-28 | P2 | memory / skills / CLAUDE.md 上下文桥接（默认关闭） | ✅ |
| REQ-29 | P2 | /import-all 批量命令（Web 面板 REQ-41、/import REQ-42 已落地） | ◐ |
| REQ-30 | P2 | 交接摘要续聊（/resume-claude /resume-codex） | ☐ |
| REQ-31 | P3 | 竞品 / 官方能力监控（周期性） | ✅ |
| REQ-32 | P1 | 内部标记：`session/imported` 事件 | ✅ |
| REQ-33 | P2 | 导入识别 / 撤回（`list_imported_sessions` + 引导手动删） | ✅ |
| REQ-34 | P2 | UI 分组：host-only Web 面板 | ✅ 由 REQ-41 Browser 面板取代 |
| REQ-35 | P2 | 卸载语义（自动撤 Hook、绝不删会话；手动清理引导） | ✅ |
| REQ-36 | P1 | 反向同步：双向同步桥 B 第一步（`sync_to_claude` 增量写回） | ✅ 真实 `claude --resume` 验证待补 |
| REQ-37 | P1 | 超长会话三层保护 + 预算自适应 | ✅ |
| REQ-38 | P1 | ZCode 源适配 | ✅ |
| REQ-39 | P2 | cwd 权威映射 + 沙箱防护 | ◐ lite 已落地（回退源目录归组）；full 待做 |
| REQ-40 | P2 | 发现索引补充（标题/项目/消息数 + 扫描缓存 + 搜索） | ✅ |
| REQ-41 | P2 | Browser 侧侧边栏入口（导入面板） | ✅ |
| REQ-42 | P2 | `/import <tool> <path>` 命令面 | ✅ |
| REQ-43 | P2 | 导入会话工具完整可用（agentPresets.mount + 默认模型绑定） | ☐ |
| REQ-44 | P2 | codex `custom_tool_call` JS 参数转标准 JSON | ✅ |
| REQ-45 | P3 | 源覆盖面：Reasonix 桌面版 + Claude-3p 新端 | ◐ 侦察完成；实现待真机校准 |
| REQ-46 | P1 | 新源：Grok Build 适配（第 9 源） | ✅ |
| REQ-47 | P1 | 新源：OpenClaw 适配（第 10 源） | ✅ |
| REQ-48 | P1 | 新源：Hermes 适配（第 11 源） | ✅ |
| REQ-49 | P1 | 缺陷：trimTurns L2 锚点收缩静默丢轮 | ✅ |
| REQ-50 | P2 | Hermes-agent（NousResearch）变体 tool_calls / reasoning 独立列 | ☐ |
| REQ-51 | P3 | Hermes 会话 lineage（parent_session_id 压缩分叉） | ☐ |
| REQ-52 | P2 | Codex 官方 App Server API 路线侦察 | ✅ 维持 rollout |
| REQ-53 | P2 | 新会话开始迁移提示（per-project 记忆） | ✅ |
| REQ-54 | P2 | 源文件变更自动增量续写 + 面板 Sync 入口 | ◐ Sync 已落地；watch 懒检查待做 |
| REQ-55 | P1 | 缺陷：导入会话归档后可重新导入 | ✅ |
| REQ-56 | P2 | DSH 会话通用导出/备份（interchange bundle + 指纹 + 还原） | ☐ |
| REQ-57 | P3 | 导入结果结构校验 | ☐ |
| REQ-58 | P3 | scan_discover 索引补 git 分支/dirty | ✅ |
| REQ-59 | P2 | 外部 agent/mode prompt 落盘转换为 DSH skills 资产（`import_agents`） | ✅ |
| REQ-60 | P1 | 发布规范持续达标（plugin_check 全项：types/cordis peer/tsconfig/build 脚本） | ✅ v0.4.0 |
| REQ-61 | P2 | Claude 资产持久化导入（memory / CLAUDE.md / skills → DSH 资产，扩展 import_agents） | ☐ |
| REQ-62 | P2 | 便携 bundle 跨机器移动用例（对标 codex-claude-transfer） | ☐ |
| REQ-63 | P3 | 仓库社区健康（CONTRIBUTING + issue/PR 模板） | ✅ |

## 未完成需求说明

### P2

- **REQ-18 — 互转 IR 协议化**：把内部 turns IR 显式化为 interchange v1（JSON Schema + 版本 + 语义文档），作为源↔目标双向适配器的中立交换格式。
- **REQ-19 — ChatGPT 分支还原 + tool 参数结构化**：`import_chatgpt` 支持 `branch: 'main' | 'all'`；tool 消息还原 `tool/call` + `tool/result`。
- **REQ-21 — 互转保真度降级策略显式化**：定义降级规则表并在互转/导出结果里逐条报告。
- **REQ-29 — 命令 / Web 面板入口**：`/import-all` 一键批导入（Web 面板与 `/import` 命令已落地，本项剩余命令面收口）。
- **REQ-30 — 交接摘要续聊**：`/resume-claude` / `/resume-codex`，把外部 transcript 当不可信静态历史生成交接摘要。
- **REQ-39 — cwd 权威映射 + 沙箱防护（full）**：Claude `.claude.json` 权威映射 + Reasonix slug 贪心解码 + home-dir 沙箱防护。
- **REQ-43 — 导入会话工具完整可用**：导入会话加入默认 preset scope（工具与正常会话一致）+ 绑定默认模型。
- **REQ-50 — Hermes-agent 变体 schema**：支持独立 `tool_calls` / `reasoning` 列的变体。
- **REQ-56 — DSH 会话通用导出/备份**：interchange bundle + SHA-256 指纹 + 还原预览（与 REQ-18 联动，跨机器用例见 REQ-62）。
- **REQ-61 — Claude 资产持久化导入**：`import_agents` 扩展 Claude 源（memory / CLAUDE.md / skills 落盘为 DSH 资产），对齐 dsh-claude-move 卖点。
- **REQ-62 — 便携 bundle 跨机器移动**：`.codexbundle` 式导出（A 机 → B 机还原 0 skipped，cwd 不可达走 REQ-39-lite 回退归组），对标 codex-claude-transfer；可选 LAN sync。

### P3

- **REQ-22 — Reasonix V2 WAL 合并 + Claude compacted 摘要选项**。
- **REQ-23 — 矩阵化互转 + 校验/修复工具**：DSH↔Claude↔Codex↔Kimi 四向互通 + 只读校验。
- **REQ-45 — 源覆盖面（◐）**：Reasonix 桌面版 + Claude-3p 新端——侦察完成（dev/research/reasonix-desktop-claude-3p-recon.md），WAL schema / 目录层级待真机样本校准后实现。
- **REQ-51 — Hermes 会话 lineage**：`parent_session_id` 压缩分叉，只导链尾可加过滤。
- **REQ-57 — 导入结果结构校验**：seq 连续 / sourceEventSeqs 有效 / 事件白名单。
