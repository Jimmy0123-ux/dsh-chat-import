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
// imported: 可选 { sourcePath }——index 层从工具入参 path 归一化后传入（REQ-32）。
function synthesizeSession({ meta, turns, title, provider, model, skipped, records, imported }) {
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

  // 内部标记（REQ-32）：本会话由哪个工具从哪个源文件导入。seq 0 钉在日志开头
  //（首个 turn/start 之前）；ignorable: true 让读侧全链路放行（KNOWN_SESSION_EVENT_TYPES
  // || ignorable），不依赖 SessionHeader——jsonl 后端会静默丢弃 header 附加字段。
  // 仅 turns > 0 时写：无可导入内容不落空会话、不加标记。sourceId 用源会话 id
  //（各源显式写入 meta.sourceId，不从 import- 前缀反解），sourcePath 由 index 层传入。
  if (turns.length > 0) {
    events.push({
      type: 'session/imported',
      seq: seq++,
      time: meta.createdAt,
      ignorable: true,
      data: {
        tool: provider,
        sourceId: meta.sourceId ?? meta.id,
        sourcePath: imported?.sourcePath,
        importedAt: Date.now(),
      },
    })
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

// 从一次完整转换中截取「第 fromTurn 轮及之后」的事件尾部，seq 从 fromSeq 重新编号
// （供 REQ-24 增量续写：重导把源文件新增轮次 append 进同一 DSH 会话）。
//
// 轮次边界由 turn/start 事件的 data.turn 决定（不是每个事件都带 data.turn）。
// 末尾的 session/title 事件（无 turn）默认剥离（dropSessionEvents=true）——标题只在
// 全量导入时写一次，续写轮次不重复钉标题。工具结果事件的 sourceEventSeqs 重映射到
// 尾部新 seq；指向尾部之外的引用（跨轮异步工具：调用在已导入前段、结果在新增尾部）
// 原样保留——前段 seq 未变，旧值仍指向真实调用——并计入 droppedBoundaryResults。
// 事件除 seq 外原样保留（surfaceOp:'append' 等随事件走，续写不重写、不附加标题）。
export function tailSessionEvents(converted, { fromTurn, fromSeq, dropSessionEvents = true }) {
  const keep = []
  const oldToNew = new Map()
  let currentTurn = null
  let droppedBoundaryResults = 0
  for (const ev of converted.events ?? []) {
    if (ev && ev.type === 'turn/start' && ev.data && typeof ev.data.turn === 'number') {
      currentTurn = ev.data.turn
    }
    if (ev && ev.type === 'session/title') {
      if (dropSessionEvents) continue
      oldToNew.set(ev.seq, fromSeq + keep.length)
      keep.push(ev)
      continue
    }
    if (currentTurn !== null && currentTurn >= fromTurn) {
      if (Array.isArray(ev.sourceEventSeqs)) {
        for (const s of ev.sourceEventSeqs) {
          // 引用不在已处理的尾内事件里 → 指向尾外（前段 seq 未变，原样保留合法）
          if (!oldToNew.has(s)) droppedBoundaryResults++
        }
      }
      oldToNew.set(ev.seq, fromSeq + keep.length)
      keep.push(ev)
    }
  }
  return {
    firstTurn: fromTurn,
    droppedBoundaryResults,
    events: keep.map((ev, i) => {
      const next = { ...ev, seq: fromSeq + i }
      if (Array.isArray(ev.sourceEventSeqs)) {
        next.sourceEventSeqs = ev.sourceEventSeqs.map((s) => (oldToNew.has(s) ? oldToNew.get(s) : s))
      }
      return next
    }),
  }
}

// ── REQ-37 超长会话三层保护（纯函数，零 DSH 依赖）─────────────────────────
// 导入会话在无 provider 配置时不会被 dsh 自动压缩（routedTarget 解析失败），超长
// 会话全量落盘后恢复对话直接 400。保护分三层，预算（token 数）由 index 层解析
// （工具参数 > 环境变量 DSH_IMPORT_CONTEXT_BUDGET > 动态模型窗口 > 静态默认 550k）
// 后经 args.budget 传入：
//   L1 单条内容裁剪——单条文本 ≤16K 字符、工具结果 ≤40K 字符（保留头 75% + 尾）；
//   L2 消息预算截断——保留开头锚点（最早 3 条 user 文本）+ 压缩摘要 + 尾部消息；
//   L3 单条兜底——裁剪后单条消息仍超预算一半 → 直接丢弃（宁缺毋滥）。

// 文本 → token 估算（折算系数约 2.0）：CJK 1 token/字、ASCII 1 token/4 字符。
// CJK 覆盖主平面/扩展 A/B/兼容、CJK 标点与全角形式；其余字符按 ASCII 折算。
export function estimateTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0
  let cjk = 0
  let ascii = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0)
    if ((cp >= 0x3400 && cp <= 0x4dbf)
      || (cp >= 0x4e00 && cp <= 0x9fff)
      || (cp >= 0xf900 && cp <= 0xfaff)
      || (cp >= 0x3000 && cp <= 0x303f)
      || (cp >= 0xff00 && cp <= 0xffef)
      || (cp >= 0x20000 && cp <= 0x2a6df)) {
      cjk++
    } else {
      ascii++
    }
  }
  return cjk + Math.ceil(ascii / 4)
}

