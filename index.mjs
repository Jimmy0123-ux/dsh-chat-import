// index.mjs — 外部聊天记录（Claude Code / Codex-ChatGPT / ChatGPT / Cursor /
// Gemini / Reasonix / opencode）→ DSH 会话导入器 + DSH → Claude Code JSONL 反向导出
//
// 消费 host 的 sessionPersistence / fs / tools / workspaceRegistry 服务，注册
// `import_claude` 等导入工具：读取各自源格式的 transcript（单个文件或整个目录；
// opencode 直接读 SQLite 库），把对话合成 DSH 事件日志（turn/start、step/start、
// user/message、assistant/message、tool/call、tool/result、step/end、turn/end），
// 经 sessionPersistence.create + append 落盘，再挂接到其 cwd 对应的工作区；
// 并注册 `export_claude`（REQ-16）：把 DSH 会话日志只读序列化为 Claude Code
// JSONL（export.mjs 纯函数），写到 <outputDir>/<slug>/<uuid>.jsonl；
// 注册 `sync_to_claude`（REQ-36）：把 DSH 会话新增轮次增量写回 Claude Code
// JSONL（lib/backfill.mjs 纯逻辑 + ctx 注入），守卫冲突绝不静默覆盖。

import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { convertClaudeJsonl, convertCodexJsonl, convertChatgptJson, convertCursorJsonl, convertGeminiJson, convertReasonixJsonl, convertOpencodeJson } from './convert.mjs'
import { slugifyClaudeCwd, serializeClaudeJsonl } from './export.mjs'
import { syncClaudeSession } from './lib/backfill.mjs'
import { resolveRegistryDir, loadImports, rememberImport, unwrapRecord, listPersistedIds, argsFingerprint, isSessionIdChange, decideSingle, decideMulti } from './lib/imports.mjs'
import { readOpencodeDb, importOpencodeFile, importOpencodeDirectory } from './lib/opencode.mjs'

const name = 'import-claude'
const inject = ['sessionPersistence', 'fs', 'tools']

// ── REQ-37 上下文预算解析（纯 host 面）──────────────────────────────────
// 导入会话无 provider 配置时不会被 dsh 自动压缩（routedTarget 解析失败），超长
// 会话全量落盘后恢复对话直接 400。预算（token 数）解析优先级：
//   工具参数 budget > 环境变量 DSH_IMPORT_CONTEXT_BUDGET >
//   动态（agentDefaultModel.currentSelection + llm.resolveModelInfo 模型窗口）>
//   静态默认 550k。
// agentDefaultModel / llm 在 rc.6 host 服务面存在但可能未挂载：任一步不可用或
// 抛错都回退静态默认，绝不报错。解析结果盖写进 args.budget（转换层消费）与
// args.budgetSource（裁剪上报标注来源），并落进 imports registry。
const DEFAULT_CONTEXT_BUDGET = 550000
const IMPORT_BUDGET_ENV = 'DSH_IMPORT_CONTEXT_BUDGET'

// 预算值归一：缺省/非法（非正数）返回 null。
function parseBudgetValue(v) {
  if (v === undefined || v === null || v === '') return null
  const n = typeof v === 'number' ? v : Number(String(v).trim())
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null
}

// 动态预算：默认模型窗口 − 默认输出上限 − max(25% 窗口, 40k)。
async function dynamicContextBudget(ctx) {
  try {
    const adm = ctx.get('agentDefaultModel')
    const llm = ctx.get('llm')
    if (!adm || typeof adm.currentSelection !== 'function') return null
    if (!llm || typeof llm.resolveModelInfo !== 'function') return null
    const selection = adm.currentSelection()
    if (!selection || typeof selection.provider !== 'string' || typeof selection.model !== 'string') return null
    const info = await llm.resolveModelInfo(selection.provider, selection.model)
    const window = info && info.context && typeof info.context.contextWindow === 'number' ? info.context.contextWindow : null
    if (window === null || window <= 0) return null
    const maxTokens = typeof info.defaultMaxTokens === 'number' && info.defaultMaxTokens > 0 ? info.defaultMaxTokens : 0
    const budget = window - maxTokens - Math.max(Math.floor(window * 0.25), 40000)
    return Number.isFinite(budget) && budget > 0 ? Math.floor(budget) : null
  } catch {
    // 动态解析任一环不可用（服务未挂载 / 模型无窗口元数据）→ 回退静态默认
    return null
  }
}

// 完整解析链，返回 { budget, source }（source ∈ param|env|dynamic|default）。
async function resolveImportBudget(ctx, args) {
  const param = parseBudgetValue(args.budget)
  if (param !== null) return { budget: param, source: 'param' }
  const env = parseBudgetValue(process.env[IMPORT_BUDGET_ENV])
  if (env !== null) return { budget: env, source: 'env' }
  const dynamic = await dynamicContextBudget(ctx)
  if (dynamic !== null) return { budget: dynamic, source: 'dynamic' }
  return { budget: DEFAULT_CONTEXT_BUDGET, source: 'default' }
}

// 把预算来源标注并入转换层裁剪上报（convert.mjs 纯函数只知预算值，不知来源）。
function markTrimmedSource(out, args) {
  if (out && out.trimmed && typeof args.budgetSource === 'string') {
    out.trimmed = { ...out.trimmed, source: args.budgetSource }
  }
  return out
}

// 把导入的会话挂到其 cwd 对应的工作区（否则会显示为"未分组"）。
async function attachToWorkspace(ctx, meta) {
  if (!meta.cwd) return false
  const wr = ctx.get('workspaceRegistry')
  if (!wr || typeof wr.resolveByPath !== 'function') return false
  try {
    let ws = await wr.resolveByPath(meta.cwd)
    if (!ws) ws = await wr.create(meta.cwd)
    await ws.attachSession(meta.id)
    return true
  } catch (err) {
    console.error('workspace attach failed:', String((err && err.message) || err))
    return false
  }
}

// 预热投影缓存：冷读一次持久化会话并回写，让侧边栏无需打开会话即可显示
// 标题/模型等元数据（否则列表先显示 cwd 目录名，点开后才出现真实标题）。
// 失败不影响导入结果，仅记录日志。
async function warmProjection(ctx, sessionId) {
  const projectionCache = ctx.get('sessionProjectionCache')
  if (!projectionCache || typeof projectionCache.coldSnapshot !== 'function') return false
  try {
    await projectionCache.coldSnapshot(sessionId)
    return true
  } catch (err) {
    console.error('projection warm-up failed:', String((err && err.message) || err))
    return false
  }
}

