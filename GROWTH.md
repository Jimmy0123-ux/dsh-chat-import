# dsh-chat-import 增长计划（star 优化）

> 目标：从「功能完整但无人知晓」走向「收录 → 曝光 → 转化 → 传播」的正循环。
> 本文同时是 PR 提交手册：所有收录请求的草稿都在第 2 节，可直接复制使用。

---

## 1. 现状诊断

### 1.1 已修复的硬伤（本次改动）

| 问题 | 影响 | 状态 |
| --- | --- | --- |
| README「范围边界」声称 v1 只导入文本、工具历史被丢弃，但代码已实现全保真（tool/call + tool/result、thinking、多步） | 卖点自残：README 描述比实际能力弱一档 | ✅ 已修正 |
| `package.json` 声明 MIT 但仓库无 LICENSE 文件 | 谨慎用户（尤其企业）不敢用、不敢 star | ✅ 已补 LICENSE |
| `.prev-session*.jsonl` 本地调试产物未进 .gitignore | 一旦误提交会污染仓库、暴露本地路径 | ✅ 已补 .gitignore |

### 1.2 仍待处理的关键问题（按优先级）

1. **`private: true`（package.json）→ 无法 npm 发布**。当前安装方式只有 `link:` 本地路径，别人装不了 = 别人不会 star。npm 发布后 `dsh plugin add dsh-chat-import` 一键安装，是转化率最大的单一杠杆。
2. **无 GitHub topics** → 不会被 `dsh-plugin` 话题页和基于话题抓取的 awesome 列表收录。设置 topics 不需要 PR，在仓库 Settings → Topics 里加（见 2.4）。
3. **README 首屏无图**：没有 demo 录屏/GIF，用户 3 秒内看不到「导入后能续聊」的画面。
4. **README 仅中文**：英文用户（Reddit/HN 主流人群）看不懂 → 国际曝光渠道全废。

---

## 2. 收录渠道 PR 清单（核心引流）

DSH 插件生态的收录节点按价值排序如下。前 3 个必须提，4 是设置项，5/6 视情况。

### 2.1 `dsh-external/hub` — 官方插件注册中心 ⭐必提

- 地址：https://github.com/dsh-external/hub
- 定位：官方/社区共建的插件索引，是 `0xsline/awesome-deepseek-harness` 的数据源，地位最高。
- 动作：先 fork → 看仓库结构（很可能是 plugins 索引 JSON/目录或 README 表格）→ 按 README/CONTRIBUTING 的格式加条目 → 提 PR。
- 草稿（以仓库实际格式为准，若为 README 列表行）：
  `- [dsh-chat-import](https://github.com/Nwflower/dsh-chat-import) — 把 Claude Code JSONL transcript 全保真导入为可 resume 的 DSH 会话（tool/call + tool/result、thinking、多步），自动挂接工作区。`

### 2.2 `0xsline/awesome-deepseek-harness` — 精选列表 ⭐必提

- 地址：https://github.com/0xsline/awesome-deepseek-harness
- 定位：从 hub 和 `dsh-plugin` topic 精选的 awesome list，README 就是目录，是用户找插件的入口。
- 动作：fork → 按现有条目格式在「Plugins」分类下加一行 → 提 PR。
- 草稿：
  `- [dsh-chat-import](https://github.com/Nwflower/dsh-chat-import) — Import Claude Code JSONL transcripts (tool history + thinking + multi-step) as resumable DeepSeek Harness sessions, auto-attached to workspace.`

### 2.3 `AdamPlatin123/awesome-dsh-plugins` — 插件目录（每日兼容性追踪）⭐必提

- 地址：https://github.com/AdamPlatin123/awesome-dsh-plugins
- 定位：带每日兼容性报告的插件目录（`reports/<date>/`），说明它会实际安装/检查每个插件——**对收录质量有要求**。
- 注意：它的检查大概率针对 npm 包安装；`link:` 本地安装的插件可能过不了检查。**建议先完成 npm 发布（见 3.3）再提**，或提 PR 时在描述里写明当前安装方式并询问检查方式。
- 动作：fork → 按 README 表格列结构加行 → 提 PR。草稿（列以目标仓库为准）：
  `| [dsh-chat-import](https://github.com/Nwflower/dsh-chat-import) | Import Claude Code JSONL transcripts as resumable DSH sessions (full fidelity: tools/thinking/multi-step) | v0.1.0 | npm/link | MIT |`

### 2.4 GitHub topic `dsh-plugin` — 无需 PR，设置即收录 ⭐立刻做

- 位置：仓库 Settings → General → Topics（或 GitHub 网页仓库页右侧 "Add topics"）。
- 建议 topics：`dsh-plugin`、`deepseek-harness`、`claude-code`、`import`、`plugin`、`migration`、`jsonl`。
- 效果：进入 https://github.com/topics/dsh-plugin 话题页；`awesome-deepseek-harness` 明说按该 topic 采集，被自动收录概率最高。**这条最便宜、最该先做。**

### 2.5 `hust-open-atom-club/oh-dsh-desktop` — macOS 桌面端 marketplace（可选）

- 地址：https://github.com/hust-open-atom-club/oh-dsh-desktop
- 定位：macOS workbench，带插件 marketplace。用户群小众（仅 macOS 桌面），但零成本可提。

### 2.6 `deepseek-ai/deepseek-harness` 官方仓库（试探，低概率）

- 官方主仓库一般不接受第三方插件链接进 docs。若 hub 收录后仍未带来流量，可试探提一个 doc PR（在社区插件相关文档里加一行），大概率被拒，作为信息获取手段（维护者回复里可能透露正确收录路径）。