// 第一层裁剪上限：单条文本 / 单条工具结果的最大字符数。
export const TEXT_BLOCK_CHAR_LIMIT = 16000
export const TOOL_RESULT_CHAR_LIMIT = 40000
const CROP_MARKER = '\n…（已裁剪）…\n'

// 单条文本裁剪：超限时保留头 75% + 尾 25%（合计 ≤ 上限），中间以裁剪标记衔接。
function cropText(text, limit) {
  if (text.length <= limit) return { text, cropped: false }
  const room = Math.max(1, limit - CROP_MARKER.length)
  const head = Math.floor(room * 0.75)
  const tail = room - head
  return { text: text.slice(0, head) + CROP_MARKER + text.slice(-tail), cropped: true }
}

// 裁剪一组 content block：text/reasoning 按 textLimit、tool-result 内部块按
// toolResultLimit（工具结果通常单块，近似单条结果上限）。返回 { blocks, cropped }。
export function cropContentBlocks(blocks, { textLimit = TEXT_BLOCK_CHAR_LIMIT, toolResultLimit = TOOL_RESULT_CHAR_LIMIT } = {}) {
  if (!Array.isArray(blocks)) return { blocks: [], cropped: 0 }
  let cropped = 0
  const out = blocks.map((b) => {
    if (!b || typeof b !== 'object') return b
    if ((b.type === 'text' || b.type === 'reasoning') && typeof b.text === 'string') {
      const r = cropText(b.text, textLimit)
      if (!r.cropped) return b
      cropped++
      return { ...b, text: r.text }
    }
    if (b.type === 'tool-result' && Array.isArray(b.content)) {
      const inner = cropContentBlocks(b.content, { textLimit: toolResultLimit, toolResultLimit })
      if (inner.cropped === 0) return b
      cropped += inner.cropped
      return { ...b, content: inner.blocks }
    }
    return b
  })
  return { blocks: out, cropped }
}

// content block 数组 → token 估算（text/reasoning 按正文、tool-call 按 arguments、
// tool-result 递归内部块；与投影到模型的消息内容口径一致）。
function estimateBlocks(blocks) {
  let total = 0
  for (const b of blocks || []) {
    if (!b || typeof b !== 'object') continue
    if (b.type === 'text' || b.type === 'reasoning') total += estimateTokens(b.text)
    else if (b.type === 'tool-call') total += estimateTokens(b.arguments)
    else if (b.type === 'tool-result' && Array.isArray(b.content)) total += estimateBlocks(b.content)
  }
  return total
}

// turns IR → token 估算：prompt + 每步 content + 工具结果 content。
function estimateTurns(turns) {
  let total = 0
  for (const t of turns || []) {
    total += estimateTokens(t.prompt)
    for (const s of t.steps || []) {
      total += estimateBlocks(s.content)
      for (const tr of s.toolResults || []) total += estimateBlocks(tr.content)
    }
  }
  return total
}