// 执行 decideSingle / decideMulti 返回的决策并落盘；剥离 __ 载荷后返回公开结果。
// create 时才归组（append 续写不重复 attachToWorkspace）；persisted 就地更新供批量
// 内 id 避让；__record（新导入记录）经 rememberImport 写回 registry。
async function runDecision(ctx, decision, registryDir, sourcePath, persisted) {
  if (decision.__action === 'create') {
    const { __meta, __events } = decision
    await ctx.sessionPersistence.create(__meta)
    await ctx.sessionPersistence.append(__meta.id, __events)
    await attachToWorkspace(ctx, __meta)
    await warmProjection(ctx, __meta.id)
    persisted.add(__meta.id)
  } else if (decision.__action === 'append') {
    await ctx.sessionPersistence.append(decision.__targetId, decision.__tailEvents)
  } else if (decision.__action === 'multi') {
    for (const c of decision.__creates) {
      await ctx.sessionPersistence.create(c.meta)
      await ctx.sessionPersistence.append(c.meta.id, c.events)
      await attachToWorkspace(ctx, c.meta)
      await warmProjection(ctx, c.meta.id)
      persisted.add(c.meta.id)
    }
    for (const a of decision.__appends) {
      await ctx.sessionPersistence.append(a.targetId, a.events)
    }
  }
  if (decision.__record) await rememberImport(registryDir, sourcePath, decision.__record)
  const pub = {}
  for (const [k, v] of Object.entries(decision)) {
    if (!k.startsWith('__')) pub[k] = v
  }
  return pub
}

// 解析单个 transcript（REQ-24 状态机入口）：stat → registry 短路径判定 → 读取转换 →
// decideSingle 决策落盘 → 归组。幂等键 = sourcePath（fs 服务归一化路径）。persisted
// 可传入共享快照（批量模式），缺省按需取一次。
async function importTranscript(ctx, target, args, convert, { registryDir, persisted, fingerprintKeys = [] } = {}) {
  const persistedSet = persisted ?? await listPersistedIds(ctx)
  const sourcePath = target.displayPath || ctx.fs.processPath(target)
  const stat = await ctx.fs.stat(target)
  const registry = await loadImports(registryDir)
  let known = unwrapRecord(registry.imports[sourcePath])
  if (known && known.kind !== 'single') known = null
  // 记录指向的会话已不存在（被删 / DSH_HOME 迁移）→ 视作无记录重导
  if (known && (!known.dshId || !persistedSet.has(known.dshId))) known = null
  const fingerprint = argsFingerprint(args, fingerprintKeys)

  // S3 短路径（不 readText）：force / 显式 sessionId 变更需读文件建副本，不在此跳过
  if (known && args.force !== true && !isSessionIdChange(args, known.dshId)) {
    if (typeof known.args === 'string' && fingerprint !== known.args) {
      return { sessionId: known.dshId, turns: known.turns, messages: 0, toolCalls: 0, skipped: 0, alreadyImported: true, status: 'already-imported', argsChanged: true }
    }
    // REQ-37：预算变化（文件未变）→ 跳过并报告（同 argsChanged 语义）；需要按新预算
    // 导入用 force:true。budget 为 index 层解析后的实际预算（registry 记录同一口径）。
    if (typeof known.budget === 'number' && known.budget !== args.budget) {
      return { sessionId: known.dshId, turns: known.turns, messages: 0, toolCalls: 0, skipped: 0, alreadyImported: true, status: 'already-imported', budgetChanged: true }
    }
    if (stat && stat.version === known.version && stat.size === known.sizeBytes) {
      // 未变：短路径跳过（不 readText），重复导入同一会话幂等
      return { sessionId: known.dshId, turns: known.turns, messages: 0, toolCalls: 0, skipped: 0, alreadyImported: true, status: 'already-imported' }
    }
  }

  const raw = await ctx.fs.readText(target)
  const out = markTrimmedSource(convert(raw, { ...args, sourcePath }), args)
  // 无可导入内容（空文件 / 非目标格式 / 辅助 transcript）：计入 skipped，不落盘空会话
  if (!out.meta || (out.turns.length === 0 && out.events.length === 0)) {
    const res = { sessionId: 'none', turns: 0, messages: 0, toolCalls: 0, skipped: 1, alreadyImported: false, status: 'skipped' }
    if (out.skipReason) res.skipReason = out.skipReason
    return res
  }
  const decision = await decideSingle(ctx, { known, converted: out, stat, args, fingerprint, persisted: persistedSet, sourcePath, budget: args.budget })
  return runDecision(ctx, decision, registryDir, sourcePath, persistedSet)
}

// 递归收集目录下的 .jsonl 文件（按名称稳定排序）。
async function collectJsonlFiles(ctx, dirTarget, out, recursive) {
  const entries = await ctx.fs.listDir(dirTarget)
  for (const entry of entries) {
    if (entry.type === 'directory') {
      if (recursive) await collectJsonlFiles(ctx, entry.target, out, recursive)
    } else if (entry.type === 'file' && /\.jsonl$/i.test(entry.name) && !isSidecarJsonl(entry.name)) {
      out.push(entry.target)
    }
  }
}

// 会话主 transcript 的伴生 JSONL（事件日志 / 冲突日志 / 守护文件）不是会话本身，
// 目录批量扫描时排除（Reasonix V2 的 <id>.events.jsonl 是 WAL，非主 transcript）。
function isSidecarJsonl(name) {
  return /\.(events|conflicts|guardian)\.jsonl$/i.test(name)
}

// 递归收集目录下的 .json 文件（ChatGPT 导出，按名称稳定排序）。
async function collectJsonFiles(ctx, dirTarget, out, recursive) {
  const entries = await ctx.fs.listDir(dirTarget)
  for (const entry of entries) {
    if (entry.type === 'directory') {
      if (recursive) await collectJsonFiles(ctx, entry.target, out, recursive)
    } else if (entry.type === 'file' && /\.json$/i.test(entry.name)) {
      out.push(entry.target)
    }
  }
}

// 把单文件结果归一为批量 results 条目（skipReason → reason；可选字段原样带过）。
function batchItem(path, single) {
  const item = {
    path,
    status: single.status,
    sessionId: single.sessionId,
    turns: single.turns,
    messages: single.messages,
    toolCalls: single.toolCalls,
    skipped: single.skipped,
  }
  for (const k of ['skipReason', 'error', 'appendedTurns', 'appendedEvents', 'appendedSkipped', 'sourceShrunk', 'changedInPlace', 'argsChanged', 'budgetChanged', 'backfilled', 'droppedBoundaryResults', 'forceImported', 'trimmed']) {
    if (single[k] !== undefined) item[k === 'skipReason' ? 'reason' : k] = single[k]
  }
  return item
}

