// index.mjs — Claude Code JSONL transcript → DSH 会话导入器
//
// 消费 host 的 sessionPersistence / fs / tools / workspaceRegistry 服务，注册
// `import_claude` 工具：读取 Claude Code 的 .jsonl transcript（单个文件或整个
// 目录），把对话合成 DSH 事件日志（turn/start、step/start、user/message、
// assistant/message、tool/call、tool/result、step/end、turn/end），经
// sessionPersistence.create + append 落盘，再挂接到其 cwd 对应的工作区。

import { defineTool } from '@deepseek-ai/dsh-tools'
import { convertClaudeJsonl } from './convert.mjs'

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
async function importTranscript(ctx, target, args) {
  const raw = await ctx.fs.readText(target)
  const { meta, events, turns, messages, toolCalls, skipped } = convertClaudeJsonl(raw, args)
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

// 批量导入：把目录下每个 .jsonl 都作为独立会话导入。
async function importDirectory(ctx, dirTarget, recursive) {
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
      const { meta, events, turns, messages, toolCalls, skipped: badLines } = convertClaudeJsonl(raw, {})
      if (turns.length === 0 && events.length === 0) {
        // 不是 Claude transcript（没有可导入内容）
        skipped++
        results.push({ path, status: 'skipped', reason: 'not a Claude transcript (no user turns)' })
        continue
      }
      const exists = (await ctx.sessionPersistence.list()).some((h) => h.id === meta.id)
      if (!exists) {
        await ctx.sessionPersistence.create(meta)
        await ctx.sessionPersistence.append(meta.id, events)
        await attachToWorkspace(ctx, meta)
        imported++
      } else {
        alreadyImported++
      }
      results.push({
        path,
        status: exists ? 'already-imported' : 'imported',
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

function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'import_claude',
    description:
      '从 Claude Code 的 JSONL transcript 导入历史对话为可继续的 DSH 会话。' +
      'path 可以是单个 .jsonl 文件，也可以是包含多个 .jsonl 的目录（目录模式递归扫描，每个文件导入为独立会话）。' +
      '解析 user/assistant/tool 消息、合成会话事件并持久化；重复导入同一会话会幂等跳过。' +
      '返回新会话 id（或批量统计）与明细。',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: 'Claude Code transcript (.jsonl) 的文件路径，或包含多个 .jsonl 的目录路径。',
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
          if (value.skipped) bits.push('跳过 ' + value.skipped + ' 个（非 transcript）')
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
        const batch = await importDirectory(ctx, target, args.recursive)
        return { mode: 'batch', ...batch }
      }
      const single = await importTranscript(ctx, target, args)
      return { mode: 'single', ...single }
    },
  }))
}

export { apply, inject, name }
