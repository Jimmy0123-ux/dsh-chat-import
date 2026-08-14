// lib/convert/reasonix.mjs — Reasonix 会话 JSONL → DSH 会话（纯函数）

import {
  SESSION_FORMAT_VERSION,
  applyBudgetTrim,
  mintSessionId,
  synthesizeSession,
} from './core.mjs'

// Reasonix 会话 JSONL → DSH 会话。
//
// 存储：~/.reasonix/sessions/<stem>.jsonl（desktop-* 桌面会话 / subagent-sub-*
// 子代理会话），每文件一个会话；同目录 <stem>.meta.json 携带 workspace/summary。
// 行结构是消息风格（无 envelope），兼容两代：
//   - user：{ role, content: string } → 开新轮；
//   - assistant：{ role, content: string|null, reasoning_content?, tool_calls?,
//     createdAt? } → 一步。tool_calls 两种形状都接受：
//       v1：{ id, type: "function", function: { name, arguments(JSON 字符串) } }
//       v2：{ id, name, arguments(JSON 字符串) }（扁平）
//   - tool：{ role, tool_call_id, name, content: string } → 挂到最近一步的
//     tool/result，按 tool_call_id 与 assistant 的 tool_calls[].id 配对。
// createdAt 是 unix 毫秒（v2 新增）；缺省回退见 reasonixStemTime。
// Reasonix 会话 id 取文件名 stem（index 层传 args.reasonixId），保证幂等；
// stem 内嵌会话创建时刻（desktop-YYYYMMDDHHMM-N / subagent-sub-N-YYYYMMDDHHMM，
// 本地时间）。转录行与 meta 都没有时间戳时回退到它，避免把导入时刻当会话创建时间。
export function reasonixStemTime(stem) {
  const m = String(stem || '').match(/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/)
  if (!m) return null
  const month = +m[2]
  const day = +m[3]
  const hour = +m[4]
  const minute = +m[5]
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null
  const t = new Date(+m[1], month - 1, day, hour, minute)
  return Number.isNaN(t.getTime()) ? null : t.getTime()
}

export function convertReasonixJsonl(raw, args = {}) {
  const recs = []
  let skipped = 0
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try { recs.push(JSON.parse(t)) } catch (_) { skipped++ }
  }

  const turns = []
  let cur = null
  let lastStep = null
  let firstCreatedAt = null
  // 待配对的工具调用：assistant 声明 tool_calls → 后续 tool 消息按 id 挂结果
  const pendingCalls = new Map()
  for (const rec of recs) {
    if (!rec || typeof rec !== 'object') continue
    if (firstCreatedAt === null && typeof rec.createdAt === 'number' && rec.createdAt > 0) {
      firstCreatedAt = rec.createdAt
    }
    const role = rec.role
    if (role === 'user' && typeof rec.content === 'string') {
      const prompt = rec.content.trim()
      if (prompt) {
        cur = { prompt, steps: [] }
        turns.push(cur)
        lastStep = null
      }
    } else if (role === 'assistant' && cur) {
      const step = { content: [], toolCalls: [], toolResults: [] }
      if (typeof rec.content === 'string' && rec.content.trim()) {
        step.content.push({ type: 'text', text: rec.content.trim() })
      }
      if (typeof rec.reasoning_content === 'string' && rec.reasoning_content.trim()) {
        step.content.push({ type: 'reasoning', text: rec.reasoning_content.trim() })
      }
      if (Array.isArray(rec.tool_calls)) {
        for (const tc of rec.tool_calls) {
          if (!tc || typeof tc !== 'object') continue
          // v1：{ id, type:"function", function:{name, arguments} }；v2：{ id, name, arguments }
          const fn = tc.function && typeof tc.function === 'object' ? tc.function : tc
          if (!fn || typeof fn !== 'object') continue
          const callId = String(tc.id || 'reasonix-' + turns.length + '-' + (cur.steps.length + 1))
          const mapped = {
            id: callId,
            name: fn.name || 'unknown',
            arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
          }
          step.content.push({ type: 'tool-call', ...mapped })
          step.toolCalls.push(mapped)
          pendingCalls.set(callId, step)
        }
      }
      cur.steps.push(step)
      lastStep = step
    } else if (role === 'tool' && cur) {
      const callId = rec.tool_call_id
      const step = pendingCalls.get(callId) || lastStep
      if (step) {
        const text = typeof rec.content === 'string' ? rec.content : JSON.stringify(rec.content ?? '')
        step.toolResults.push({
          toolCallId: callId,
          content: [{ type: 'text', text }],
          isError: false,
        })
      }
    }
  }

  const finalId = args.sessionId || mintSessionId(args.reasonixId)
  const meta = {
    version: SESSION_FORMAT_VERSION,
    id: finalId,
    createdAt: args.createdAt || firstCreatedAt || reasonixStemTime(args.reasonixId) || Date.now(),
  }
  if (args.reasonixId) meta.sourceId = args.reasonixId
  if (args.cwd) meta.cwd = args.cwd
  const { turns: seedTurns, trimmed } = applyBudgetTrim(turns, args.budget)
  const out = synthesizeSession({ meta, turns: seedTurns, title: args.title, provider: 'reasonix', model: 'reasonix', skipped, records: recs.length, imported: { sourcePath: args.sourcePath } })
  return trimmed ? { ...out, trimmed } : out
}
