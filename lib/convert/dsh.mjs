// lib/convert/dsh.mjs — DSH 自身会话日志（session.jsonl / session.jsonl.zstd）
// → DSH 会话事件。DSH 事件日志本就是目标格式：保留对话核心事件并重排 seq，
// 丢弃流式 chunk 与运行时安全/头状态（导入会话由新宿主重新生成这些状态）。
import { mintSessionId } from './core.mjs'

const DURABLE = new Set([
  'turn/start',
  'step/start',
  'user/message',
  'assistant/message',
  'tool/call',
  'tool/result',
  'step/end',
  'turn/end',
  'session/title',
])

function safeText(blocks) {
  for (const b of Array.isArray(blocks) ? blocks : []) {
    if (b && b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
      return b.text.trim().replace(/\s+/g, ' ').slice(0, 80)
    }
  }
  return ''
}

export function convertDshJsonl(raw, args = {}) {
  const lines = String(raw || '').split('\n')
  const parsed = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    try {
      parsed.push({ line: i + 1, value: JSON.parse(line) })
    } catch {
      // DSH 日志尾部的流式行可能是完整 JSON；畸形行忽略并计入 skipped。
      parsed.push({ line: i + 1, value: null })
    }
  }

  const sessionRec = parsed.find((p) => p.value && p.value.type === 'session' && p.value.id)?.value || {}
  const headerRec = parsed.find((p) => p.value && p.value.type === 'request/header' && p.value.data && p.value.data.header)?.value
  const header = headerRec ? headerRec.data.header : null
  const config = header && header.config && typeof header.config === 'object' ? header.config : {}

  const sourceId = String(sessionRec.id || '')
  const fileStem = String(args.sourcePath || '').split(/[\\/]/).pop() || ''
  const idSlug = sourceId || fileStem.replace(/\.jsonl(?:\.zstd)?$/i, '')
  const metaId = mintSessionId(idSlug)

  const createdAt = Number.isFinite(sessionRec.createdAt)
    ? sessionRec.createdAt
    : (parsed.find((p) => p.value && typeof p.value.time === 'number')?.value?.time ?? Date.now())

  const sourceEvents = []
  const oldToNew = new Map()
  let skipped = 0
  for (const p of parsed) {
    const ev = p.value
    if (!ev || typeof ev !== 'object') continue
    if (!DURABLE.has(ev.type)) continue
    if (!Number.isFinite(ev.seq)) continue
    const data = ev.data && typeof ev.data === 'object' ? ev.data : {}
    const next = {
      type: ev.type,
      seq: sourceEvents.length,
      time: Number.isFinite(ev.time) ? ev.time : createdAt,
      data,
    }
    if (typeof ev.surfaceOp === 'string') next.surfaceOp = ev.surfaceOp
    oldToNew.set(ev.seq, next.seq)
    sourceEvents.push(next)
  }

  // sourceEventSeqs 重映射到新 seq（指向日志内部事件）。
  for (const ev of sourceEvents) {
    if (Array.isArray(ev.sourceEventSeqs)) {
      ev.sourceEventSeqs = ev.sourceEventSeqs.map((s) => (oldToNew.has(s) ? oldToNew.get(s) : s))
    }
  }

  const titleEvent = [...sourceEvents].reverse().find((e) => e.type === 'session/title' && e.data && typeof e.data.title === 'string')
  const title = titleEvent ? String(titleEvent.data.title) : (() => {
    const u = sourceEvents.find((e) => e.type === 'user/message' && e.data && Array.isArray(e.data.content))
    return u ? safeText(u.data.content) : ''
  })()

  const model = (() => {
    if (typeof config.model === 'string') return config.model
    const a = [...sourceEvents].reverse().find((e) => e.type === 'assistant/message' && e.data && e.data.message && e.data.message.source && typeof e.data.message.source.model === 'string')
    return a ? a.data.message.source.model : undefined
  })()
  const provider = (() => {
    if (typeof config.provider === 'string') return config.provider
    const a = [...sourceEvents].reverse().find((e) => e.type === 'assistant/message' && e.data && e.data.message && e.data.message.source && typeof e.data.message.source.provider === 'string')
    return a ? a.data.message.source.provider : 'dsh'
  })()

  const turnCount = sourceEvents.filter((e) => e.type === 'turn/start').length
  const turns = new Array(turnCount)
  const messages = sourceEvents.filter((e) => e.type === 'user/message' || e.type === 'assistant/message' || e.type === 'tool/result').length
  const toolCalls = sourceEvents.filter((e) => e.type === 'tool/call').length

  const events = []
  if (sourceEvents.length > 0) {
    events.push({
      type: 'session/imported',
      seq: 0,
      time: createdAt,
      ignorable: true,
      data: {
        tool: 'import_dsh',
        sourceId: sourceId || idSlug,
        sourcePath: args.sourcePath,
        importedAt: Date.now(),
      },
    })
  }
  for (const ev of sourceEvents) {
    events.push({ ...ev, seq: ev.seq + 1 })
  }

  return {
    meta: {
      id: metaId,
      sourceId: sourceId || idSlug,
      cwd: typeof sessionRec.cwd === 'string' ? sessionRec.cwd : undefined,
      createdAt,
      provider,
      model,
    },
    events,
    turns,
    title,
    messages,
    toolCalls,
    skipped,
  }
}