// 三层保护总入口。返回 { turns, trimmed }：turns 为裁剪后的新结构（输入不改动），
// trimmed 为裁剪上报计数（budget / 前后估算 / L1 裁剪块数 / L2 丢弃轮与消息 /
// L3 超半丢弃 / 摘要标记）。预算内会话只走 L1（单条超限内容裁剪），不截断。
export function trimTurns(turns, budget, { anchorUserTexts = 3, summaryAllowance = 512 } = {}) {
  const src = turns || []
  const originalTokens = estimateTurns(src)
  const trimmed = {
    budget,
    originalTokens,
    estimatedTokens: 0,
    croppedBlocks: 0,
    droppedTurns: 0,
    droppedMessages: 0,
    droppedToolCalls: 0,
    droppedToolResults: 0,
    droppedOversized: 0,
    summaryInserted: false,
  }
  if (src.length === 0) {
    trimmed.estimatedTokens = 0
    return { turns: [], trimmed }
  }

  // L1：克隆 + 单条内容裁剪（text/reasoning ≤16K 字符、工具结果 ≤40K 字符）
  let croppedBlocks = 0
  const l1 = src.map((t) => ({
    prompt: t.prompt,
    steps: (t.steps || []).map((s) => {
      const cc = cropContentBlocks(s.content)
      let stepCropped = cc.cropped
      let toolResults = s.toolResults || []
      if (toolResults.length > 0) {
        toolResults = toolResults.map((tr) => {
          const inner = cropContentBlocks(tr.content, { textLimit: TOOL_RESULT_CHAR_LIMIT, toolResultLimit: TOOL_RESULT_CHAR_LIMIT })
          stepCropped += inner.cropped
          if (inner.cropped === 0) return tr
          return { ...tr, content: inner.blocks }
        })
      }
      croppedBlocks += stepCropped
      return { ...s, content: cc.blocks, toolResults }
    }),
  }))
  trimmed.croppedBlocks = croppedBlocks

  const l1Estimate = estimateTurns(l1)
  if (l1Estimate <= budget) {
    trimmed.estimatedTokens = l1Estimate
    return { turns: l1, trimmed }
  }

  // L2：消息预算截断——保留开头锚点（最早 3 条 user 文本）+ 压缩摘要 + 尾部消息。
  // 尾部从末尾往回贪心，在「锚点 + 摘要预留」的剩余预算内尽量多留；锚点本身超
  // 预算（病态小预算）时从尾部收缩锚点，保证至少留 1 轮可续聊。
  const anchorCount = Math.min(anchorUserTexts, l1.length)
  let anchor = l1.slice(0, anchorCount)
  const rest = l1.slice(anchorCount)
  let anchorTokens = estimateTurns(anchor)
  while (anchor.length > 1 && anchorTokens + summaryAllowance > budget) {
    anchor = anchor.slice(0, -1)
    anchorTokens = estimateTurns(anchor)
  }
  const tail = []
  let tailTokens = 0
  for (let i = rest.length - 1; i >= 0; i--) {
    const add = estimateTurns([rest[i]])
    if (anchorTokens + summaryAllowance + tailTokens + add > budget) break
    tail.unshift(rest[i])
    tailTokens += add
  }
  const middle = rest.slice(0, rest.length - tail.length)

  for (const t of middle) {
    trimmed.droppedTurns++
    let resultCount = 0
    for (const s of t.steps) {
      trimmed.droppedToolCalls += s.toolCalls.length
      trimmed.droppedToolResults += s.toolResults.length
      resultCount += s.toolResults.length
    }
    trimmed.droppedMessages += 1 + t.steps.length + resultCount
  }

  // 压缩摘要：作为 reasoning 块前置到首个保留尾部轮的 assistant 步骤（opencode
  // compaction 同款模式），不新增空 user 轮次；尾部为空时挂到锚点末轮。
  const kept = [...anchor, ...tail]
  if (trimmed.droppedTurns > 0 && kept.length > 0) {
    const attach = tail.length > 0 ? tail[0] : anchor[anchor.length - 1]
    const summaryText = '…[导入预算裁剪] 原对话约 ' + originalTokens
      + ' tokens，超出上下文预算 ' + budget + ' tokens。为保持可续聊，已保留开头锚点'
      + '与最近对话，裁剪中间 ' + trimmed.droppedTurns + ' 轮（' + trimmed.droppedMessages
      + ' 条消息、' + trimmed.droppedToolCalls + ' 次工具调用）。完整历史见源文件。'
    if (attach.steps.length > 0) {
      attach.steps[0].content.unshift({ type: 'reasoning', text: summaryText })
    } else {
      attach.steps.push({ content: [{ type: 'reasoning', text: summaryText }], toolCalls: [], toolResults: [] })
    }
    trimmed.summaryInserted = true
  }

  // L3：单条兜底——裁剪后单条消息仍超预算一半 → 直接丢弃（宁缺毋滥）。首轮
  // prompt 永不丢弃（保证至少一条可续聊的用户消息）；超大的 step 连同其工具调用
  // 一起丢（配对保持完整），超大的工具结果丢后由 synthesizeSession 补空结果。
  const halfBudget = budget / 2
  const kept2 = []
  for (let i = 0; i < kept.length; i++) {
    const t = kept[i]
    if (i > 0 && estimateTokens(t.prompt) > halfBudget) {
      trimmed.droppedTurns++
      let resultCount = 0
      for (const s of t.steps) {
        trimmed.droppedToolCalls += s.toolCalls.length
        trimmed.droppedToolResults += s.toolResults.length
        resultCount += s.toolResults.length
      }
      trimmed.droppedMessages += 1 + t.steps.length + resultCount
      trimmed.droppedOversized++
      continue
    }
    const steps = []
    for (const s of t.steps) {
      if (estimateBlocks(s.content) > halfBudget) {
        trimmed.droppedMessages++
        trimmed.droppedToolCalls += s.toolCalls.length
        trimmed.droppedToolResults += s.toolResults.length
        trimmed.droppedOversized++
        continue
      }
      const toolResults = []
      for (const tr of s.toolResults) {
        if (estimateBlocks(tr.content) > halfBudget) {
          trimmed.droppedMessages++
          trimmed.droppedToolResults++
          trimmed.droppedOversized++
          continue
        }
        toolResults.push(tr)
      }
      steps.push({ ...s, toolResults })
    }
    kept2.push({ ...t, steps })
  }

  trimmed.estimatedTokens = estimateTurns(kept2)
  return { turns: kept2, trimmed }
}

