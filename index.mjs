// index.mjs — 外部聊天记录（Claude Code / Codex-ChatGPT / ChatGPT / Cursor /
// Gemini / Reasonix / opencode）→ DSH 会话导入器
//
// 消费 host 的 sessionPersistence / fs / tools / workspaceRegistry 服务，注册
// `import_claude` 等导入工具：读取各自源格式的 transcript（单个文件或整个目录；
// opencode 直接读 SQLite 库），把对话合成 DSH 事件日志（turn/start、step/start、
// user/message、assistant/message、tool/call、tool/result、step/end、turn/end），
// 经 sessionPersistence.create + append 落盘，再挂接到其 cwd 对应的工作区。

import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { convertClaudeJsonl, convertCodexJsonl, convertChatgptJson, convertCursorJsonl, convertGeminiJson, convertReasonixJsonl, convertOpencodeJson } from './convert.mjs'

const name = 'import-claude'
const inject = ['sessionPersistence', 'fs', 'tools']

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

// 解析单个 transcript：读取 → 转换 → 幂等落盘 → 归组。返回单文件统计。
// sourcePath 取 fs 服务归一化后的路径（REQ-32 标记事件的数据来源，亦为 REQ-24 幂等键）。
async function importTranscript(ctx, target, args, convert) {
  const raw = await ctx.fs.readText(target)
  const sourcePath = target.displayPath || ctx.fs.processPath(target)
  const out = convert(raw, { ...args, sourcePath })
  // 无可导入内容（空文件 / 非目标格式 / 辅助 transcript）：计入 skipped，不落盘空会话
  if (!out.meta || (out.turns.length === 0 && out.events.length === 0)) {
    const res = { sessionId: 'none', turns: 0, messages: 0, toolCalls: 0, skipped: 1, alreadyImported: false }
    if (out.skipReason) res.skipReason = out.skipReason
    return res
  }
  const { meta, events, turns, messages, toolCalls, skipped } = out
  const exists = (await ctx.sessionPersistence.list()).some((h) => h.id === meta.id)
  if (!exists) {
    await ctx.sessionPersistence.create(meta)
    await ctx.sessionPersistence.append(meta.id, events)
    await attachToWorkspace(ctx, meta)
  }
  return { sessionId: meta.id, turns: turns.length, messages, toolCalls, skipped, alreadyImported: exists }
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

// 幂等落盘单个会话（meta + events）并归组；返回是否新增。
async function persistSession(ctx, meta, events) {
  const exists = (await ctx.sessionPersistence.list()).some((h) => h.id === meta.id)
  if (!exists) {
    await ctx.sessionPersistence.create(meta)
    await ctx.sessionPersistence.append(meta.id, events)
    await attachToWorkspace(ctx, meta)
    return true
  }
  return false
}

// 批量导入：把目录下匹配 pattern 的文件都作为独立会话导入。
// deriveArgs(target) 允许按文件派生转换参数（可 async；Cursor 取文件名 composer id，
// Reasonix 读同目录 meta.json 拿 workspace/summary）；collect 默认收集 .jsonl。
async function importDirectory(ctx, dirTarget, recursive, convert, sourceLabel, deriveArgs, collect) {
  const files = []
  const collector = collect || collectJsonlFiles
  await collector(ctx, dirTarget, files, recursive !== false)
  const results = []
  let imported = 0
  let alreadyImported = 0
  let skipped = 0
  let failed = 0
  for (const target of files) {
    const path = target.displayPath || ctx.fs.processPath(target)
    try {
      const raw = await ctx.fs.readText(target)
      const derived = deriveArgs ? await deriveArgs(target) : {}
      const { meta, events, turns, messages, toolCalls, skipped: badLines, skipReason } = convert(raw, { ...derived, sourcePath: path })
      if (turns.length === 0 && events.length === 0) {
        // 非对应源格式 / 辅助 transcript（无用户回合）：跳过并说明原因，不落盘空会话
        skipped++
        results.push({ path, status: 'skipped', reason: skipReason || ('not a ' + sourceLabel + ' transcript (no user turns)') })
        continue
      }
      const added = await persistSession(ctx, meta, events)
      if (added) imported++
      else alreadyImported++
      results.push({
        path,
        status: added ? 'imported' : 'already-imported',
        sessionId: meta.id,
        turns: turns.length,
        messages,
        toolCalls,
        skipped: badLines,
      })
    } catch (err) {
      failed++
      results.push({ path, status: 'failed', error: String((err && err.message) || err) })
    }
  }
  return { total: files.length, imported, alreadyImported, skipped, failed, results }
}

// ChatGPT 导出导入：单个 conversations.json 可能含多个会话，每个会话独立落盘。
async function importChatgptFile(ctx, target) {
  const path = target.displayPath || ctx.fs.processPath(target)
  const raw = await ctx.fs.readText(target)
  const { conversations, skipped: skippedFiles } = convertChatgptJson(raw, { sourcePath: path })
  const results = []
  let imported = 0
  let alreadyImported = 0
  let skipped = skippedFiles
  let failed = 0
  for (const conv of conversations) {
    try {
      const added = await persistSession(ctx, conv.meta, conv.events)
      if (added) imported++
      else alreadyImported++
      results.push({
        path,
        status: added ? 'imported' : 'already-imported',
        sessionId: conv.meta.id,
        turns: conv.turns.length,
        messages: conv.messages,
        toolCalls: conv.toolCalls,
        skipped: 0,
      })
    } catch (err) {
      failed++
      results.push({ path, status: 'failed', sessionId: conv.meta.id, error: String((err && err.message) || err) })
    }
  }
  return { total: conversations.length + skippedFiles, imported, alreadyImported, skipped, failed, results }
}

// ChatGPT 目录导入：扫描 .json 文件，每个文件可含多个会话。
async function importChatgptDirectory(ctx, dirTarget, recursive) {
  const files = []
  await collectJsonFiles(ctx, dirTarget, files, recursive !== false)
  const results = []
  let imported = 0
  let alreadyImported = 0
  let skipped = 0
  let failed = 0
  for (const target of files) {
    try {
      const r = await importChatgptFile(ctx, target)
      imported += r.imported
      alreadyImported += r.alreadyImported
      skipped += r.skipped
      failed += r.failed
      results.push(...r.results)
    } catch (err) {
      const path = target.displayPath || ctx.fs.processPath(target)
      failed++
      results.push({ path, status: 'failed', error: String((err && err.message) || err) })
    }
  }
  return { total: results.length, imported, alreadyImported, skipped, failed, results }
}

// opencode 历史库（SQLite）→ 中间会话 JSON 数组。
// 只读打开 opencode.db，查 session/message/part 三表（data 是 JSON 文本）；
// message 按 (time_created, id) 升序、part 同。session.model 是 JSON 字符串
// （{id, providerID, variant}），解析取 id 作为会话级模型回退。
// 默认尊重 opencode 的对话压缩（compaction）：只保留最后一次压缩的摘要（summary）
// 与 tail_start_id 之后的尾巴，被压掉的前段历史折叠成摘要；options.fullHistory
// 为 true 时跳过压缩、返回全量。读不到 DB（路径不存在 / 非 SQLite）时抛错，失败大声。
function readOpencodeDb(dbPath, options = {}) {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const sessions = []
    const sessionRows = db.prepare('SELECT id, title, directory, time_created, model FROM session ORDER BY time_created, id').all()
    for (const row of sessionRows) {
      const messages = db.prepare('SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created, id').all(row.id)
      const partsByMessage = new Map()
      for (const p of db.prepare('SELECT message_id, time_created, data FROM part WHERE session_id = ? ORDER BY time_created, id').all(row.id)) {
        if (!partsByMessage.has(p.message_id)) partsByMessage.set(p.message_id, [])
        partsByMessage.get(p.message_id).push(JSON.parse(p.data))
      }
      const msgs = messages.map((m) => {
        const data = JSON.parse(m.data)
        const path = data.path && typeof data.path === 'object' ? data.path : {}
        return {
          id: m.id,
          role: data.role,
          createdAt: m.time_created,
          cwd: typeof path.cwd === 'string' ? path.cwd : undefined,
          model: typeof data.modelID === 'string' ? data.modelID
            : data.model && typeof data.model === 'object' && typeof data.model.modelID === 'string' ? data.model.modelID
              : undefined,
          parts: partsByMessage.get(m.id) || [],
          isSummary: data.mode === 'compaction' || data.summary === true,
        }
      })
      // 尊重 opencode 的对话压缩（compaction）：默认只保留「最后一次压缩摘要 + 尾巴」，
      // 把被压掉的前段历史折叠成摘要，避免 resume 把全量历史灌进上下文；
      // fullHistory 为 true 时跳过压缩、导入全量。
      let summary
      let exportMsgs = msgs
      if (!options.fullHistory) {
        let lastTailStart = null
        let lastSummaryText = null
        for (const m of msgs) {
          for (const p of m.parts) {
            if (p && p.type === 'compaction' && typeof p.tail_start_id === 'string') lastTailStart = p.tail_start_id
          }
          if (m.isSummary) {
            const text = m.parts.filter((p) => p && p.type === 'text').map((p) => p.text).join('\n').trim()
            if (text) lastSummaryText = text
          }
        }
        if (lastTailStart) {
          const tailIdx = msgs.findIndex((m) => m.id === lastTailStart)
          if (tailIdx >= 0) {
            exportMsgs = msgs.slice(tailIdx).filter((m) => !m.isSummary)
            summary = lastSummaryText || undefined
          }
        }
      }
      sessions.push({
        id: row.id,
        title: row.title,
        directory: row.directory,
        createdAt: row.time_created,
        model: parseOpencodeSessionModel(row.model),
        summary,
        messages: exportMsgs.map(({ isSummary, ...rest }) => rest),
      })
    }
    return sessions
  } finally {
    db.close()
  }
}