// 批量导入：把目录下匹配 pattern 的文件都作为独立会话导入（每个文件走
// importTranscript 状态机，共享 persisted 快照与 registry 目录）。
// deriveArgs(target) 允许按文件派生转换参数（可 async；Cursor 取文件名 composer id，
// Reasonix 读同目录 meta.json 拿 workspace/summary）；collect 默认收集 .jsonl。
async function importDirectory(ctx, dirTarget, args, { convert, sourceLabel, deriveArgs, collect, registryDir, fingerprintKeys = [] }) {
  const files = []
  const collector = collect || collectJsonlFiles
  await collector(ctx, dirTarget, files, args.recursive !== false)
  const results = []
  let imported = 0
  let alreadyImported = 0
  let appended = 0
  let skipped = 0
  let failed = 0
  const persisted = await listPersistedIds(ctx)
  for (const target of files) {
    const path = target.displayPath || ctx.fs.processPath(target)
    try {
      const derived = deriveArgs ? await deriveArgs(target) : {}
      // 展开 args（含 REQ-37 预算 budget/budgetSource），deriveArgs 可覆盖
      const single = await importTranscript(ctx, target, { ...args, ...derived, force: args.force === true }, convert, { registryDir, persisted, fingerprintKeys })
      if (single.status === 'imported') imported++
      else if (single.status === 'appended') appended++
      else if (single.status === 'already-imported') alreadyImported++
      else skipped++
      const item = batchItem(path, single)
      if (item.status === 'skipped' && !item.reason) item.reason = 'not a ' + sourceLabel + ' transcript (no user turns)'
      results.push(item)
    } catch (err) {
      failed++
      results.push({ path, status: 'failed', error: String((err && err.message) || err) })
    }
  }
  return { total: files.length, imported, alreadyImported, appended, skipped, failed, results }
}

// ChatGPT 导出导入：单个 conversations.json 可能含多个会话，每个会话独立落盘
// （REQ-24：逐会话判增 append / 消失 missingFromSource；force=全量新副本）。
async function importChatgptFile(ctx, target, args, { registryDir, persisted } = {}) {
  const persistedSet = persisted ?? await listPersistedIds(ctx)
  const path = target.displayPath || ctx.fs.processPath(target)
  const stat = await ctx.fs.stat(target)
  const registry = await loadImports(registryDir)
  let known = unwrapRecord(registry.imports[path])
  if (known && known.kind !== 'multi') known = null
  const fingerprint = argsFingerprint(args, [])

  // S3 短路径（不 readText）：version/size 未变 → 逐会话跳过。仅当记录里所有会话
  // 仍存在时短路径才成立（会话被删 / DSH_HOME 迁移 → 走全量重导）
  if (known && (!known.conversations || typeof known.conversations !== 'object')) known = null
  if (known && args.force !== true) {
    const subs = Object.values(known.conversations)
    const allPersisted = subs.length > 0 && subs.every((sub) => persistedSet.has(sub.dshId))
    // REQ-37：预算变化 → 跳过并上报 budgetChanged（同 argsChanged 语义）
    if (allPersisted && typeof known.budget === 'number' && known.budget !== args.budget) {
      const results = Object.entries(known.conversations).map(([, sub]) => ({
        path, status: 'already-imported', sessionId: sub.dshId, turns: sub.turns, messages: 0, toolCalls: 0, skipped: 0, budgetChanged: true,
      }))
      return { total: results.length, imported: 0, alreadyImported: results.length, appended: 0, skipped: 0, failed: 0, results }
    }
    if (allPersisted && stat && stat.version === known.version && stat.size === known.sizeBytes) {
      const results = Object.entries(known.conversations).map(([, sub]) => ({
        path, status: 'already-imported', sessionId: sub.dshId, turns: sub.turns, messages: 0, toolCalls: 0, skipped: 0,
      }))
      return { total: results.length, imported: 0, alreadyImported: results.length, appended: 0, skipped: 0, failed: 0, results }
    }
  }

  const raw = await ctx.fs.readText(target)
  const { conversations, skipped: skippedFiles } = convertChatgptJson(raw, { sourcePath: path, budget: args.budget })
  for (const conv of conversations) markTrimmedSource(conv, args)
  const items = conversations.map((conv) => ({ key: conv.meta.sourceId || conv.meta.id, converted: conv }))
  const decision = await decideMulti(ctx, { known, items, stat, args, fingerprint, persisted: persistedSet, sourcePath: path, subTable: 'conversations', budget: args.budget })
  const missing = known ? Object.keys(known.conversations).filter((k) => !items.some((i) => i.key === k)) : []
  const result = await runDecision(ctx, decision, registryDir, path, persistedSet)
  return {
    ...result,
    total: result.results.length + skippedFiles,
    skipped: result.skipped + skippedFiles,
    ...(missing.length ? { missingFromSource: missing } : {}),
  }
}

// ChatGPT 目录导入：扫描 .json 文件，每个文件可含多个会话。
async function importChatgptDirectory(ctx, dirTarget, args, { registryDir, persisted } = {}) {
  const files = []
  await collectJsonFiles(ctx, dirTarget, files, args.recursive !== false)
  const results = []
  let imported = 0
  let alreadyImported = 0
  let appended = 0
  let skipped = 0
  let failed = 0
  const persistedSet = persisted ?? await listPersistedIds(ctx)
  for (const target of files) {
    try {
      const r = await importChatgptFile(ctx, target, args, { registryDir, persisted: persistedSet })
      imported += r.imported
      alreadyImported += r.alreadyImported
      appended += r.appended
      skipped += r.skipped
      failed += r.failed
      results.push(...r.results)
    } catch (err) {
      const path = target.displayPath || ctx.fs.processPath(target)
      failed++
      results.push({ path, status: 'failed', error: String((err && err.message) || err) })
    }
  }
  return { total: results.length, imported, alreadyImported, appended, skipped, failed, results }
}