// 统一裁剪入口（convertXxx 接线用）：budget 缺省/非正数 → 原样返回（trimmed=null，
// 不产生上报）；保护未实际生效（无任何裁剪/截断/丢弃）时同样返回 null，避免噪音。
export function applyBudgetTrim(turns, budget) {
  if (budget === undefined || budget === null) return { turns: turns || [], trimmed: null }
  const b = Number(budget)
  if (!Number.isFinite(b) || b <= 0) return { turns: turns || [], trimmed: null }
  const { turns: out, trimmed } = trimTurns(turns, b)
  const engaged = trimmed.croppedBlocks > 0 || trimmed.droppedTurns > 0 || trimmed.droppedMessages > 0
    || trimmed.droppedToolCalls > 0 || trimmed.droppedToolResults > 0 || trimmed.droppedOversized > 0
    || trimmed.summaryInserted
  return { turns: out, trimmed: engaged ? trimmed : null }
}

// 逐行解析 JSONL：直连人类提问（type==='user' 且 content 为字符串）开新轮；每条
// assistant 消息 = 一步。Claude 源格式把多条连续 assistant（各带 tool_use）与后置的
// tool_result 分开（assistant[callA] assistant[callB] user[resultA] user[resultB]）；
// tool_result 按 tool_use_id 挂到 call 所属 step（而非最近一步），保证投影出的 LLM
// 消息里每条 tool 消息紧邻其 tool_calls 的 assistant（wire 规则：中间不能插 assistant）。
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
  // callId → 它所属的 step：Claude 的 tool_result 全部后置（在连续 assistant 之后
  // 到达），必须按 callId 挂回 call 所在 step；挂最近一步会让投影出的消息里带
  // tool_calls 的 assistant 后面紧跟另一条 assistant，违反 wire 规则
  const callSteps = new Map()
  // 丢弃的孤儿 tool_result 计数（transcript 里没有对应 tool_use）
  let droppedToolResults = 0

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
      for (const tc of step.toolCalls) callSteps.set(tc.id, step)
    } else if (rec && rec.type === 'user' && Array.isArray(rec.message?.content)) {
      // 工具结果：按 tool_use_id 挂到 call 所属 step。Claude 的 tool_result 在所有
      // assistant（各带 tool_use）之后到达；挂最近一步会让带 tool_calls 的 assistant
      // 后面紧跟另一条 assistant，投影出的 LLM 消息违反 wire 规则。查不到对应调用
      // （如 transcript 从中途开始）的孤儿结果直接丢弃并计数：挂 lastStep 会投影出
      // 无 call 的孤儿 tool 消息，同样被模型 API 拒绝。
      for (const block of rec.message.content) {
        if (block && block.type === 'tool_result') {
          const step = callSteps.get(block.tool_use_id)
          if (!step) { droppedToolResults++; continue }
          const inner = (Array.isArray(block.content) ? block.content : [])
            .map(mapContentBlock)
            .filter(Boolean)
          step.toolResults.push({
            toolCallId: block.tool_use_id,
            content: inner,
            isError: block.is_error === true,
          })
        }
      }
    }
  }

  // 同一步内多个结果按 call 顺序对齐：Claude 的 tool_result 块可能乱序返回
  // （并行工具），按该 step 的 toolCalls 顺序稳定排序，保证投影出的 tool 消息
  // 与 assistant 的 tool_calls 一一对应、顺序一致。
  for (const t of turns) {
    for (const s of t.steps) {
      if (s.toolResults.length < 2 || s.toolCalls.length === 0) continue
      const order = new Map(s.toolCalls.map((c, i) => [c.id, i]))
      s.toolResults.sort((a, b) => {
        const ia = order.get(a.toolCallId)
        const ib = order.get(b.toolCallId)
        return (ia === undefined ? s.toolCalls.length : ia) - (ib === undefined ? s.toolCalls.length : ib)
      })
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
      skipped: 0, records: recs.length, droppedToolResults: 0,
      skipReason: 'auxiliary transcript (file "' + fileStem + '" does not match sessionId "' + sourceId + '"); only the main <sessionId>.jsonl becomes a session',
    }
  }

  const sessionId = args.sessionId || mintSessionId(sourceId)
  const meta = { version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: createdAt ?? Date.now() }
  if (sourceId) meta.sourceId = sourceId
  if (cwd) meta.cwd = cwd

  const { turns: seedTurns, trimmed } = applyBudgetTrim(turns, args.budget)
  const syn = synthesizeSession({ meta, turns: seedTurns, title, provider: 'claude-code', model, skipped, records: recs.length, imported: { sourcePath: args.sourcePath } })
  return { ...syn, droppedToolResults, ...(trimmed ? { trimmed } : {}) }
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
  // REQ-44：custom_tool_call 的 JS 参数未能转标准 JSON、原样保留的个数（诊断计数）
  let droppedMalformedArgs = 0
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
        // custom_tool_call（如 apply_patch）：input 是自由格式；2026+ 新版是 JS 代码
        // （tools.exec_command({...}) 等调用形态）——识别并转标准 JSON，失败原样保留
        const res = codexCustomToolArguments(payload.input)
        argumentsText = res.arguments
        if (res.fallback) droppedMalformedArgs++
      }
      const mapped = {
        id: callId,
        name: payload.name || 'unknown',
        arguments: argumentsText,
      }
      // assistant 消息内容必须携带 tool-call block：wire 适配器的 tool_calls 只从
      // assistant 消息的 content 块派生（dsh-llm-deepseek serializeAssistant），
      // 只挂 step.toolCalls 会让 tool/result 成为无前置 tool_calls 的孤儿 tool 消息
      step.content.push({ type: 'tool-call', ...mapped })
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
  if (sourceId) meta.sourceId = sourceId
  if (cwd) meta.cwd = cwd

  const { turns: seedTurns, trimmed } = applyBudgetTrim(turns, args.budget)
  return {
    ...synthesizeSession({ meta, turns: seedTurns, title, provider: 'codex', model, skipped, records: recs.length, imported: { sourcePath: args.sourcePath } }),
    droppedMalformedArgs,
    ...(trimmed ? { trimmed } : {}),
  }
}

