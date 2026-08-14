// convert.mjs — 外部聊天记录 → DSH 会话事件（纯函数，无宿主依赖）
//
// 与 index.mjs 分离是为了可独立单元测试：本模块不 import 任何 DSH 包。
// 每个源格式一个 `convertXxx(raw, args)`：把原始 transcript 文本解析成统一
// 的回合中间结构，再交给共享的 synthesizeSession 合成 DSH 事件日志，
// 保证所有源（Claude Code / Codex-ChatGPT / ChatGPT / Cursor / Gemini /
// Reasonix / opencode）事件纪律一致。

export const SESSION_FORMAT_VERSION = 0

export function parseTime(iso) {
  if (typeof iso === 'number') {
    // 数字时间戳：Unix 秒（<1e11）或毫秒（>=1e11）
    return Number.isFinite(iso) ? (iso < 1e11 ? iso * 1000 : iso) : Date.now()
  }
  if (typeof iso === 'string') {
    const n = Date.parse(iso)
    if (Number.isFinite(n)) return n
  }
  return Date.now()
}

// 把源 sessionId 折成合法的 DSH SessionId 片段。
export function mintSessionId(sourceId) {
  const slug = String(sourceId || '')
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, 64)
  return 'import-' + (slug || String(Date.now()))
}

// Claude content block → DSH content block。文本→text、思考→reasoning、工具调用→tool-call。
export function mapContentBlock(block) {
  if (!block) return null
  if (block.type === 'text' && typeof block.text === 'string') return { type: 'text', text: block.text }
  if (block.type === 'thinking' && typeof block.thinking === 'string') return { type: 'reasoning', text: block.thinking }
  if (block.type === 'tool_use') {
    return { type: 'tool-call', id: block.id, name: block.name, arguments: JSON.stringify(block.input ?? {}) }
  }
  return null
}