// 两个导入工具共享的 schema / render / execute 骨架，只差名称、描述、转换器与导入函数。
// registryDir 由 apply 传入（$DSH_HOME/dsh-chat-import）；fingerprintKeys 决定哪些
// 工具参数计入 imports registry 的 args 指纹（opencode 的 fullHistory 等）。
function makeImportTool(ctx, { toolName, sourceLabel, convert, description, importFile, importDir, alwaysBatch, deriveArgs, collect, extraParameters, pathDescription, dropParameters, batchUnit = '文件', skippedNote, registryDir, fingerprintKeys = [] }) {
  const derive = deriveArgs || (async () => ({}))
  const importSingle = importFile || ((c, t, a) => importTranscript(c, t, a, convert, { registryDir, fingerprintKeys }))
  const importBatch = importDir || ((c, d, a) => importDirectory(c, d, a, { convert, sourceLabel, deriveArgs: derive, collect, registryDir, fingerprintKeys }))
  // 增量续写语义（REQ-24）：与各工具 description 里的「幂等跳过」表述互补
  const descriptionSuffix = ' 重复导入已导入的源文件会增量续写新增轮次（源文件未变则跳过）；force:true 以新 id 另存完整副本。'
  return defineTool({
    name: toolName,
    description: description + descriptionSuffix,
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: pathDescription || (alwaysBatch
          ? 'ChatGPT 导出 conversations.json 的文件路径，或包含多个 .json 的目录路径。'
          : sourceLabel + ' transcript (.jsonl) 的文件路径，或包含多个 .jsonl 的目录路径。'),
      },
      force: {
        type: 'boolean',
        description: '可选：true 时即使已导入也以新 id（import-<src>-<n>）另存一份完整副本，旧会话原样保留。',
      },
      budget: {
        type: 'integer',
        description: '可选：上下文预算（token 数），超长会话按三层保护裁剪。优先级：本参数 > 环境变量 DSH_IMPORT_CONTEXT_BUDGET > 动态模型窗口（agentDefaultModel + llm）> 静态默认 550k。',
      },
      ...((dropParameters || []).includes('sessionId') ? {} : {
        sessionId: {
          type: 'string',
          description: '可选：目标 DSH 会话 id（仅单文件导入时生效，默认 import-<源sessionId>；目录模式忽略）。',
        },
      }),
      ...((dropParameters || []).includes('recursive') ? {} : {
        recursive: {
          type: 'boolean',
          description: '可选：目录模式是否递归子目录（默认 true）。',
        },
      }),
      ...extraParameters,
    },
    output: {
      schema: {
        oneOf: [
          // 单文件模式
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              mode: { type: 'string', enum: ['single'], required: true },
              sessionId: { type: 'string', required: true },
              turns: { type: 'integer', required: true },
              messages: { type: 'integer', required: true },
              toolCalls: { type: 'integer', required: true },
              skipped: { type: 'integer' },
              skipReason: { type: 'string' },
              alreadyImported: { type: 'boolean', required: true },
              status: { type: 'string', required: true, enum: ['imported', 'already-imported', 'appended', 'skipped'] },
              appendedTurns: { type: 'integer' },
              appendedEvents: { type: 'integer' },
              appendedSkipped: { type: 'string' },
              sourceShrunk: { type: 'boolean' },
              changedInPlace: { type: 'boolean' },
              argsChanged: { type: 'boolean' },
              budgetChanged: { type: 'boolean' },
              backfilled: { type: 'boolean' },
              droppedBoundaryResults: { type: 'integer' },
              trimmed: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  budget: { type: 'integer', required: true },
                  source: { type: 'string', enum: ['param', 'env', 'dynamic', 'default'], required: true },
                  originalTokens: { type: 'integer', required: true },
                  estimatedTokens: { type: 'integer', required: true },
                  croppedBlocks: { type: 'integer', required: true },
                  droppedTurns: { type: 'integer', required: true },
                  droppedMessages: { type: 'integer', required: true },
                  droppedToolCalls: { type: 'integer', required: true },
                  droppedToolResults: { type: 'integer', required: true },
                  droppedOversized: { type: 'integer', required: true },
                  summaryInserted: { type: 'boolean', required: true },
                },
              },
              forceImported: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  previous: { type: 'string', required: true },
                  current: { type: 'string', required: true },
                },
              },
            },
          },
          // 目录（批量）模式
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              mode: { type: 'string', enum: ['batch'], required: true },
              total: { type: 'integer', required: true },
              imported: { type: 'integer', required: true },
              alreadyImported: { type: 'integer', required: true },
              appended: { type: 'integer', required: true },
              skipped: { type: 'integer', required: true },
              failed: { type: 'integer', required: true },
              missingFromSource: { type: 'array', items: { type: 'string' } },
              results: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    path: { type: 'string', required: true },
                    status: {
                      type: 'string',
                      required: true,
                      enum: ['imported', 'already-imported', 'appended', 'skipped', 'failed'],
                    },
                    sessionId: { type: 'string' },
                    turns: { type: 'integer' },
                    messages: { type: 'integer' },
                    toolCalls: { type: 'integer' },
                    skipped: { type: 'integer' },
                    alreadyImported: { type: 'boolean' },
                    reason: { type: 'string' },
                    error: { type: 'string' },
                    appendedTurns: { type: 'integer' },
                    appendedEvents: { type: 'integer' },
                    appendedSkipped: { type: 'string' },
                    sourceShrunk: { type: 'boolean' },
                    changedInPlace: { type: 'boolean' },
                    argsChanged: { type: 'boolean' },
                    budgetChanged: { type: 'boolean' },
                    backfilled: { type: 'boolean' },
                    droppedBoundaryResults: { type: 'integer' },
                    trimmed: {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        budget: { type: 'integer', required: true },
                        source: { type: 'string', enum: ['param', 'env', 'dynamic', 'default'], required: true },
                        originalTokens: { type: 'integer', required: true },
                        estimatedTokens: { type: 'integer', required: true },
                        croppedBlocks: { type: 'integer', required: true },
                        droppedTurns: { type: 'integer', required: true },
                        droppedMessages: { type: 'integer', required: true },
                        droppedToolCalls: { type: 'integer', required: true },
                        droppedToolResults: { type: 'integer', required: true },
                        droppedOversized: { type: 'integer', required: true },
                        summaryInserted: { type: 'boolean', required: true },
                      },
                    },
                    forceImported: {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        previous: { type: 'string', required: true },
                        current: { type: 'string', required: true },
                      },
                    },
                  },
                },
              },
            },
          },
        ],
      },
      render: (args, value) => {
        // REQ-37 裁剪上报摘要（trimmed 存在时追加一行人类可读说明）
        const trimmedNote = (v) => {
          const t = v && v.trimmed
          if (!t) return ''
          const bits = []
          if (t.droppedTurns > 0) bits.push('裁剪 ' + t.droppedTurns + ' 轮')
          if (t.croppedBlocks > 0) bits.push('裁剪 ' + t.croppedBlocks + ' 条超长内容')
          if (t.droppedOversized > 0) bits.push('丢弃 ' + t.droppedOversized + ' 条超半消息')
          if (t.summaryInserted) bits.push('已插入摘要')
          return bits.length > 0 ? '（' + bits.join('，') + '，估算 ' + t.estimatedTokens + '/' + t.budget + ' tokens，来源 ' + t.source + '）' : ''
        }
        if (value.mode === 'batch') {
          const bits = []
          bits.push('共扫描 ' + value.total + ' 个' + batchUnit)
          if (value.imported) bits.push('新增 ' + value.imported + ' 个会话')
          if (value.appended) bits.push('续写 ' + value.appended + ' 个会话')
          if (value.alreadyImported) bits.push('已存在 ' + value.alreadyImported + ' 个')
          if (value.skipped) bits.push('跳过 ' + value.skipped + ' 个（' + (skippedNote || '非 ' + sourceLabel + ' transcript') + '）')
          if (value.failed) bits.push('失败 ' + value.failed + ' 个')
          const trimmedItems = (value.results || []).filter((r) => r.trimmed).length
          if (trimmedItems) bits.push(trimmedItems + ' 个会话触发预算裁剪')
          // 错误处理打磨：失败/跳过原因要可见，不只计数（最多展示 5 条）
          const problems = (value.results || []).filter((r) => r.status === 'failed' || r.status === 'skipped').slice(0, 5)
          const detail = problems.map((r) => '  - ' + r.path + (r.error ? '：' + r.error : r.reason ? '：' + r.reason : ''))
          return [{
            type: 'text',
            text: '批量导入完成：' + bits.join('，') + (detail.length ? '\n' + detail.join('\n') : ''),
          }]
        }
        if (value.status === 'skipped' && value.sessionId === 'none') {
          return [{
            type: 'text',
            text: '跳过导入：' + (value.skipReason || '非 ' + sourceLabel + ' transcript'),
          }]
        }
        if (value.status === 'appended') {
          return [{
            type: 'text',
            text: '会话 ' + value.sessionId + ' 已续写 ' + value.appendedTurns + ' 轮、' + value.appendedEvents + ' 条事件（源文件新增轮次）。' + trimmedNote(value),
          }]
        }
        if (value.status === 'imported' && value.forceImported) {
          return [{
            type: 'text',
            text: '已强制导入完整副本 → 会话 ' + value.forceImported.current + '（前身 ' + value.forceImported.previous + ' 原样保留）。' + trimmedNote(value),
          }]
        }
        if (value.alreadyImported) {
          const why = value.sourceShrunk
            ? '源文件轮次减少（sourceShrunk），跳过；需要完整副本请用 force:true'
            : value.changedInPlace
              ? '源文件在既有轮次内变化（append-only 无法改写），跳过'
              : value.argsChanged
                ? '导入参数已变化（args-changed），跳过；需要按新参数导入请用 force:true'
                : value.budgetChanged
                  ? '上下文预算已变化（budget-changed），跳过；需要按新预算导入请用 force:true'
                  : value.appendedSkipped
                  ? '源文件已增长但无法确定已存日志长度，跳过增量续写'
                  : value.backfilled
                    ? '已回填导入记录（旧版本导入的会话）'
                    : '源文件未变化'
          return [{
            type: 'text',
            text: '会话 ' + value.sessionId + ' 已存在，跳过导入：' + why + '。',
          }]
        }
        return [{
          type: 'text',
          text: '已导入 ' + value.turns + ' 轮对话（' + value.messages + ' 条消息、' + value.toolCalls + ' 次工具调用）→ 会话 ' + value.sessionId + (value.skipped ? '（跳过 ' + value.skipped + ' 行畸形记录）' : '') + trimmedNote(value),
        }]
      },
    },
    async execute(args) {
      // REQ-37：解析上下文预算（参数 > env > 动态模型窗口 > 静态默认），盖写进
      // args.budget（token 数，转换层裁剪消费、registry 记录）与 args.budgetSource
      // （裁剪上报标注来源）；预算变化经 registry 比对 → budgetChanged 跳过。
      const budgetInfo = await resolveImportBudget(ctx, args)
      const effective = { ...args, budget: budgetInfo.budget, budgetSource: budgetInfo.source }
      const target = await ctx.fs.resolve(effective.path)
      const info = await ctx.fs.stat(target)
      if (info && info.type === 'directory') {
        const batch = await importBatch(ctx, target, effective)
        return { mode: 'batch', ...batch }
      }
      // 单文件：合并按文件派生的转换参数（可 async；Cursor 的 composer id、Reasonix 的 meta）
      const fileArgs = { ...effective, ...(await derive(target)) }
      if (alwaysBatch) {
        // ChatGPT 导出：单文件也含多个会话，恒返回批量形态
        const batch = await importSingle(ctx, target, fileArgs)
        return { mode: 'batch', ...batch }
      }
      const single = await importSingle(ctx, target, fileArgs)
      return { mode: 'single', ...single }
    },
  })
}