// 解析 session.model 的 JSON 字符串（{id, providerID, variant}）为模型 id；非法时 undefined。
function parseOpencodeSessionModel(raw) {
  if (typeof raw !== 'string') return undefined
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') {
      if (typeof parsed.id === 'string' && parsed.id) return parsed.id
      if (typeof parsed.modelID === 'string' && parsed.modelID) return parsed.modelID
    }
    return undefined
  } catch {
    // 非 JSON（个别脏数据）→ 无会话级模型，回退链继续走消息级
    return undefined
  }
}

// opencode 单库导入：DB 内每个会话独立落盘（可 sessionIds 过滤），恒返回批量形态。
// sourcePath 为 opencode.db 路径（目录模式定位后同样落到 db 文件）。
async function importOpencodeFile(ctx, target, args = {}) {
  const path = target.displayPath || ctx.fs.processPath(target)
  const sourcePath = path
  const sessions = readOpencodeDb(path, { fullHistory: args.fullHistory === true })
  const wanted = Array.isArray(args.sessionIds) && args.sessionIds.length > 0 ? new Set(args.sessionIds) : null
  const results = []
  let imported = 0
  let alreadyImported = 0
  let skipped = 0
  let failed = 0
  for (const s of sessions) {
    if (wanted && !wanted.has(s.id)) continue
    try {
      const out = convertOpencodeJson(JSON.stringify(s), { ...args, sourcePath })
      if (!out.meta || (out.turns.length === 0 && out.events.length === 0)) {
        skipped++
        results.push({ path, status: 'skipped', reason: 'no user turns (session ' + s.id + ')' })
        continue
      }
      const added = await persistSession(ctx, out.meta, out.events)
      if (added) imported++
      else alreadyImported++
      results.push({
        path,
        status: added ? 'imported' : 'already-imported',
        sessionId: out.meta.id,
        turns: out.turns.length,
        messages: out.messages,
        toolCalls: out.toolCalls,
        skipped: 0,
      })
    } catch (err) {
      failed++
      results.push({ path, status: 'failed', sessionId: 'import-' + s.id, error: String((err && err.message) || err) })
    }
  }
  return { total: sessions.length, imported, alreadyImported, skipped, failed, results }
}