### 2.7 PR 通用模板（前 3 个渠道复用）

```text
Title:  chore(list): add Nwflower/dsh-chat-import — Claude Code transcript importer

Body:
## 收录请求

- 仓库: https://github.com/Nwflower/dsh-chat-import
- 一句话: 把 Claude Code JSONL transcript 全保真导入为可 resume 的 DSH 会话
- 功能: user/assistant 文本 + tool/call + tool/result（含 isError、sourceEventSeqs 关联）+ thinking→reasoning + 多步消息；保留 ai-title/cwd/创建时间；按 cwd 自动挂接工作区；幂等（已存在则跳过）
- 依赖面: 仅 host 公开服务 sessionPersistence / fs / tools / workspaceRegistry；不发布服务，无 isolate realm；纯 Host 插件，无 Browser 侧
- 安装: `dsh plugin --profile web add -w link:<path>`（npm 发布后为 `dsh plugin add dsh-chat-import`）
- 许可: MIT（含 LICENSE 文件）
- 已核对: 按本仓库现有条目格式添加；如需调整列/字段请指出
```

---

## 3. 仓库打磨清单（决定「看到了 → 给 star」的转化率）

### 3.1 已完成的打磨

- [x] LICENSE（MIT）
- [x] .gitignore 补 `.prev-session*.jsonl`
- [x] README 修正全保真描述（功能、事件映射、数据模型表、范围边界）

### 3.2 README 首屏增强（下次迭代）

- 加 demo GIF：导入命令 → 刷新会话列表 → 点开续聊，10 秒内讲清价值。
- 加 badges：`npm` version / `license: MIT` / stars / DSH 兼容版本。
- 顶部加一句英文 tagline（配合英文 README 或双语并存），供英文渠道引用。
- 「为什么」段落：Claude Code 用户迁移到 DSH 时历史会话是刚需——直接点出目标人群痛点。

### 3.3 npm 发布（转化率最大杠杆，建议尽快做）

- 移除 `package.json` 的 `"private": true`；确定包名：`dsh-chat-import`（无 scope，需查 npm 是否被占）或 `@<your-scope>/dsh-chat-import`。
- 确认 `exports` 已暴露 `cordis.patch.yml`（当前有 ✅），`files` 含 `index.mjs` / `cordis.patch.yml` / `README.md` / `LICENSE`（需把 LICENSE 加进 `files`）。
- 发布后安装命令变为 `dsh plugin add dsh-chat-import`——这是 2.1/2.3 收录检查能通过的前提，也是普通用户唯一会用的安装方式。

### 3.4 产品力（留下用户 → 口碑传播）

- **多源导入**（v1.2 方向）：OpenAI / Cursor / Codex 的会话格式也是 JSONL，抽象一层「源格式适配器」就能一个插件吃下整个迁移市场——这是把「小众工具」变成「迁移标配」的最大机会。
- 兼容性矩阵：README 里标明实测过的 DSH 版本，随 DSH 迭代更新。
- 错误处理打磨：`skipped` 畸形行现在只计数，可考虑输出到单独文件便于排查。

---

## 4. 内容曝光渠道（把收录带来的流量放大）

### 4.1 中文社区（转化最快，先做）

- **V2X / V2EX**：DSH 本身在 V2EX 有热帖（如 global.v2ex.co/t/1234203），发「我把 Claude Code 的全部历史会话导入了 DeepSeek Harness（含工具调用记录），续聊无缝衔接」——钩子是迁移痛点。
- **掘金 / 知乎 / 少数派**：技术文标题模板：《从 Claude Code 迁移到 DeepSeek Harness？你的历史会话可以原样带过去》。
- 发文时附上：demo GIF、安装命令、链接到 README。

### 4.2 英文渠道（放大，需英文 README 完成后）

- Reddit：r/LocalLLaMA、r/ClaudeAI、r/ClaudeCode（ClaudeCode 用户就是目标人群）。
- X / Twitter：#DeepSeekHarness、#ClaudeCode 话题。
- Hacker News：Show HN 帖（需英文 README + demo）。

### 4.3 官方社区

- DSH 官方 Discord / 社区频道（若存在）分享插件；参与 hub/awesome 仓库的讨论混脸熟，让维护者记住你——收录 PR 更容易过。

---

## 5. 节奏与指标

### 5.1 两周节奏

| 时间 | 动作 |
| --- | --- |
| Day 1 | 设置 GitHub topics（2.4，立即生效） |
| Day 1-3 | npm 发布（3.3）→ 提 PR 2.1/2.2/2.3 |
| Day 3-7 | 补 demo GIF + badges + 英文 tagline（3.2） |
| Day 7-14 | 中文社区发文 2 篇（4.1）；英文渠道 1 篇（4.2） |
| 持续 | 跟进 PR review 意见；维护 issue；规划多源导入（3.4） |

### 5.2 指标

- 收录进度：3 个 PR 是否 merged / 是否进入 topic 页。
- 转化：merged 后 7 天 star 增量；npm 下载量。
- 内容：中文帖的点赞/评论（V2EX 评论区的反馈质量比 star 更早）。
- 目标（参考）：收录 + 曝光双轮转起来后，4 周内 star 从个位数到 50+；多源导入落地后冲 100+。

---

## 6. 我的建议顺序

1. **今天**：GitHub 加 topics（30 秒，免费流量入口）+ 提交本轮仓库改动（README/LICENSE/.gitignore）。
2. **本周**：npm 发布 → 提 3 个收录 PR（hub、两个 awesome list）。
3. **下周**：demo + badges + 英文 README → 中文 2 帖 + 英文 1 帖。
4. **持续**：多源导入是 star 曲线拐点，做完后重发一轮内容。