// 反向导出（REQ-16）：把 DSH 会话日志只读序列化为 Claude Code JSONL。
// 只消费 sessionPersistence（list + readFrom）+ fs（resolve + writeText），
// 绝不 load/prepare、绝不改写会话日志（append-only 只读来源）。文件写到
// <outputDir>/<slug>/<uuid>.jsonl（新 uuid v4 铸键 + createIfAbsent 不覆盖双保险；
// dryRun 不写盘）。uuid 工厂可注入（测试确定性），默认 randomUUID。
// 导入会话（日志带 session/imported 标记）导出成功后把 mapping 落进 imports
// registry（record.exports = [mapping]），供 REQ-36 sync_to_claude 的 target:'copy'
// 定位写回副本；原生会话无 sourcePath 键，不落库（mapping 仍在返回值里）。
async function exportClaudeSession(ctx, args, { uuid = randomUUID, registryDir } = {}) {
  const sp = ctx.get('sessionPersistence')
  if (!sp || typeof sp.list !== 'function' || typeof sp.readFrom !== 'function') {
    throw new Error('sessionPersistence 不可用（需要 list + readFrom）')
  }
  const headers = await sp.list()
  const header = headers.find((h) => h.id === args.sessionId)
  if (!header) throw new Error('会话不存在: ' + args.sessionId)
  const { meta, events } = await sp.readFrom(args.sessionId, 0)
  const cwd = typeof args.cwd === 'string' && args.cwd ? args.cwd : header.cwd
  if (typeof cwd !== 'string' || !cwd) {
    throw new Error('导出需要 cwd：会话 header 无 cwd 且未提供 cwd 参数')
  }
  const sessionUuid = uuid()
  const slug = slugifyClaudeCwd(cwd)
  const out = serializeClaudeJsonl({ meta, events, sessionUuid, cwd, version: args.version, gitBranch: args.gitBranch }, { uuid })
  const filePath = join(args.outputDir || join(homedir(), '.claude', 'projects'), slug, sessionUuid + '.jsonl')
  if (args.dryRun !== true) {
    const target = await ctx.fs.resolve(filePath)
    await ctx.fs.writeText(target, out.jsonl, { kind: 'createIfAbsent', displayPath: filePath })
  }
  const mapping = {
    sourceSessionId: args.sessionId,
    sessionUuid,
    slug,
    filePath,
    turns: (events ?? []).filter((e) => e && e.type === 'turn/start').length,
    messages: (events ?? []).filter((e) => e && (e.type === 'user/message' || e.type === 'assistant/message' || e.type === 'tool/result')).length,
    toolCalls: out.toolCalls,
    toolResults: out.toolResults,
    droppedToolResults: out.droppedToolResults,
    skippedInjections: out.skippedInjections,
  }
  // 导入会话（带 session/imported 标记）导出成功后把 mapping 落进 registry
  // （exports[0] 即 REQ-36 写回副本映射）；原生会话无 sourcePath 键，跳过
  if (registryDir && args.dryRun !== true) {
    const first = Array.isArray(events) && events.length > 0 ? events[0] : undefined
    if (first && first.type === 'session/imported' && first.data && typeof first.data.sourcePath === 'string') {
      const reg = await loadImports(registryDir)
      const record = unwrapRecord(reg.imports[first.data.sourcePath])
      if (record) await rememberImport(registryDir, first.data.sourcePath, { ...record, exports: [mapping] })
    }
  }
  return {
    mode: 'single',
    sessionId: sessionUuid,
    sourceSessionId: args.sessionId,
    filePath,
    slug,
    cwd,
    recordCount: out.recordCount,
    ...(out.title ? { title: out.title } : {}),
    dryRun: args.dryRun === true,
    mapping,
  }
}