// Codex `custom_tool_call` 的 input 是 JS 代码字符串（2026+ 新版，如
// `tools.exec_command({cmd: "...", workdir: "..."})`、直接对象字面量或箭头/括号包裹的
// 调用表达式）。直接 JSON.stringify 当 arguments 传模型会让模型学到错误的调用格式
// （JS/XML 混合）。识别 JS 调用形态 → 提取最外层对象字面量 → 最小转换器转标准 JSON；
// 提取/转换任一失败回退原样（不抛异常、不产生垃圾输出）。返回 { arguments, fallback }：
// fallback=true 表示「识别为 JS 形态但未能转换、原样保留」（供调用方计数
// droppedMalformedArgs）；apply_patch 这类自由文本不算，因为根本没进入转换流程。
export function codexCustomToolArguments(input) {
  if (typeof input !== 'string') return { arguments: JSON.stringify(input ?? {}), fallback: false }
  const text = input.trim()
  if (!text || !codexJsArgsShape(text)) return { arguments: JSON.stringify(input), fallback: false }
  const start = findObjectStart(text)
  if (start === -1) return { arguments: JSON.stringify(input), fallback: true }
  const end = findMatchingBrace(text, start)
  if (end === -1) return { arguments: JSON.stringify(input), fallback: true }
  const json = jsObjectLiteralToJson(text.slice(start, end + 1))
  if (json === null) return { arguments: JSON.stringify(input), fallback: true }
  return { arguments: json, fallback: false }
}