// 把「回合中间结构」合成平衡的 DSH 事件日志（seq 从 0 连续；surface 事件带
// surfaceOp:'append'；tool/result 用 sourceEventSeqs 关联其 tool/call）。
// turns: [{ prompt, steps: [{ content, toolCalls, toolResults }] }]
function synthesizeSession({ meta, turns, title, provider, model, skipped, records }) {
  const events = []
  let seq = 0
  let turn = 0
  const push = (type, data, surface, sourceEventSeqs) => {
    const ev = { type, seq: seq++, time: meta.createdAt, data }
    if (surface) ev.surfaceOp = 'append'
    if (sourceEventSeqs) ev.sourceEventSeqs = sourceEventSeqs
    events.push(ev)
    return ev
  }

  const mname = model || provider

  // 会话级 callId → seq 索引：异步工具的 tool_result 可能晚于其 tool/call 一个或多个
  // step 到达；按 step 重建索引会让跨 step 的结果丢失 sourceEventSeqs 关联
  const callSeqByCallId = {}

  // 会话级「有真实结果」callId 集合：跨 step 的结果也算覆盖（异步工具），兜底只补
  // 全程无结果的调用，避免给后续会到达真实结果的调用补出重复空结果
  const coveredCallIds = new Set()
  for (const t of turns) {
    for (const s of t.steps) {
      for (const tr of s.toolResults) coveredCallIds.add(tr.toolCallId)
    }
  }

  for (const t of turns) {
    turn += 1
    push('turn/start', { turn })
    if (t.steps.length === 0) {
      // 只有提问、没有回复的轮次
      push('user/message', {
        id: 'import:' + meta.id + ':u' + turn,
        role: 'user',
        content: [{ type: 'text', text: t.prompt }],
        source: { kind: 'user' },
      }, true)
    } else {
      for (let i = 0; i < t.steps.length; i++) {
        const stepNum = i + 1
        const step = t.steps[i]
        push('step/start', { turn, step: stepNum })
        if (i === 0) {
          push('user/message', {
            id: 'import:' + meta.id + ':u' + turn,
            role: 'user',
            content: [{ type: 'text', text: t.prompt }],
            source: { kind: 'user' },
          }, true)
        }
        push('assistant/message', {
          turn,
          step: stepNum,
          message: {
            id: 'import:' + meta.id + ':a' + turn + ':' + stepNum,
            role: 'assistant',
            content: step.content,
            // 源记录单条消息模型时（opencode）以 step.model 优先，否则回退会话级 model
            source: { kind: 'model', provider, model: step.model || mname },
          },
        }, true)
        for (const tc of step.toolCalls) {
          const ev = push('tool/call', {
            turn,
            step: stepNum,
            callId: tc.id,
            name: tc.name,
            arguments: tc.arguments,
          })
          callSeqByCallId[tc.id] = ev.seq
        }
        for (const tr of step.toolResults) {
          const callSeq = callSeqByCallId[tr.toolCallId]
          push('tool/result', {
            turn,
            step: stepNum,
            message: {
              id: 'import:' + meta.id + ':t' + turn + ':' + stepNum + ':' + tr.toolCallId,
              role: 'user',
              content: [{
                type: 'tool-result',
                toolCallId: tr.toolCallId,
                content: tr.content,
                ...(tr.isError ? { isError: true } : {}),
              }],
              source: { kind: 'tool', callId: tr.toolCallId },
            },
          }, true, callSeq !== undefined ? [callSeq] : undefined)
        }
        // 兜底配对不变量：每个 tool/call 必须有对应 tool/result，否则 resume 时模型
        // API 拒绝（assistant 带 tool_calls 但缺 tool 消息）。转录未记录结果的调用
        // （Cursor 无 tool_result、Claude/Codex/Reasonix/Gemini 中断）补发空 result；
        // content 用空数组：不虚构文本，wire 适配器会把空内容归一为 "(no output)"
        // （dsh-llm-deepseek / dsh-llm-pi-ai 的 serialize 均 `|| "(no output)"`）。
        for (const tc of step.toolCalls) {
          if (coveredCallIds.has(tc.id)) continue
          const callSeq = callSeqByCallId[tc.id]
          push('tool/result', {
            turn,
            step: stepNum,
            message: {
              id: 'import:' + meta.id + ':t' + turn + ':' + stepNum + ':' + tc.id,
              role: 'user',
              content: [{
                type: 'tool-result',
                toolCallId: tc.id,
                content: [],
              }],
              source: { kind: 'tool', callId: tc.id },
            },
          }, true, callSeq !== undefined ? [callSeq] : undefined)
        }
        push('step/end', { turn, step: stepNum })
      }
    }
    push('turn/end', { turn, reason: { kind: 'completed' } })
  }

  // 标题：ai-title → session/title 事件（钉住，避免自动回退标题覆盖）。
  const normalizedTitle = (title || '').trim()
  if (normalizedTitle.length > 0) {
    push('session/title', { title: normalizedTitle, messageSeqs: [], source: { kind: 'user' } })
  }

  return {
    meta,
    events,
    turns,
    title,
    messages: events.filter((e) => e.type === 'user/message' || e.type === 'assistant/message' || e.type === 'tool/result').length,
    toolCalls: events.filter((e) => e.type === 'tool/call').length,
    skipped,
    records,
  }
}

