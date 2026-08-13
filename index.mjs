// host.js — Claude Code JSONL transcript → DSH 会话导入器（v1：文本级）
//
// 消费 host 的 sessionPersistence / fs / tools 服务，注册一个 `import_claude`
// 工具：读取 Claude Code 的 .jsonl transcript，把 user/assistant 文本合成 DSH
// 事件日志（turn/start、step/start、user/message、assistant/message、step/end、
// turn/end），再经 sessionPersistence.create + append 落盘为一条可继续的会话。
//
// 当前为文本级导入（工具调用 history 是 v1.1，见 README「已知限制」）。

import { defineTool } from '@deepseek-ai/dsh-tools'

const name = 'import-claude'
const inject = ['sessionPersistence', 'fs', 'tools']

const SESSION_FORMAT_VERSION = 0

function parseTime(iso) {
  if (typeof iso === 'string') {
    const n = Date.parse(iso)
    if (Number.isFinite(n)) return n
  }
  return Date.now()
}

// 把源 sessionId 折成合法的 DSH SessionId 片段。
function mintSessionId(sourceId) {
  const slug = String(sourceId || '')
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, 64)
  return 'import-' + (slug || String(Date.now()))
}

// 从一条 Claude assistant 记录提取可见文本（跳过 thinking / tool_use 块）。
function textOfAssistant(rec) {
  const content = rec?.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('')
      .trim()
  }
  return ''
}

// 逐行解析 JSONL，按「直连人类提问」切轮：type==='user' 且 content 是字符串
// 开新轮；其后所有 assistant 文本并入当前轮，直到下一个直连提问。
function convertClaudeJsonl(raw, args) {
  const recs = []
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try { recs.push(JSON.parse(t)) } catch (_) { /* 跳过畸形行 */ }
  }

  let sourceId = null
  let title = null
  let cwd = null
  let createdAt = null

  const turns = []
  let cur = null
  for (const rec of recs) {
    if (rec && typeof rec.sessionId === 'string' && !sourceId) sourceId = rec.sessionId
    if (rec && typeof rec.cwd === 'string' && !cwd) cwd = rec.cwd
    if (rec && typeof rec.timestamp === 'string' && createdAt === null) createdAt = parseTime(rec.timestamp)
    if (rec && rec.type === 'ai-title' && typeof rec.aiTitle === 'string' && !title) title = rec.aiTitle
    if (rec && rec.type === 'user' && typeof rec.message?.content === 'string') {
      cur = { prompt: rec.message.content, assistantText: '' }
      turns.push(cur)
    } else if (cur && rec && rec.type === 'assistant') {
      const text = textOfAssistant(rec)
      if (text) cur.assistantText += (cur.assistantText ? '\n\n' : '') + text
    }
  }

  const sessionId = args.sessionId || mintSessionId(sourceId)
  const meta = {
    version: SESSION_FORMAT_VERSION,
    id: sessionId,
    createdAt: createdAt ?? Date.now(),
  }
  if (cwd) meta.cwd = cwd

  const events = []
  let seq = 0
  let turn = 0
  const push = (type, data, surface) => {
    const ev = { type, seq: seq++, time: meta.createdAt, data }
    if (surface) ev.surfaceOp = 'append'
    events.push(ev)
  }

  for (const t of turns) {
    turn += 1
    push('turn/start', { turn })
    push('step/start', { turn, step: 1 })
    push('user/message', {
      id: 'import:' + sessionId + ':u' + turn,
      role: 'user',
      content: [{ type: 'text', text: t.prompt }],
      source: { kind: 'user' },
    }, true)
    if (t.assistantText) {
      push('assistant/message', {
        turn,
        step: 1,
        message: {
          id: 'import:' + sessionId + ':a' + turn,
          role: 'assistant',
          content: [{ type: 'text', text: t.assistantText }],
          source: { kind: 'model', provider: 'claude-code', model: 'claude-code' },
        },
      }, true)
    }
    push('step/end', { turn, step: 1 })
    push('turn/end', { turn, reason: { kind: 'completed' } })
  }

  return { meta, events, turns, title, messages: events.filter((e) => e.type === 'user/message' || e.type === 'assistant/message').length }
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

function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'import_claude',
    description:
      '从 Claude Code 的 JSONL transcript 导入一条历史对话为可继续的 DSH 会话。' +
      '读取 .jsonl 文件、解析 user/assistant 文本、合成会话事件并持久化，返回新会话 id 与统计。',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: 'Claude Code transcript (.jsonl) 的绝对路径。',
      },
      sessionId: {
        type: 'string',
        description: '可选：目标 DSH 会话 id（默认 import-<源sessionId>）。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessionId: { type: 'string', required: true },
          turns: { type: 'integer', required: true },
          messages: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: '已导入 ' + value.turns + ' 轮对话（' + value.messages + ' 条消息）→ 会话 ' + value.sessionId,
      }],
    },
    async execute(args) {
      const target = await ctx.fs.resolve(args.path)
      const raw = await ctx.fs.readText(target)
      const { meta, events, turns, messages } = convertClaudeJsonl(raw, args)
      await ctx.sessionPersistence.create(meta)
      await ctx.sessionPersistence.append(meta.id, events)
      await attachToWorkspace(ctx, meta)
      return { sessionId: meta.id, turns, messages }
    },
  }))
}

export { apply, inject, name }