// 识别 Codex custom_tool_call 的 JS 调用形态：直接对象字面量 {…}、括号包裹表达式
// （IIFE / 箭头函数 / Promise.all）、name(…) / tools.name(…) 调用，以及带赋值/返回
// 前缀的调用片段（const r = await tools.exec_command({…}) 等）。
function codexJsArgsShape(text) {
  return /^\{/.test(text)
    || /^\(/.test(text)
    || /^(?:return\s+|(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*)?(?:await\s+)?(?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$][\w$]*\s*\(/.test(text)
}

// 定位 input 中第一个不在字符串/模板字面量里的 '{'（提取调用参数的对象字面量起点）。
function findObjectStart(text) {
  for (let i = 0; i < text.length;) {
    const ch = text[i]
    if (ch === '"' || ch === "'") { i = skipJsString(text, i); continue }
    if (ch === '`') { i = skipJsTemplate(text, i); continue }
    if (ch === '{') return i
    i++
  }
  return -1
}

// 从 start（text[start] === '{'）找到匹配的 '}'（嵌套花括号 / 字符串 / 模板 aware）。
function findMatchingBrace(text, start) {
  let depth = 0
  for (let i = start; i < text.length;) {
    const ch = text[i]
    if (ch === '"' || ch === "'") { i = skipJsString(text, i); continue }
    if (ch === '`') { i = skipJsTemplate(text, i); continue }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return i
    }
    i++
  }
  return -1
}

// 跳过单/双引号字符串（含反斜杠转义）；返回越过闭合引号的下标。未闭合时扫到末尾。
function skipJsString(text, start) {
  const quote = text[start]
  for (let i = start + 1; i < text.length;) {
    const ch = text[i]
    if (ch === '\\') { i += 2; continue }
    i++
    if (ch === quote) return i
  }
  return text.length
}

// 跳过模板字面量（含 ${…} 插值：插值内按 JS 代码扫描，可嵌套字符串/模板/花括号）；
// 返回越过闭合反引号的下标。未闭合时扫到末尾。
function skipJsTemplate(text, start) {
  for (let i = start + 1; i < text.length;) {
    const ch = text[i]
    if (ch === '\\') { i += 2; continue }
    if (ch === '$' && text[i + 1] === '{') {
      let depth = 1
      i += 2
      while (i < text.length && depth > 0) {
        const c = text[i]
        if (c === '"' || c === "'") { i = skipJsString(text, i); continue }
        if (c === '`') { i = skipJsTemplate(text, i); continue }
        if (c === '{') { depth++; i++; continue }
        if (c === '}') { depth--; i++; if (depth === 0) break }
        i++
      }
      continue
    }
    i++
    if (ch === '`') return i
  }
  return text.length
}

// 最小 JS 对象字面量 → JSON 文本（零依赖、无 eval；递归下降）。
// 支持：字符串键/值（单/双引号 + 常用转义）、无引号标识符键、数字、true/false/null、
// 数组、嵌套对象。不支持（返回 null）：函数/方法调用、变量引用、注释、尾逗号、
// 模板字符串值、十六进制数字等——调用方回退原样。
export function jsObjectLiteralToJson(src) {
  let i = 0
  const err = () => { throw new SyntaxError('unsupported JS object literal at ' + i) }
  const skipWs = () => { while (i < src.length && (src[i] === ' ' || src[i] === '\t' || src[i] === '\n' || src[i] === '\r')) i++ }
  const parseString = () => {
    const quote = src[i]
    i++
    let out = ''
    while (i < src.length) {
      const ch = src[i]
      if (ch === quote) { i++; return out }
      if (ch !== '\\') { out += ch; i++; continue }
      i++
      const e = src[i]
      switch (e) {
        case 'n': out += '\n'; i++; break
        case 't': out += '\t'; i++; break
        case 'r': out += '\r'; i++; break
        case 'b': out += '\b'; i++; break
        case 'f': out += '\f'; i++; break
        case 'v': out += '\v'; i++; break
        case '0': out += '\0'; i++; break
        case 'u': {
          i++
          if (src[i] === '{') {
            // \u{…}：1–6 位十六进制码点
            let hex = ''
            i++
            while (i < src.length && /[0-9a-fA-F]/.test(src[i])) { hex += src[i]; i++ }
            if (src[i] !== '}' || hex.length === 0 || hex.length > 6) err()
            const cp = parseInt(hex, 16)
            if (cp > 0x10ffff) err()
            out += String.fromCodePoint(cp)
            i++
          } else {
            const hex = src.slice(i, i + 4)
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) err()
            out += String.fromCharCode(parseInt(hex, 16))
            i += 4
          }
          break
        }
        case 'x': {
          i++
          const hex = src.slice(i, i + 2)
          if (!/^[0-9a-fA-F]{2}$/.test(hex)) err()
          out += String.fromCharCode(parseInt(hex, 16))
          i += 2
          break
        }
        default:
          // 身份转义（\\ \' \" 与未知转义按 JS 语义取原字符）
          out += e
          i++
      }
    }
    err() // 未闭合字符串
  }
  const parseIdentifier = () => {
    const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(src.slice(i))
    if (!m) err()
    i += m[0].length
    return m[0]
  }
  const parseNumber = () => {
    const m = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i))
    if (!m) err()
    const n = Number(m[0])
    if (!Number.isFinite(n)) err()
    i += m[0].length
    return n
  }
  const parseValue = () => {
    skipWs()
    if (i >= src.length) err()
    const ch = src[i]
    if (ch === '{') return parseObject()
    if (ch === '[') return parseArray()
    if (ch === '"' || ch === "'") return parseString()
    if (ch === '-' || ch === '.' || (ch >= '0' && ch <= '9')) return parseNumber()
    if (src.startsWith('true', i) && !/[A-Za-z0-9_$]/.test(src[i + 4] || '')) { i += 4; return true }
    if (src.startsWith('false', i) && !/[A-Za-z0-9_$]/.test(src[i + 5] || '')) { i += 5; return false }
    if (src.startsWith('null', i) && !/[A-Za-z0-9_$]/.test(src[i + 4] || '')) { i += 4; return null }
    err()
  }
  const parseArray = () => {
    i++ // '['
    const arr = []
    skipWs()
    if (src[i] === ']') { i++; return arr }
    for (;;) {
      arr.push(parseValue())
      skipWs()
      if (src[i] === ',') { i++; continue }
      if (src[i] === ']') { i++; return arr }
      err()
    }
  }
  const parseObject = () => {
    i++ // '{'
    const obj = {}
    skipWs()
    if (src[i] === '}') { i++; return obj }
    for (;;) {
      skipWs()
      const key = src[i] === '"' || src[i] === "'" ? parseString() : parseIdentifier()
      skipWs()
      if (src[i] !== ':') err()
      i++
      obj[key] = parseValue()
      skipWs()
      if (src[i] === ',') { i++; continue }
      if (src[i] === '}') { i++; return obj }
      err()
    }
  }
  const parseTop = () => {
    skipWs()
    const value = parseValue()
    skipWs()
    if (i !== src.length) err()
    return JSON.stringify(value)
  }
  try {
    return parseTop()
  } catch {
    // 解析器不支持的结构（函数/表达式/注释/尾逗号/模板字符串值等）→ null，调用方回退原样
    return null
  }
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
  if (conv.id) meta.sourceId = conv.id
  // 无用户回合（如只有 system 注入的会话）不产生空会话
  if (turns.length === 0) return null
  const { turns: seedTurns, trimmed } = applyBudgetTrim(turns, args.budget)
  const out = synthesizeSession({ meta, turns: seedTurns, title, provider: 'chatgpt', model: 'chatgpt', skipped: 0, records: thread.length, imported: { sourcePath: args.sourcePath } })
  return trimmed ? { ...out, trimmed } : out
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
      }
    }
  }

  // Cursor 无时间戳 / 会话内 id：会话 id 由 index 层从文件名（composer uuid）传入 args.cursorId，
  // 保证幂等；未传入时退化为时间戳（单文件手工导入仍可用）。sourceId 即 composer id。
  const finalId = args.sessionId || mintSessionId(args.cursorId)
  const meta = { version: SESSION_FORMAT_VERSION, id: finalId, createdAt: Date.now() }
  if (args.cursorId) meta.sourceId = args.cursorId
  const { turns: seedTurns, trimmed } = applyBudgetTrim(turns, args.budget)
  const out = synthesizeSession({ meta, turns: seedTurns, title: undefined, provider: 'cursor', model: 'cursor', skipped, records: recs.length, imported: { sourcePath: args.sourcePath } })
  return trimmed ? { ...out, trimmed } : out
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
    }
    // info 与未知类型跳过
  }

  const sessionId = args.sessionId || mintSessionId(chat.sessionId)
  const meta = { version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: parseTime(chat.startTime) }
  if (chat.sessionId) meta.sourceId = chat.sessionId
  if (Array.isArray(chat.directories) && chat.directories[0]) meta.cwd = chat.directories[0]
  const { turns: seedTurns, trimmed } = applyBudgetTrim(turns, args.budget)
  const out = synthesizeSession({ meta, turns: seedTurns, title: undefined, provider: 'gemini', model, skipped: 0, records: chat.messages.length, imported: { sourcePath: args.sourcePath } })
  return trimmed ? { ...out, trimmed } : out
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
  if (args.reasonixId) meta.sourceId = args.reasonixId
  if (args.cwd) meta.cwd = args.cwd
  const { turns: seedTurns, trimmed } = applyBudgetTrim(turns, args.budget)
  const out = synthesizeSession({ meta, turns: seedTurns, title: args.title, provider: 'reasonix', model: 'reasonix', skipped, records: recs.length, imported: { sourcePath: args.sourcePath } })
  return trimmed ? { ...out, trimmed } : out
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
  if (chat.id) meta.sourceId = chat.id
  if (typeof chat.directory === 'string' && chat.directory) meta.cwd = chat.directory
  const title = typeof chat.title === 'string' ? chat.title.trim() : undefined
  const { turns: seedTurns, trimmed } = applyBudgetTrim(turns, args.budget)
  const out = synthesizeSession({
    meta,
    turns: seedTurns,
    title,
    provider: 'opencode',
    model: opencodeSessionModel(chat),
    skipped: 0,
    records: chat.messages.length,
    imported: { sourcePath: args.sourcePath },
  })
  return trimmed ? { ...out, trimmed } : out
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