// 逐行解析 JSONL：直连人类提问（type==='user' 且 content 为字符串）开新轮；每条
// assistant 消息 = 一步；其后的 tool_result 挂到最近一步。
export function convertClaudeJsonl(raw, args = {}) {
  const recs = []
  let skipped = 0
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try { recs.push(JSON.parse(t)) } catch (_) { skipped++ }
  }

  let sourceId = null
  let title = null
  let cwd = null
  let createdAt = null
  let model = null

  const turns = []
  let cur = null
  let lastStep = null

  for (const rec of recs) {
    if (rec && typeof rec.sessionId === 'string' && !sourceId) sourceId = rec.sessionId
    if (rec && typeof rec.cwd === 'string' && !cwd) cwd = rec.cwd
    if (rec && typeof rec.timestamp === 'string' && createdAt === null) createdAt = parseTime(rec.timestamp)
    if (rec && rec.type === 'ai-title' && typeof rec.aiTitle === 'string' && !title) title = rec.aiTitle
    const recModel = rec ? (rec.message?.model ?? rec.model) : undefined
    if (typeof recModel === 'string' && !model) model = recModel

    if (rec && rec.type === 'user' && rec.message && typeof rec.message.content === 'string') {
      // 直连人类提问 → 新轮
      cur = { prompt: rec.message.content, steps: [] }
      turns.push(cur)
      lastStep = null
    } else if (rec && rec.type === 'assistant' && cur) {
      // 一条 assistant 消息 = 一步
      const step = { content: [], toolCalls: [], toolResults: [] }
      if (Array.isArray(rec.message?.content)) {
        for (const block of rec.message.content) {
          const mapped = mapContentBlock(block)
          if (!mapped) continue
          if (mapped.type === 'tool-call') {
            step.content.push(mapped)   // 助手内容里的 tool-call block
            step.toolCalls.push(mapped) // 同时作为 tool/call 事件
          } else {
            step.content.push(mapped)   // text / reasoning block
          }
        }
      } else if (typeof rec.message?.content === 'string') {
        step.content.push({ type: 'text', text: rec.message.content })
      }
      cur.steps.push(step)
      lastStep = step
    } else if (rec && rec.type === 'user' && Array.isArray(rec.message?.content) && cur && lastStep) {
      // 工具结果：挂在最近一步
      for (const block of rec.message.content) {
        if (block && block.type === 'tool_result') {
          const inner = (Array.isArray(block.content) ? block.content : [])
            .map(mapContentBlock)
            .filter(Boolean)
          lastStep.toolResults.push({
            toolCallId: block.tool_use_id,
            content: inner,
            isError: block.is_error === true,
          })
        }
      }
    }
  }

  // 只有主 transcript（文件名 = <sessionId>.jsonl）是独立会话。Claude Code 项目目录里
  // `<sessionId>/subagents/**` 的辅助 transcript（agent-*.jsonl 等）记录携带父 sessionId，
  // 若按它建会话会与主 transcript 撞 id：先扫描到的文件占会话、主内容被幂等跳过而丢失。
  // 文件名与记录 sessionId 不一致的一律跳过并给原因（单文件/目录模式一致）。
  const fileStem = typeof args.fileStem === 'string' ? args.fileStem : null
  if (fileStem && sourceId && fileStem !== sourceId) {
    return {
      meta: null, events: [], turns: [], title: null, messages: 0, toolCalls: 0,
      skipped: 0, records: recs.length,
      skipReason: 'auxiliary transcript (file "' + fileStem + '" does not match sessionId "' + sourceId + '"); only the main <sessionId>.jsonl becomes a session',
    }
  }

  const sessionId = args.sessionId || mintSessionId(sourceId)
  const meta = { version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: createdAt ?? Date.now() }
  if (cwd) meta.cwd = cwd

  return synthesizeSession({ meta, turns, title, provider: 'claude-code', model, skipped, records: recs.length })
}