function apply(ctx) {
  // REQ-24 imports registry 目录：$DSH_HOME/dsh-chat-import（$DSH_HOME 缺省 ~/.dsh）
  const registryDir = resolveRegistryDir()
  ctx.tools.register(makeImportTool(ctx, {
    toolName: 'import_claude',
    sourceLabel: 'Claude Code',
    convert: convertClaudeJsonl,
    registryDir,
    // 文件名 stem 传给转换器做「主 transcript」判定：subagent/workflow 辅助 transcript
    // 记录携带父 sessionId，按它建会话会与主 transcript 撞 id 导致主内容被跳过
    deriveArgs: (target) => {
      const p = target.displayPath || ctx.fs.processPath(target)
      const base = String(p).split(/[\\/]/).pop() || ''
      return { fileStem: base.replace(/\.jsonl$/i, '') }
    },
    description:
      '从 Claude Code 的 JSONL transcript 导入历史对话为可继续的 DSH 会话。' +
      'path 可以是单个 .jsonl 文件，也可以是包含多个 .jsonl 的目录（目录模式递归扫描，每个文件导入为独立会话）。' +
      '解析 user/assistant/tool 消息、合成会话事件并持久化；重复导入同一会话会幂等跳过。' +
      '返回新会话 id（或批量统计）与明细。',
  }))
  ctx.tools.register(makeImportTool(ctx, {
    toolName: 'import_codex',
    sourceLabel: 'Codex/ChatGPT',
    convert: convertCodexJsonl,
    registryDir,
    description:
      '从 Codex / ChatGPT CLI 的 rollout JSONL 导入历史对话为可继续的 DSH 会话（' +
      '~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl）。' +
      'path 可以是单个 .jsonl 文件，也可以是包含多个 .jsonl 的目录（目录模式递归扫描，每个文件导入为独立会话）。' +
      '解析 user/assistant/function_call/custom_tool_call 消息、合成会话事件并持久化；重复导入同一会话会幂等跳过。' +
      '返回新会话 id（或批量统计）与明细。',
  }))
  ctx.tools.register(makeImportTool(ctx, {
    toolName: 'import_chatgpt',
    sourceLabel: 'ChatGPT',
    convert: convertChatgptJson,
    importFile: (c, t, a) => importChatgptFile(c, t, a, { registryDir }),
    importDir: (c, d, a) => importChatgptDirectory(c, d, a, { registryDir }),
    alwaysBatch: true,
    registryDir,
    description:
      '从 ChatGPT 网页导出的 conversations.json 导入历史对话为可继续的 DSH 会话。' +
      '导出 ZIP 解压后得到 conversations.json（JSON 数组，一个文件含全部会话）；' +
      'path 可以是该 .json 文件，也可以是包含多个 .json 的目录（目录模式递归扫描）。' +
      '解析 mapping 主线程（占位节点/系统消息跳过）、合成会话事件并持久化；重复导入同一会话会幂等跳过。' +
      '返回批量统计与逐会话明细。',
  }))
  ctx.tools.register(makeImportTool(ctx, {
    toolName: 'import_cursor',
    sourceLabel: 'Cursor',
    convert: convertCursorJsonl,
    registryDir,
    // Cursor 行内无会话 id：用文件名（composer uuid）作稳定 id，保证幂等
    deriveArgs: (target) => {
      const p = target.displayPath || ctx.fs.processPath(target)
      const base = String(p).split(/[\\/]/).pop() || ''
      return { cursorId: base.replace(/\.jsonl$/i, '') }
    },
    description:
      '从 Cursor 的 agent transcript JSONL 导入历史对话为可继续的 DSH 会话（' +
      '~/.cursor/projects/<slug>/agent-transcripts/<composer-id>/<composer-id>.jsonl）。' +
      'path 可以是单个 .jsonl 文件，也可以是包含多个 .jsonl 的目录（目录模式递归扫描，每个文件导入为独立会话）。' +
      '解析 user/assistant 文本与 tool_use 调用（transcript 不含 tool_result，仅导入调用历史）；' +
      '过滤 [REDACTED] 哨兵；重复导入同一会话会幂等跳过。返回新会话 id（或批量统计）与明细。',
  }))
  ctx.tools.register(makeImportTool(ctx, {
    toolName: 'import_gemini',
    sourceLabel: 'Gemini CLI',
    convert: convertGeminiJson,
    collect: collectJsonFiles, // Gemini 是单会话 .json（非 JSONL）
    registryDir,
    description:
      '从 Gemini CLI 的会话 JSON 导入历史对话为可继续的 DSH 会话（' +
      '~/.gemini/history/<slot>/chats/session-*.json）。' +
      'path 可以是单个 .json 文件，也可以是包含多个 .json 的目录（目录模式递归扫描，每个文件导入为独立会话）。' +
      '解析 user/gemini 消息、thoughts→reasoning、内联 toolCalls（结果同对象）并持久化；' +
      'info 系统通知跳过；重复导入同一会话会幂等跳过。返回新会话 id（或批量统计）与明细。',
  }))
  ctx.tools.register(makeImportTool(ctx, {
    toolName: 'import_reasonix',
    sourceLabel: 'Reasonix',
    convert: convertReasonixJsonl,
    registryDir,
    // 会话 id 用文件名 stem（幂等）；cwd/createdAt 从同目录 <stem>.meta.json 派生
    deriveArgs: async (target) => {
      const p = target.displayPath || ctx.fs.processPath(target)
      const base = String(p).split(/[\\/]/).pop() || ''
      const stem = base.replace(/\.jsonl$/i, '')
      const derived = { reasonixId: stem }
      try {
        // meta 与 transcript 同目录：<stem>.meta.json
        const metaPath = String(p).replace(/[\\/][^\\/]*\.jsonl$/i, '') + '\\' + stem + '.meta.json'
        const metaTarget = await ctx.fs.resolve(metaPath)
        const raw = await ctx.fs.readText(metaTarget)
        const meta = JSON.parse(raw)
        if (meta && typeof meta.workspace === 'string' && meta.workspace) derived.cwd = meta.workspace
        if (meta && typeof meta.summary === 'string' && meta.summary.trim()) derived.title = meta.summary.trim()
      } catch {
        // meta 缺失（子代理或旧文件）不致命：仍按 stem 导入，仅无 cwd/标题
      }
      return derived
    },
    description:
      '从 Reasonix 的会话 JSONL 导入历史对话为可继续的 DSH 会话（' +
      '~/.reasonix/sessions/desktop-*.jsonl 与 subagent-sub-*.jsonl）。' +
      'path 可以是单个 .jsonl 文件，也可以是包含多个 .jsonl 的目录（目录模式递归扫描，每个文件导入为独立会话）。' +
      '解析 user/assistant/tool 消息（兼容 v1 嵌套与 v2 扁平 tool_calls）、reasoning_content→reasoning、' +
      'tool_call_id 配对结果；会话 id 取文件名 stem，cwd/标题从同目录 .meta.json 派生；' +
      '重复导入同一会话会幂等跳过。返回新会话 id（或批量统计）与明细。',
  }))
  ctx.tools.register(makeImportTool(ctx, {
    toolName: 'import_opencode',
    sourceLabel: 'opencode',
    convert: convertOpencodeJson,
    // 一库多会话：单 .db 文件也恒返回批量形态；目录模式自动定位 opencode.db（无递归）
    importFile: (c, t, a) => importOpencodeFile(c, t, a, { registryDir, runDecision, markTrimmedSource }),
    importDir: (c, d, a) => importOpencodeDirectory(c, d, a, { registryDir, runDecision, markTrimmedSource }),
    alwaysBatch: true,
    registryDir,
    // opencode 无单会话 id 覆盖、无递归（目录里就是 opencode.db）
    dropParameters: ['sessionId', 'recursive'],
    pathDescription: 'opencode 历史数据库（opencode.db）的文件路径，或包含 opencode.db 的数据目录路径。',
    batchUnit: '会话',
    skippedNote: '无用户回合',
    extraParameters: {
      sessionIds: {
        type: 'array',
        items: { type: 'string' },
        description: '可选：只导入指定源会话 id（缺省导入全部会话）。',
      },
      fullHistory: {
        type: 'boolean',
        description: '可选：true 时导入全量历史（忽略 opencode 的对话压缩）；默认 false（尊重压缩：只导最后一次摘要 + 尾巴）。',
      },
    },
    description:
      '从 opencode 的 SQLite 历史库 opencode.db 导入历史会话为可继续的 DSH 会话（默认位置 ~/.local/share/opencode/opencode.db）。' +
      'path 可以是 .db 文件，也可以是包含 opencode.db 的数据目录（目录模式自动定位，无递归）。' +
      '读取 session/message/part 表重建对话（event 表是部分镜像、session_message/session_input 为空，忽略）；' +
      '文本/reasoning/工具调用（tool/call + tool/result，含错误标记与 sourceEventSeqs 关联）/图片附件/补丁/子任务完整保留；' +
      '默认尊重对话压缩（compaction，只导最后一次摘要+尾巴，摘要作 reasoning 块前置），可选 fullHistory 导全量；' +
      '可选 sessionIds 只导指定源会话；重复导入同一会话会幂等跳过。返回批量统计与逐会话明细。',
  }))
  // REQ-16 反向导出：第 8 个工具，独立注册（导出流程与导入状态机完全不同）。
  ctx.tools.register(defineTool({
    name: 'export_claude',
    description:
      '把 DSH 会话日志（只读，不 load/prepare、不改写历史事件）序列化为 Claude Code JSONL 并写入 ' +
      '<outputDir>/<slug>/<uuid>.jsonl，可被真实 Claude Code --resume 续聊。' +
      '参数：sessionId 必填；cwd 可选（默认取会话 header.cwd，两者皆无则报错）；' +
      'outputDir 可选（默认 ~/.claude/projects）；dryRun 可选（只序列化不写盘）。' +
      'user/assistant/tool_result 按 seq 顺序映射，tool_result 挂在声明其 tool_use 的 assistant 上（' +
      '并行结果扇出同一 assistant）；中断会话末尾补发空 tool_result；孤儿结果丢弃并计数；' +
      '非人类注入跳过计数。返回目标文件路径、记录数与 mapping（sourceSessionId → 新 uuid，imports registry 预留）。',
    parameters: {
      sessionId: {
        type: 'string',
        required: true,
        description: '要导出的 DSH 会话 id（必填）。',
      },
      cwd: {
        type: 'string',
        description: '可选：覆盖导出记录的 cwd（默认取会话 header.cwd；两者皆无则报错）。',
      },
      outputDir: {
        type: 'string',
        description: '可选：Claude Code projects 根目录（默认 ~/.claude/projects），文件写到 <outputDir>/<slug>/<uuid>.jsonl。',
      },
      dryRun: {
        type: 'boolean',
        description: '可选：true 时不写盘，只序列化并返回目标路径与统计。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mode: { type: 'string', enum: ['single'], required: true },
          sessionId: { type: 'string', required: true },
          sourceSessionId: { type: 'string', required: true },
          filePath: { type: 'string', required: true },
          slug: { type: 'string', required: true },
          cwd: { type: 'string', required: true },
          recordCount: { type: 'integer', required: true },
          title: { type: 'string' },
          dryRun: { type: 'boolean', required: true },
          mapping: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              sourceSessionId: { type: 'string', required: true },
              sessionUuid: { type: 'string', required: true },
              slug: { type: 'string', required: true },
              filePath: { type: 'string', required: true },
              turns: { type: 'integer', required: true },
              messages: { type: 'integer', required: true },
              toolCalls: { type: 'integer', required: true },
              toolResults: { type: 'integer', required: true },
              droppedToolResults: { type: 'integer', required: true },
              skippedInjections: { type: 'integer', required: true },
            },
          },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: (value.dryRun ? '导出预览（dryRun，未写盘）：' : '已导出：')
          + '会话 ' + value.sourceSessionId + ' → ' + value.filePath
          + '（' + value.recordCount + ' 条记录、' + value.mapping.toolCalls + ' 次工具调用）',
      }],
    },
    async execute(args) {
      return exportClaudeSession(ctx, args, { registryDir })
    },
  }))
  // REQ-36 反向同步（双向同步桥 B 第一步）：第 9 个工具，把 DSH 会话新增轮次
  // 增量写回 Claude Code JSONL（目标 = 导入源文件或 export_claude 副本）。写回
  // 核心在 lib/backfill.mjs（纯逻辑 + ctx 注入，零 DSH 依赖）；uuid 工厂经
  // syncClaudeSession 的 args.uuid 注入（测试确定性），工具 schema 不暴露它。
  ctx.tools.register(defineTool({
    name: 'sync_to_claude',
    description:
      '反向同步（REQ-36）：把 DSH 会话新增完整轮次增量写回 Claude Code JSONL，' +
      '供真实 Claude Code --resume 续聊。目标 target:"source"（默认）写回导入源文件，' +
      'target:"copy" 写回上次 export_claude 导出的副本（需先导出）。' +
      '守卫不静默覆盖：源文件缩小（sourceShrunk）、被外部修改（source-modified-externally）、' +
      '文件尾 uuid 与写回水印失配（tail-mismatch）、并发写者（write-version-mismatch）一律跳过并上报；' +
      'force:true 跳过三闸并以当前文件重锚定（水印 + 链尾）。' +
      '只写由 turn/end 闭合的完整轮（半开进行中轮次不写，报 incompleteFinalTurn）；' +
      'dryRun 只计算不写盘。返回 status: synced | no-new-turns | skipped 与写回水印。',
    parameters: {
      sessionId: {
        type: 'string',
        required: true,
        description: '要写回的 DSH 会话 id（必须是由本插件导入的会话，带 session/imported 标记）。',
      },
      target: {
        type: 'string',
        description: "可选：写回目标 'source'（默认，导入源文件）| 'copy'（export_claude 导出的副本，需先导出）。",
      },
      force: {
        type: 'boolean',
        description: '可选：true 时跳过三闸守卫并以当前文件重锚定（水印 + 链尾），可能覆盖外部修改；默认 false。',
      },
      dryRun: {
        type: 'boolean',
        description: '可选：true 时完整计算（含格式预检）但不写盘、不更新 registry。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mode: { type: 'string', enum: ['single'], required: true },
          status: { type: 'string', required: true, enum: ['synced', 'no-new-turns', 'skipped'] },
          sessionId: { type: 'string', required: true },
          sourcePath: { type: 'string', required: true },
          target: { type: 'string', required: true, enum: ['source', 'copy'] },
          filePath: { type: 'string', required: true },
          appendedTurns: { type: 'integer' },
          appendedEvents: { type: 'integer' },
          appendedRecords: { type: 'integer' },
          conflictDetected: { type: 'string', enum: ['source-modified-externally', 'tail-mismatch', 'write-version-mismatch'] },
          sourceShrunk: { type: 'boolean' },
          storedShrunk: { type: 'boolean' },
          incompleteFinalTurn: { type: 'boolean' },
          precheckFailed: { type: 'boolean' },
          rollbackError: { type: 'string' },
          reason: { type: 'string' },
          precheck: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true },
              recordCount: { type: 'integer' },
              lastUuid: { type: 'string' },
              errors: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    line: { type: 'integer', required: true },
                    error: { type: 'string', required: true },
                  },
                },
              },
            },
          },
          dryRun: { type: 'boolean', required: true },
          writeback: {
            type: 'object',
            additionalProperties: false,
            properties: {
              sessionUuid: { type: 'string', required: true },
              filePath: { type: 'string', required: true },
              lastWrittenSeq: { type: 'integer', required: true },
              lastWrittenTurn: { type: 'integer' },
              prevUuid: { type: 'string' },
              lastSize: { type: 'integer', required: true },
              lastVersion: { type: 'string', required: true },
              writtenAt: { type: 'integer', required: true },
            },
          },
        },
      },
      render: (args, value) => {
        const where = value.target === 'copy' ? '导出副本' : '源文件'
        if (value.status === 'skipped') {
          let why
          if (value.sourceShrunk) why = '源文件缩小（sourceShrunk），跳过写回'
          else if (value.conflictDetected === 'source-modified-externally') why = '源文件被外部修改（size/version 变化），跳过写回'
          else if (value.conflictDetected === 'tail-mismatch') why = '文件尾 uuid 与写回水印失配（tail-mismatch），跳过写回'
          else if (value.conflictDetected === 'write-version-mismatch') why = '并发写者已改动文件（write-version-mismatch），跳过写回'
          else if (value.storedShrunk) why = 'DSH 会话日志比写回水印短（storedShrunk），跳过写回'
          else if (value.precheckFailed) why = '写回预检失败（格式校验不通过），已回滚'
          else why = value.reason || '跳过写回'
          return [{ type: 'text', text: '会话 ' + value.sessionId + ' ' + why + '（' + where + '）。' }]
        }
        if (value.status === 'no-new-turns') {
          return [{ type: 'text', text: '会话 ' + value.sessionId + ' 无新增完整轮次'
            + (value.incompleteFinalTurn ? '（存在进行中的半开轮次，闭合后再同步）' : '')
            + '（' + where + '）。' }]
        }
        return [{ type: 'text', text: (value.dryRun ? '写回预览（dryRun，未写盘）：' : '已写回：')
          + '会话 ' + value.sessionId + ' → ' + value.filePath
          + '（' + value.appendedTurns + ' 轮、' + value.appendedEvents + ' 条事件、' + value.appendedRecords + ' 条记录'
          + (value.conflictDetected || value.sourceShrunk ? '，force 覆盖守卫：' + (value.conflictDetected || 'sourceShrunk') : '')
          + '）。' }]
      },
    },
    async execute(args) {
      return syncClaudeSession(ctx, args, { registryDir })
    },
  }))
}

export { apply, inject, name, readOpencodeDb, exportClaudeSession }
