// lib/convert/core.mjs — 共享转换核心（纯函数，无宿主依赖）
//
// 与 index.mjs 分离是为了可独立单元测试：本模块不 import 任何 DSH 包。
// 各源格式的 `convertXxx(raw, args)`（同目录 claude/codex/chatgpt/cursor/
// gemini/reasonix/opencode.mjs）把原始 transcript 文本解析成统一的回合中间
// 结构，再交给共享的 synthesizeSession 合成 DSH 事件日志，保证所有源
// （Claude Code / Codex-ChatGPT / ChatGPT / Cursor / Gemini / Reasonix /
// opencode）事件纪律一致。

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
export function synthesizeSession({ meta, turns, title, provider, model, skipped, records, imported }) {
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