// Codex / ChatGPT CLI rollout JSONL → 统一的回合中间结构。
//
// 行 envelope：{ timestamp, type, payload }。只消费 response_item（模型产物）与
// session_meta / turn_context（元数据）；event_msg 的 user_message / agent_message
// 是 response_item 的重复（schema 笔记明确警告会重复计数），一律忽略。
// 用户消息里以 `<` 开头的块（<environment_context>、<user_instructions>、
// <system-reminder> 等）是 harness 注入，不是人类输入，跳过。
export function convertCodexJsonl(raw, args = {}) {
  const recs = []
  let skipped = 0
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try { recs.push(JSON.parse(t)) } catch (_) { skipped++ }
  }

  let sourceId = null
  let cwd = null
  let createdAt = null
  let model = null
  let title = null

  // callId → 它所属的 step（跨行配对 function_call_output）
  const callSteps = new Map()

  const turns = []
  let cur = null
  let lastStep = null

  // 新开一个「用户提问」回合。
  const openTurn = (prompt) => {
    cur = { prompt, steps: [] }
    turns.push(cur)
    lastStep = null
  }

  // 追加一步 assistant 产物（文本 / 工具调用）；没有当前回合时忽略。
  const openStep = () => {
    const step = { content: [], toolCalls: [], toolResults: [] }
    cur.steps.push(step)
    lastStep = step
    return step
  }

  for (const rec of recs) {
    const env = rec && rec.type
    const payload = rec && rec.payload
    if (env === 'session_meta' && payload) {
      if (!sourceId && typeof payload.id === 'string') sourceId = payload.id
      if (!cwd && typeof payload.cwd === 'string') cwd = payload.cwd
      if (createdAt === null) createdAt = parseTime(payload.timestamp ?? rec.timestamp)
      continue
    }
    if (env === 'turn_context' && payload) {
      if (!model && typeof payload.model === 'string') model = payload.model
      continue
    }
    if (env !== 'response_item' || !payload) continue

    if (payload.type === 'message') {
      if (payload.role === 'user' && Array.isArray(payload.content)) {
        // 过滤 harness 注入，剩余文本合并为用户提问
        const parts = []
        for (const block of payload.content) {
          if (block && block.type === 'input_text' && typeof block.text === 'string') {
            if (!block.text.startsWith('<')) parts.push(block.text)
          }
        }
        const prompt = parts.join('\n').trim()
        if (prompt) openTurn(prompt)
      } else if (payload.role === 'assistant' && cur) {
        const step = openStep()
        for (const block of payload.content) {
          if (block && block.type === 'output_text' && typeof block.text === 'string') {
            step.content.push({ type: 'text', text: block.text })
          }
        }
      }
      // developer（系统注入）忽略
    } else if ((payload.type === 'function_call' || payload.type === 'custom_tool_call') && cur) {
      // 挂到最近的 assistant 步骤（一步 = assistant 消息 + 其工具调用）；没有则新开一步
      const step = lastStep || openStep()
      const callId = payload.call_id
      let argumentsText
      if (payload.type === 'function_call') {
        argumentsText = typeof payload.arguments === 'string' ? payload.arguments : JSON.stringify(payload.arguments ?? {})
      } else {
        // custom_tool_call（如 apply_patch）：arguments 是自由格式 input
        argumentsText = JSON.stringify(payload.input ?? {})
      }
      const mapped = {
        id: callId,
        name: payload.name || 'unknown',
        arguments: argumentsText,
      }
      step.toolCalls.push(mapped)
      if (callId) callSteps.set(callId, step)
    } else if ((payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') && cur) {
      const callId = payload.call_id
      const step = callSteps.get(callId) || lastStep || openStep()
      // output 可能是纯字符串，也可能是 {"output": "...", "metadata": {...}} JSON 字符串
      let text
      const out = payload.output
      if (typeof out === 'string') {
        let parsed = null
        try { parsed = JSON.parse(out) } catch (_) { /* 纯文本 */ }
        text = parsed && typeof parsed === 'object' && typeof parsed.output === 'string'
          ? parsed.output
          : out
      } else if (out && typeof out === 'object' && typeof out.output === 'string') {
        text = out.output
      } else {
        text = typeof out === 'string' ? out : JSON.stringify(out ?? '')
      }
      step.toolResults.push({
        toolCallId: callId,
        content: [{ type: 'text', text }],
        isError: false,
      })
    }
    // reasoning（内容加密，通常不可读）与其余事件忽略
  }

  const sessionId = args.sessionId || mintSessionId(sourceId)
  const meta = { version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: createdAt ?? Date.now() }
  if (cwd) meta.cwd = cwd

  return synthesizeSession({ meta, turns, title, provider: 'codex', model, skipped, records: recs.length })
}

// ChatGPT 网页导出 conversations.json → 每个会话一个 DSH 会话。
//
// 与 Claude/Codex 不同：顶层是 JSON 数组（一文件多会话），每个会话对象含
// `mapping`（DAG：nodeId → { id, message, parent, children }）。沿 active
// branch（children 最后一个）从 root 遍历得到主线程；`message: null` 的
// 占位节点与 `author.role === 'system'` 跳过；时间戳是 Unix 秒。
// 无 cwd 字段（ChatGPT 是聊天，无工作目录）→ 不归组工作区。
export function convertChatgptJson(raw, args = {}) {
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    // 整个文件不是合法 JSON：跳过，不产生会话
    return { conversations: [], skipped: 1, records: 0 }
  }
  if (!Array.isArray(parsed)) {
    return { conversations: [], skipped: 1, records: 0 }
  }

  const conversations = []
  let skipped = 0
  for (const conv of parsed) {
    if (!conv || typeof conv !== 'object') { skipped++; continue }
    const out = convertChatgptConversation(conv, args)
    if (out) conversations.push(out)
    else skipped++
  }
  return { conversations, skipped, records: parsed.length }
}