// opencode 目录导入：目录里定位 opencode.db（无递归），再走单库导入；缺 DB 时抛错。
async function importOpencodeDirectory(ctx, dirTarget, args = {}) {
  const dirPath = dirTarget.displayPath || ctx.fs.processPath(dirTarget)
  const dbPath = join(dirPath, 'opencode.db')
  const dbTarget = await ctx.fs.resolve(dbPath)
  return importOpencodeFile(ctx, dbTarget, args)
}

// 两个导入工具共享的 schema / render / execute 骨架，只差名称、描述、转换器与导入函数。
function makeImportTool(ctx, { toolName, sourceLabel, convert, description, importFile, importDir, alwaysBatch, deriveArgs, collect, extraParameters, pathDescription, dropParameters, batchUnit = '文件', skippedNote }) {
  const derive = deriveArgs || (async () => ({}))
  const importSingle = importFile || ((c, t, a) => importTranscript(c, t, a, convert))
  const importBatch = importDir || ((c, d, a) => importDirectory(c, d, a.recursive, convert, sourceLabel, derive, collect))
  return defineTool({
    name: toolName,
    description,
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: pathDescription || (alwaysBatch
          ? 'ChatGPT 导出 conversations.json 的文件路径，或包含多个 .json 的目录路径。'
          : sourceLabel + ' transcript (.jsonl) 的文件路径，或包含多个 .jsonl 的目录路径。'),
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
              skipped: { type: 'integer', required: true },
              failed: { type: 'integer', required: true },
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
                      enum: ['imported', 'already-imported', 'skipped', 'failed'],
                    },
                    sessionId: { type: 'string' },
                    turns: { type: 'integer' },
                    messages: { type: 'integer' },
                    toolCalls: { type: 'integer' },
                    skipped: { type: 'integer' },
                    reason: { type: 'string' },
                    error: { type: 'string' },
                  },
                },
              },
            },
          },
        ],
      },
      render: (args, value) => {
        if (value.mode === 'batch') {
          const bits = []
          bits.push('共扫描 ' + value.total + ' 个' + batchUnit)
          if (value.imported) bits.push('新增 ' + value.imported + ' 个会话')
          if (value.alreadyImported) bits.push('已存在 ' + value.alreadyImported + ' 个')
          if (value.skipped) bits.push('跳过 ' + value.skipped + ' 个（' + (skippedNote || '非 ' + sourceLabel + ' transcript') + '）')
          if (value.failed) bits.push('失败 ' + value.failed + ' 个')
          // 错误处理打磨：失败/跳过原因要可见，不只计数（最多展示 5 条）
          const problems = (value.results || []).filter((r) => r.status === 'failed' || r.status === 'skipped').slice(0, 5)
          const detail = problems.map((r) => '  - ' + r.path + (r.error ? '：' + r.error : r.reason ? '：' + r.reason : ''))
          return [{
            type: 'text',
            text: '批量导入完成：' + bits.join('，') + (detail.length ? '\n' + detail.join('\n') : ''),
          }]
        }
        if (value.skipped && value.sessionId === 'none') {
          return [{
            type: 'text',
            text: '跳过导入：' + (value.skipReason || '非 ' + sourceLabel + ' transcript'),
          }]
        }
        return [{
          type: 'text',
          text: value.alreadyImported
            ? '会话 ' + value.sessionId + ' 已存在，跳过导入（' + value.turns + ' 轮、' + value.toolCalls + ' 次工具调用）。'
            : '已导入 ' + value.turns + ' 轮对话（' + value.messages + ' 条消息、' + value.toolCalls + ' 次工具调用）→ 会话 ' + value.sessionId + (value.skipped ? '（跳过 ' + value.skipped + ' 行畸形记录）' : ''),
        }]
      },
    },
    async execute(args) {
      const target = await ctx.fs.resolve(args.path)
      const info = await ctx.fs.stat(target)
      if (info && info.type === 'directory') {
        const batch = await importBatch(ctx, target, args)
        return { mode: 'batch', ...batch }
      }
      // 单文件：合并按文件派生的转换参数（可 async；Cursor 的 composer id、Reasonix 的 meta）
      const fileArgs = { ...args, ...(await derive(target)) }
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

function apply(ctx) {
  ctx.tools.register(makeImportTool(ctx, {
    toolName: 'import_claude',
    sourceLabel: 'Claude Code',
    convert: convertClaudeJsonl,
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
    importFile: (c, t, a) => importChatgptFile(c, t, a),
    importDir: (c, d, a) => importChatgptDirectory(c, d, a.recursive),
    alwaysBatch: true,
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
    importFile: (c, t, a) => importOpencodeFile(c, t, a),
    importDir: (c, d, a) => importOpencodeDirectory(c, d, a),
    alwaysBatch: true,
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
}

export { apply, inject, name, readOpencodeDb }
