// index.mjs — dsh-chat-import 插件入口（薄组合层）
//
// 外部聊天记录（Claude Code / Codex-ChatGPT / ChatGPT / Cursor / Gemini / Reasonix /
// Pi Coding Agent / opencode / zcode / grokbuild / openclaw / hermes）→ DSH 会话
// 导入器 + DSH → Claude Code JSONL 反向导出。消费 host 的 sessionPersistence / fs /
// tools / workspaceRegistry 服务（webServer 可选，经 ctx.inject 延迟挂载）。
//
// 原单文件实现已按职责拆到 lib/ 下（各模块都消费 ctx，非纯函数；lib/convert/* 保持
// 零 DSH 依赖纯函数不变）：
//   lib/budget.mjs          REQ-37 上下文预算解析链（参数 > env > 动态模型窗口 > 静态默认）
//   lib/import-core.mjs     共享导入编排：importTranscript（REQ-24 状态机）/ importDirectory /
//                           runDecision（落盘）/ 归组 / 投影预热 / 标准 dry-run 预览
//   lib/import-variants.mjs 特殊形态来源编排：chatgpt / grokbuild / hermes + opencode /
//                           zcode / hermes / grokbuild / chatgpt 的 dry-run 预览
//   lib/toolkit.mjs         makeImportTool 工厂（12 个导入工具共享 schema/render/execute
//                           骨架）+ IMPORT_SPECS（REQ-41 面板导入复用同一编排）
//   lib/export-tool.mjs     export_claude（REQ-16）执行体
//   lib/retract.mjs         REQ-33 导入识别 / 撤回（list_imported_sessions / retract_import）
//   lib/discovery-host.mjs  REQ-25/40 scan_discover 的 host 适配（fs + SQLite 摘要）
//   lib/panel.mjs           REQ-41 面板路由（POST /api-import/sessions + /api-import/import）
//   lib/tools.mjs           17 个工具的注册（12 导入 + export + sync + 识别/撤回 + 发现）
//
// 本文件只做组装：registerTools 注册工具；webServer 是可选且晚挂载的 host 服务，
// 面板路由经 ctx.inject(['webServer']) 延迟注册（headless / 无 Web 的 profile 不挂载
// 路由但照常 apply，12 个导入工具与 CLI 会话不受影响）。

import { resolveRegistryDir } from './lib/imports.mjs'
import { registerTools } from './lib/tools.mjs'
import { registerPanelRoutes } from './lib/panel.mjs'
import { exportClaudeSession } from './lib/export-tool.mjs'
import { readOpencodeDb } from './lib/opencode.mjs'
import { readZcodeDb } from './lib/zcode.mjs'

const name = 'import-claude'
// webServer 不进 inject：它是可选 host 服务（headless / 无 Web 的 profile 不挂载），
// 硬依赖会让整个插件在 headless 下无法激活（REQ-41 曾把它加进 inject，破坏了
// CI headless 冒烟与 CLI 会话的导入工具）。面板路由在 apply 内经 ctx.inject 可选注册。
const inject = ['sessionPersistence', 'fs', 'tools']

function apply(ctx) {
  // REQ-24 imports registry 目录：$DSH_HOME/dsh-chat-import（$DSH_HOME 缺省 ~/.dsh）
  const registryDir = resolveRegistryDir()
  registerTools(ctx, registryDir)
  // REQ-41 面板路由：webServer 是可选 host 服务且晚挂载——web 组合的服务插件在
  // import-claude apply 之后才发布它，apply 时 ctx.get('webServer') 仍为空（实测
  // 重启后 /api-import/* 一律 405）。用 ctx.inject(['webServer'], …) 在服务可用时
  // 再注册路由（dsh 各包处理晚挂载依赖的标准姿势）：headless / CI 冒烟（无
  // webServer）时回调永不执行，12 个导入工具照常可用，apply 不因缺服务失败。
  ctx.inject(['webServer'], (webCtx) => {
    registerPanelRoutes(ctx, webCtx.webServer, registryDir)
  })
}

export { apply, inject, name, readOpencodeDb, readZcodeDb, exportClaudeSession }