function convertChatgptConversation(conv, args) {
  const mapping = conv.mapping || {}
  const nodes = Object.values(mapping).filter((n) => n && typeof n === 'object')

  // 找 root：parent 不存在于 mapping 且带 message；遍历沿最后一个 child
  let root = null
  for (const n of nodes) {
    if (n.message && !(n.parent && mapping[n.parent])) { root = n; break }
  }
  if (!root) return null

  const thread = []
  const seen = new Set()
  let node = root
  while (node && !seen.has(node.id)) {
    seen.add(node.id)
    thread.push(node)
    const kids = (node.children || []).map((id) => mapping[id]).filter((n) => n && n.message)
    node = kids.length > 0 ? kids[kids.length - 1] : null
  }

  let title = null
  if (typeof conv.title === 'string' && conv.title.trim()) title = conv.title.trim()
  const createdAt = parseTime(conv.create_time)

  const turns = []
  let cur = null
  let lastStep = null
  for (const n of thread) {
    const msg = n.message
    const role = msg && msg.author ? msg.author.role : null
    if (role === 'user') {
      const text = chatgptMessageText(msg)
      if (text) {
        cur = { prompt: text, steps: [] }
        turns.push(cur)
        lastStep = null
      }
    } else if (role === 'assistant' && cur) {
      const step = { content: [], toolCalls: [], toolResults: [] }
      const text = chatgptMessageText(msg)
      if (text) step.content.push({ type: 'text', text })
      cur.steps.push(step)
      lastStep = step
    } else if (role === 'tool' && cur && lastStep) {
      // 工具消息降级为最近一步的文本块：ChatGPT 网页导出无结构化 tool-call
      // （assistant 节点从不产生 tool-call block），挂 tool/result 只会产生
      // 没有对应 tool/call 的孤儿结果，resume 时被模型 API 拒绝。与 README
      // 契约一致：工具消息按文本挂最近一步。
      const text = chatgptMessageText(msg)
      if (text) lastStep.content.push({ type: 'text', text })
    }
    // system 与占位节点跳过
  }

  const sessionId = args.sessionId || mintSessionId(conv.id)
  const meta = { version: SESSION_FORMAT_VERSION, id: sessionId, createdAt }
  // 无用户回合（如只有 system 注入的会话）不产生空会话
  if (turns.length === 0) return null
  return synthesizeSession({ meta, turns, title, provider: 'chatgpt', model: 'chatgpt', skipped: 0, records: thread.length })
}

// 提取 ChatGPT 消息正文：content.parts 数组（字符串或 {text} 对象）。
function chatgptMessageText(msg) {
  if (!msg || !msg.content || typeof msg.content !== 'object') return ''
  const parts = Array.isArray(msg.content.parts) ? msg.content.parts : []
  const texts = []
  for (const p of parts) {
    if (typeof p === 'string') texts.push(p)
    else if (p && typeof p === 'object' && typeof p.text === 'string') texts.push(p.text)
  }
  return texts.join('\n').trim()
}

