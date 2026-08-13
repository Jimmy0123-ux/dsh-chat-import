// index.mjs — 外部聊天记录（Claude Code / Codex-ChatGPT）→ DSH 会话导入器
//
// 消费 host 的 sessionPersistence / fs / tools / workspaceRegistry 服务，注册
// `import_claude` 与 `import_codex` 两个工具：读取各自源格式的 .jsonl transcript
// （单个文件或整个目录），把对话合成 DSH 事件日志（turn/start、step/start、
// user/message、assistant/message、tool/call、tool/result、step/end、turn/end），
// 经 sessionPersistence.create + append 落盘，再挂接到其 cwd 对应的工作区。

import { defineTool } from '@deepseek-ai/dsh-tools'
import { convertClaudeJsonl, convertCodexJsonl, convertChatgptJson } from './convert.mjs'

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
async function importTranscript(ctx, target, args, convert) {
  const raw = await ctx.fs.readText(target)
  const { meta, events, turns, messages, toolCalls, skipped } = convert(raw, args)
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
    } else if (entry.type === 'file' && /\.jsonl$/i.test(entry.name)) {
      out.push(entry.target)
    }
  }
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

// 批量导入：把目录下每个 .jsonl 都作为独立会话导入。
async function importDirectory(ctx, dirTarget, recursive, convert, sourceLabel) {
  const files = []
  await collectJsonlFiles(ctx, dirTarget, files, recursive !== false)
  const results = []
  let imported = 0
  let alreadyImported = 0
  let skipped = 0
  let failed = 0
  for (const target of files) {
    const path = target.displayPath || ctx.fs.processPath(target)
    try {
      const raw = await ctx.fs.readText(target)
      const { meta, events, turns, messages, toolCalls, skipped: badLines } = convert(raw, {})
      if (turns.length === 0 && events.length === 0) {
        // 不是对应源格式的 transcript（没有可导入内容）
        skipped++
        results.push({ path, status: 'skipped', reason: 'not a ' + sourceLabel + ' transcript (no user turns)' })
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
  const { conversations, skipped: skippedFiles } = convertChatgptJson(raw, {})
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

// 两个导入工具共享的 schema / render / execute 骨架，只差名称、描述、转换器与导入函数。
// importFile/importDir 默认走单会话路径（importTranscript/importDirectory）；
// ChatGPT 导出（一文件多会话）注入自己的实现，且 alwaysBatch（单文件也返回批量形态）。
function makeImportTool(ctx, { toolName, sourceLabel, convert, description, importFile, importDir, alwaysBatch }) {
  const importSingle = importFile || ((c, t, a) => importTranscript(c, t, a, convert))
  const importBatch = importDir || ((c, d, r) => importDirectory(c, d, r, convert, sourceLabel))
  return defineTool({
    name: toolName,
    description,
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: alwaysBatch
          ? 'ChatGPT 导出 conversations.json 的文件路径，或包含多个 .json 的目录路径。'
          : sourceLabel + ' transcript (.jsonl) 的文件路径，或包含多个 .jsonl 的目录路径。',
      },
      sessionId: {
        type: 'string',
        description: '可选：目标 DSH 会话 id（仅单文件导入时生效，默认 import-<源sessionId>；目录模式忽略）。',
      },
      recursive: {
        type: 'boolean',
        description: '可选：目录模式是否递归子目录（默认 true）。',
      },
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
          bits.push('共扫描 ' + value.total + ' 个 .jsonl')
          if (value.imported) bits.push('新增 ' + value.imported + ' 个会话')
          if (value.alreadyImported) bits.push('已存在 ' + value.alreadyImported + ' 个')
          if (value.skipped) bits.push('跳过 ' + value.skipped + ' 个（非 ' + sourceLabel + ' transcript）')
          if (value.failed) bits.push('失败 ' + value.failed + ' 个')
          return [{
            type: 'text',
            text: '批量导入完成：' + bits.join('，') + '。',
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
        const batch = await importBatch(ctx, target, args.recursive)
        return { mode: 'batch', ...batch }
      }
      if (alwaysBatch) {
        // ChatGPT 导出：单文件也含多个会话，恒返回批量形态
        const batch = await importSingle(ctx, target, args)
        return { mode: 'batch', ...batch }
      }
      const single = await importSingle(ctx, target, args)
      return { mode: 'single', ...single }
    },
  })
}

function apply(ctx) {
  ctx.tools.register(makeImportTool(ctx, {
    toolName: 'import_claude',
    sourceLabel: 'Claude Code',
    convert: convertClaudeJsonl,
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
    importFile: (c, t) => importChatgptFile(c, t),
    importDir: (c, d, r) => importChatgptDirectory(c, d, r),
    alwaysBatch: true,
    description:
      '从 ChatGPT 网页导出的 conversations.json 导入历史对话为可继续的 DSH 会话。' +
      '导出 ZIP 解压后得到 conversations.json（JSON 数组，一个文件含全部会话）；' +
      'path 可以是该 .json 文件，也可以是包含多个 .json 的目录（目录模式递归扫描）。' +
      '解析 mapping 主线程（占位节点/系统消息跳过）、合成会话事件并持久化；重复导入同一会话会幂等跳过。' +
      '返回批量统计与逐会话明细。',
  }))
}

export { apply, inject, name }
