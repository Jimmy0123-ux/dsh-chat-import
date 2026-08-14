// export.mjs — DSH 会话事件 → Claude Code JSONL 序列化器（纯函数，零 DSH 依赖）
//
// 与 convert.mjs 相对：convert 把外部 transcript 合成 DSH 事件日志（导入），本模块
// 把 DSH 事件日志（只读来源）反向序列化为 Claude Code JSONL（导出，REQ-16），
// 目标可被真实 Claude Code `--resume` 加载。记录顺序 = DSH seq 顺序；文件布局：
//   line1 mode / line2 permission-mode → 首个 user（parentUuid:null）→（ai-title）→
//   对话记录 → 末尾补发缺失 tool_result；每行一个 `\n`，文件以恰好一个换行结尾。
//
// 降级显式计数（绝不静默）：user/message 且 source.kind≠'user' → skippedInjections；
// 非 text 内容块（图片等）→ skippedBlocks；孤儿 tool/result（查不到 tool/call）→
// droppedToolResults；有 call 无 result（中断的原生会话）→ 文件末尾补发空
// tool_result（content:[]，parentUuid 指向声明该调用的 assistant）。

import { randomUUID, createHash } from 'node:crypto'

// Claude Code projects 目录 slug：非字母数字字符全部替换为 '-'，不合并连续 '-'。
export function slugifyClaudeCwd(cwd) {
  return String(cwd).replace(/[^A-Za-z0-9]/g, '-')
}

// 事件时间 → ISO8601（缺失回退 meta.createdAt，再回退 Date.now()）。
function eventIso(ev, meta, fallbackMs) {
  const ms = typeof ev.time === 'number' ? ev.time
    : meta && typeof meta.createdAt === 'number' ? meta.createdAt
      : fallbackMs !== undefined ? fallbackMs : Date.now()
  return new Date(ms).toISOString()
}