// Cursor agent transcript JSONL → DSH 会话。
//
// 存储：~/.cursor/projects/<slug>/agent-transcripts/<composer-uuid>/<composer-uuid>.jsonl。
// 行结构：{ role: 'user'|'assistant', message: { content: [...] } }，无 envelope。
// content 只有 text / tool_use 两种块（input 已是解析后的对象，非 JSON 字符串）。
// 与 Claude 的差异：
//   - 用户首条消息包在 <user_query>…</user_query> 里（剥离标签）；
//   - transcript 不含 tool_result（工具结果只在 bubble store 里）→ 只发 tool/call；
//   - assistant 文本常有 "[REDACTED]" 哨兵（客户端隐私剥离）→ 过滤；
//   - 无时间戳 / model / cwd（composer id 即会话 id）。
export function convertCursorJsonl(raw, args = {}) {
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
  for (const rec of recs) {
    if (!rec || (rec.role !== 'user' && rec.role !== 'assistant')) continue
    const content = Array.isArray(rec.message?.content) ? rec.message.content : []
    if (rec.role === 'user') {
      // 提取文本块（剥离 <user_query> 包裹），合成用户提问 → 新轮
      const texts = []
      for (const block of content) {
        if (block && block.type === 'text' && typeof block.text === 'string') {
          const t = block.text.replace(/<\/?user_query>/g, '').trim()
          if (t) texts.push(t)
        }
      }
      const prompt = texts.join('\n').trim()
      if (prompt) {
        cur = { prompt, steps: [] }
        turns.push(cur)
        lastStep = null
      }
    } else if (rec.role === 'assistant' && cur) {
      const step = { content: [], toolCalls: [], toolResults: [] }
      for (const block of content) {
        if (!block) continue
        if (block.type === 'text' && typeof block.text === 'string') {
          const t = cursorText(block.text)
          if (t) step.content.push({ type: 'text', text: t })
        } else if (block.type === 'tool_use') {
          const mapped = {
            id: block.id || 'cursor-' + turns.length + '-' + (cur.steps.length + 1),
            name: block.name || 'unknown',
            arguments: JSON.stringify(block.input ?? {}),
          }
          step.content.push({ type: 'tool-call', ...mapped })
          step.toolCalls.push(mapped)
        }
      }
      if (step.content.length > 0 || step.toolCalls.length > 0) {
        cur.steps.push(step)
        lastStep = step
      }
    }
  }

  // Cursor 无时间戳 / 会话内 id：会话 id 由 index 层从文件名（composer uuid）传入 args.cursorId，
  // 保证幂等；未传入时退化为时间戳（单文件手工导入仍可用）。
  const finalId = args.sessionId || mintSessionId(args.cursorId)
  const meta = { version: SESSION_FORMAT_VERSION, id: finalId, createdAt: Date.now() }
  return synthesizeSession({ meta, turns, title: undefined, provider: 'cursor', model: 'cursor', skipped, records: recs.length })
}

// 过滤 Cursor 的 "[REDACTED]" 哨兵文本；整段被剥离后返回空串。
function cursorText(text) {
  const cleaned = text.replace(/\[REDACTED\]/g, '').trim()
  return cleaned
}

// Gemini CLI 会话 JSON → DSH 会话。
//
// 存储：~/.gemini/history/<slot>/chats/session-*.json（一文件一 JSON 对象，非 JSONL）。
// 顶层：{ sessionId, projectHash, startTime, directories, kind, messages: [...] }。
// messages 项：{ type: "user" | "gemini" | "info", content, model, toolCalls, thoughts }。
//   - user：content 是 parts 数组 [{text}] → 开新轮；
//   - gemini：content 是字符串，可带 toolCalls 与 thoughts（reasoning 摘要）；
//   - info：CLI 系统通知（错误横幅、取消等）→ 跳过；
//   - toolCalls：{ id, name, args, status, result: [{ functionResponse: { response: { output } } }] }
//     结果**内联**在同一对象上（与 Claude 拆分消息不同）→ tool/call + tool/result 一起发。
export function convertGeminiJson(raw, args = {}) {
  let chat
  try {
    chat = JSON.parse(raw)
  } catch {
    return { meta: null, events: [], turns: [], title: undefined, messages: 0, toolCalls: 0, skipped: 1, records: 0 }
  }
  if (!chat || typeof chat !== 'object' || !Array.isArray(chat.messages)) {
    return { meta: null, events: [], turns: [], title: undefined, messages: 0, toolCalls: 0, skipped: 1, records: 0 }
  }

  let model = null
  const turns = []
  let cur = null
  let lastStep = null
  for (const msg of chat.messages) {
    if (!msg || typeof msg !== 'object') continue
    if (msg.type === 'user') {
      // parts 数组 → 用户提问（开新轮）
      const texts = []
      if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part && typeof part === 'object' && typeof part.text === 'string' && part.text.trim()) {
            texts.push(part.text.trim())
          }
        }
      }
      const prompt = texts.join('\n')
      if (prompt) {
        cur = { prompt, steps: [] }
        turns.push(cur)
        lastStep = null
      }
    } else if (msg.type === 'gemini' && cur) {
      const step = { content: [], toolCalls: [], toolResults: [] }
      if (!model && typeof msg.model === 'string') model = msg.model
      // 文本正文（string 或空串）
      if (typeof msg.content === 'string' && msg.content.trim()) {
        step.content.push({ type: 'text', text: msg.content.trim() })
      }
      // thoughts → reasoning 摘要块
      if (Array.isArray(msg.thoughts)) {
        for (const t of msg.thoughts) {
          if (t && typeof t === 'object' && (t.description || t.subject)) {
            step.content.push({
              type: 'reasoning',
              text: [t.subject, t.description].filter(Boolean).join('：'),
            })
          }
        }
      }
      // toolCalls：结果内联
      if (Array.isArray(msg.toolCalls)) {
        for (const tc of msg.toolCalls) {
          if (!tc || typeof tc !== 'object') continue
          const callId = String(tc.id || 'gemini-' + turns.length + '-' + (cur.steps.length + 1))
          const mapped = {
            id: callId,
            name: tc.name || 'unknown',
            arguments: JSON.stringify(tc.args ?? {}),
          }
          step.content.push({ type: 'tool-call', ...mapped })
          step.toolCalls.push(mapped)
          // 内联结果：result[].functionResponse.response.output
          const text = geminiToolResultText(tc)
          if (text !== null) {
            step.toolResults.push({
              toolCallId: callId,
              content: [{ type: 'text', text }],
              isError: tc.status === 'error',
            })
          }
        }
      }
      cur.steps.push(step)
      lastStep = step
    }
    // info 与未知类型跳过
  }

  const sessionId = args.sessionId || mintSessionId(chat.sessionId)
  const meta = { version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: parseTime(chat.startTime) }
  if (Array.isArray(chat.directories) && chat.directories[0]) meta.cwd = chat.directories[0]
  return synthesizeSession({ meta, turns, title: undefined, provider: 'gemini', model, skipped: 0, records: chat.messages.length })
}

// 提取 Gemini 内联工具结果文本；无结果返回 null。
function geminiToolResultText(tc) {
  if (Array.isArray(tc.result)) {
    for (const entry of tc.result) {
      if (!entry || typeof entry !== 'object') continue
      const fr = entry.functionResponse
      const out = fr && fr.response ? fr.response.output : undefined
      if (typeof out === 'string') return out
    }
  }
  if (typeof tc.resultDisplay === 'string') return tc.resultDisplay
  return null
}

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
  if (args.cwd) meta.cwd = args.cwd
  return synthesizeSession({ meta, turns, title: args.title, provider: 'reasonix', model: 'reasonix', skipped, records: recs.length })
}
// opencode 历史库会话（index 层从 SQLite 抽取的中间 JSON）→ DSH 会话。
//
// 存储：opencode.db（SQLite，WAL）。index.mjs 负责把每个会话的 session/message/part
// 三表抽成下述中间 JSON 再调用本函数，因此本函数保持纯函数（零 DSH 依赖，可单测）：
// {
//   id, title, directory, createdAt, model, summary?,
//   messages: [
//     { id, role: 'user'|'assistant', createdAt, cwd?, model?, parts: [ part.data 原样 ] }
//   ]
// }
// part.type 映射：text→text、reasoning→reasoning、tool→tool/call + tool/result
// （state.input 序列化为 arguments，state.output 为结果文本，status==='error' 标
// isError；output 缺失也发空文本结果，保证 call/result 配对）、file→[image: <name>]、
// patch→[patch: <N> files]、subtask→[subtask: <command> — <description>]；
// step-start / step-finish / compaction 是结构性块，跳过。
// 模型回退链（assistant source.model）：消息级 modelID → 消息级 model.modelID →
// 会话级 model（对象取 id/modelID，字符串原样）→ undefined。
export function convertOpencodeJson(raw, args = {}) {
  let chat
  try {
    chat = JSON.parse(raw)
  } catch {
    return { meta: null, events: [], turns: [], title: undefined, messages: 0, toolCalls: 0, skipped: 1, records: 0 }
  }
  if (!chat || typeof chat !== 'object' || !Array.isArray(chat.messages)) {
    return { meta: null, events: [], turns: [], title: undefined, messages: 0, toolCalls: 0, skipped: 1, records: 0 }
  }

  const turns = []
  let cur = null
  for (const msg of chat.messages) {
    if (!msg || typeof msg !== 'object') continue
    if (msg.role === 'user') {
      // text part 合并为用户提问 → 新轮；无文本（如只有附件）不开轮
      const texts = []
      if (Array.isArray(msg.parts)) {
        for (const p of msg.parts) {
          if (p && p.type === 'text' && typeof p.text === 'string' && p.text.trim()) texts.push(p.text.trim())
        }
      }
      const prompt = texts.join('\n')
      if (prompt) {
        cur = { prompt, steps: [] }
        turns.push(cur)
      }
    } else if (msg.role === 'assistant' && cur) {
      const step = { content: [], toolCalls: [], toolResults: [] }
      if (Array.isArray(msg.parts)) {
        for (const p of msg.parts) {
          if (!p || typeof p !== 'object') continue
          if (p.type === 'text' && typeof p.text === 'string') {
            step.content.push({ type: 'text', text: p.text })
          } else if (p.type === 'reasoning' && typeof p.text === 'string') {
            step.content.push({ type: 'reasoning', text: p.text })
          } else if (p.type === 'tool') {
            const callId = String(p.callID || 'opencode-' + turns.length + '-' + (cur.steps.length + 1))
            const state = p.state && typeof p.state === 'object' ? p.state : {}
            const mapped = {
              id: callId,
              name: p.tool || 'unknown',
              arguments: JSON.stringify(state.input ?? {}),
            }
            step.content.push({ type: 'tool-call', ...mapped })
            step.toolCalls.push(mapped)
            step.toolResults.push({
              toolCallId: callId,
              content: [{ type: 'text', text: typeof state.output === 'string' ? state.output : '' }],
              isError: state.status === 'error',
            })
          } else if (p.type === 'file') {
            step.content.push({ type: 'text', text: '[image: ' + (p.filename || 'unknown') + ']' })
          } else if (p.type === 'patch') {
            step.content.push({ type: 'text', text: '[patch: ' + (Array.isArray(p.files) ? p.files.length : 0) + ' files]' })
          } else if (p.type === 'subtask') {
            step.content.push({ type: 'text', text: '[subtask: ' + (p.command || '') + ' — ' + (p.description || '') + ']' })
          }
          // step-start / step-finish / compaction 与未知类型是结构性块，跳过
        }
      }
      const stepModel = opencodeMessageModel(msg)
      if (stepModel) step.model = stepModel
      cur.steps.push(step)
    }
  }

  // 压缩摘要（opencode compaction）：作为 reasoning 块前置到首个 assistant 步骤，
  // 让 resume 时模型可见被压掉的历史概要，但不把前段全量历史灌入上下文。
  if (typeof chat.summary === 'string' && chat.summary.trim()) {
    for (const t of turns) {
      if (t.steps.length > 0) {
        t.steps[0].content.unshift({ type: 'reasoning', text: chat.summary.trim() })
        break
      }
    }
  }

  const sessionId = args.sessionId || mintSessionId(chat.id)
  const meta = { version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: parseTime(chat.createdAt) }
  if (typeof chat.directory === 'string' && chat.directory) meta.cwd = chat.directory
  const title = typeof chat.title === 'string' ? chat.title.trim() : undefined
  return synthesizeSession({
    meta,
    turns,
    title,
    provider: 'opencode',
    model: opencodeSessionModel(chat),
    skipped: 0,
    records: chat.messages.length,
  })
}

// 消息级模型：平铺 modelID 优先，其次 model.modelID / model 字符串。
function opencodeMessageModel(msg) {
  if (typeof msg.modelID === 'string' && msg.modelID) return msg.modelID
  const m = msg.model
  if (m && typeof m === 'object' && typeof m.modelID === 'string' && m.modelID) return m.modelID
  if (typeof m === 'string' && m) return m
  return undefined
}

// 会话级模型：对象取 id → modelID；字符串原样。
function opencodeSessionModel(chat) {
  const s = chat.model
  if (s && typeof s === 'object') {
    if (typeof s.id === 'string' && s.id) return s.id
    if (typeof s.modelID === 'string' && s.modelID) return s.modelID
  }
  if (typeof s === 'string' && s) return s
  return undefined
}