// DSH content 块（或裸字符串）→ Claude Code 文本载荷：单 text 块→字符串、
// 多块→数组、空/无 text→[]；非 text 块跳过并计数。
function textPayload(blocks) {
  if (typeof blocks === 'string') return { value: blocks, skipped: 0 }
  if (!Array.isArray(blocks)) return { value: [], skipped: 0 }
  const texts = []
  let skipped = 0
  for (const b of blocks) {
    if (b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string') texts.push(b.text)
    else skipped++
  }
  return { value: texts.length === 0 ? [] : texts.length === 1 ? texts[0] : texts, skipped }
}

// tool_use input：arguments 是 JSON 字符串；解析失败回退 {}。
function safeParseJson(s) {
  if (typeof s !== 'string') return {}
  try { return JSON.parse(s) } catch { return {} }
}

/**
 * 把 DSH 会话日志序列化为 Claude Code JSONL。
 *
 * @param {{meta?: object, events?: object[], sessionUuid: string, cwd: string,
 *         version?: string, gitBranch?: string, title?: string}} input
 *        events 为按 seq 升序的 SessionEvent[]；title 入参优先，缺省从
 *        session/title 事件取首个；version/gitBranch 可选透传到 user 记录。
 * @param {{uuid?: () => string}} [options] uuid 工厂（测试注入确定性序列，
 *        默认 randomUUID）。
 * @returns {{jsonl: string, recordCount: number, toolCalls: number,
 *          toolResults: number, droppedToolResults: number,
 *          skippedInjections: number, skippedBlocks: number, title?: string}}
 *          空会话（无任何可导出 surface 事件）抛错「无可导出内容」。
 */
export function serializeClaudeJsonl({ meta, events, sessionUuid, cwd, version, gitBranch, title }, { uuid = randomUUID } = {}) {
  const list = Array.isArray(events) ? events : []
  const hasSurface = list.some((ev) => ev && (
    (ev.type === 'user/message' && ev.data && ev.data.source && ev.data.source.kind === 'user') ||
    ev.type === 'assistant/message' ||
    ev.type === 'tool/result'
  ))
  if (!hasSurface) throw new Error('无可导出内容')

  const sessionId = String(sessionUuid)
  let resolvedTitle = typeof title === 'string' && title.trim() ? title.trim() : undefined
  if (!resolvedTitle) {
    for (const ev of list) {
      if (ev && ev.type === 'session/title' && ev.data && typeof ev.data.title === 'string' && ev.data.title.trim()) {
        resolvedTitle = ev.data.title.trim()
        break
      }
    }
  }

  const records = []
  // tool/call → 声明它的 assistant 记录 uuid：并行结果扇出（同一 step 多个 result）
  // 与跨 step 延迟结果都锚定声明方，而不是结果所在 step
  const callIdToAssistant = new Map()
  const declaredCalls = [] // { callId, assistantUuid }
  const resultedCallIds = new Set()
  const assistantUuidByStep = new Map() // 't:<turn>:s:<step>' → assistant uuid
  let droppedToolResults = 0
  let skippedInjections = 0
  let skippedBlocks = 0
  let toolCalls = 0
  let toolResults = 0
  let prevUuid = null
  let firstUserEmitted = false
  let lastTimeMs = null
  let currentTurn = null
  let currentStep = null

  const stepKey = (turn, step) => 't:' + turn + ':s:' + step

  records.push({ type: 'mode', mode: 'normal', sessionId })
  records.push({ type: 'permission-mode', permissionMode: 'default', sessionId })

  for (const ev of list) {
    if (!ev) continue
    if (typeof ev.time === 'number' && (lastTimeMs === null || ev.time >= lastTimeMs)) lastTimeMs = ev.time
    const data = ev.data || {}
    switch (ev.type) {
      case 'turn/start':
        if (typeof data.turn === 'number') currentTurn = data.turn
        break
      case 'step/start':
        if (typeof data.step === 'number') currentStep = data.step
        break
      case 'step/end':
      case 'turn/end':
      case 'session/imported':
        break
      case 'session/title':
        break // 标题在首个 user 记录后统一放置（ai-title）
      case 'user/message': {
        if (!data.source || data.source.kind !== 'user') { skippedInjections++; break }
        const { value: content, skipped } = textPayload(data.content)
        skippedBlocks += skipped
        const record = {
          type: 'user',
          message: { role: 'user', content },
          parentUuid: prevUuid,
          uuid: uuid(),
          timestamp: eventIso(ev, meta),
          ...(data.promptId ? { promptId: data.promptId } : {}),
          permissionMode: 'default',
          origin: { kind: 'human' },
          promptSource: 'typed',
          userType: 'external',
          entrypoint: 'cli',
          cwd,
          sessionId,
          ...(version ? { version } : {}),
          ...(gitBranch ? { gitBranch } : {}),
        }
        records.push(record)
        prevUuid = record.uuid
        if (!firstUserEmitted) {
          firstUserEmitted = true
          if (resolvedTitle) records.push({ type: 'ai-title', aiTitle: resolvedTitle, sessionId })
        }
        break
      }
      case 'assistant/message': {
        const msg = data.message || {}
        const blocks = Array.isArray(msg.content) ? msg.content : []
        const content = []
        let hasToolUse = false
        for (const b of blocks) {
          if (!b || typeof b !== 'object') continue
          if (b.type === 'text' && typeof b.text === 'string') {
            content.push({ type: 'text', text: b.text })
          } else if (b.type === 'reasoning' && typeof b.text === 'string') {
            content.push({ type: 'thinking', thinking: b.text, signature: '' })
          } else if (b.type === 'tool-call' && typeof b.id === 'string') {
            hasToolUse = true
            content.push({ type: 'tool_use', id: b.id, name: typeof b.name === 'string' ? b.name : '', input: safeParseJson(b.arguments) })
          } else {
            skippedBlocks++
          }
        }
        const model = msg.source && typeof msg.source.model === 'string' ? msg.source.model : undefined
        const turn = typeof data.turn === 'number' ? data.turn : currentTurn
        const step = typeof data.step === 'number' ? data.step : currentStep
        const record = {
          type: 'assistant',
          parentUuid: prevUuid,
          uuid: uuid(),
          timestamp: eventIso(ev, meta),
          message: {
            type: 'message',
            id: 'msg_' + createHash('sha1').update(String(msg.id ?? 'seq' + ev.seq)).digest('hex').slice(0, 24),
            role: 'assistant',
            content,
            ...(model ? { model } : {}),
            stop_reason: hasToolUse ? 'tool_use' : 'end_turn',
          },
          sessionId,
        }
        records.push(record)
        prevUuid = record.uuid
        assistantUuidByStep.set(stepKey(turn, step), record.uuid)
        break
      }
      case 'tool/call': {
        const turn = typeof data.turn === 'number' ? data.turn : currentTurn
        const step = typeof data.step === 'number' ? data.step : currentStep
        const assistantUuid = assistantUuidByStep.get(stepKey(turn, step))
        if (assistantUuid !== undefined) {
          callIdToAssistant.set(data.callId, assistantUuid)
          declaredCalls.push({ callId: data.callId, assistantUuid })
        }
        toolCalls++
        break
      }
      case 'tool/result': {
        const blocks = Array.isArray(data.message && data.message.content) ? data.message.content : []
        for (const b of blocks) {
          if (!b || b.type !== 'tool-result') continue
          const assistantUuid = callIdToAssistant.get(b.toolCallId)
          if (assistantUuid === undefined) { droppedToolResults++; continue }
          const { value: content, skipped } = textPayload(b.content)
          skippedBlocks += skipped
          const record = {
            type: 'user',
            message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: b.toolCallId, content, ...(b.isError === true ? { is_error: true } : {}) }] },
            parentUuid: assistantUuid,
            uuid: uuid(),
            timestamp: eventIso(ev, meta),
            ...(data.promptId ? { promptId: data.promptId } : {}),
            sourceToolAssistantUUID: assistantUuid,
            userType: 'external',
            entrypoint: 'cli',
            cwd,
            sessionId,
          }
          records.push(record)
          resultedCallIds.add(b.toolCallId)
          prevUuid = record.uuid
          toolResults++
        }
        break
      }
      default:
        break // todo/write、chunk 事件等一律跳过
    }
  }

  // 有 call 无 result（中断的原生会话）→ 文件末尾补发空 tool_result（content:[]，
  // parentUuid 指向声明 assistant；时间戳取最后一条事件，确定性）
  for (const { callId, assistantUuid } of declaredCalls) {
    if (resultedCallIds.has(callId)) continue
    const record = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: callId, content: [] }] },
      parentUuid: assistantUuid,
      uuid: uuid(),
      timestamp: eventIso({ time: lastTimeMs }, meta),
      sourceToolAssistantUUID: assistantUuid,
      userType: 'external',
      entrypoint: 'cli',
      cwd,
      sessionId,
    }
    records.push(record)
    prevUuid = record.uuid
    toolResults++
  }

  const jsonl = records.map((r) => JSON.stringify(r)).join('\n') + '\n'
  return {
    jsonl,
    recordCount: records.length,
    toolCalls,
    toolResults,
    droppedToolResults,
    skippedInjections,
    skippedBlocks,
    title: firstUserEmitted && resolvedTitle ? resolvedTitle : undefined,
  }
}
