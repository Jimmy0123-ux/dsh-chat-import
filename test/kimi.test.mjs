// kimi.test.mjs — Kimi CLI 源转换核心单元测试（自包含合成数据，不掺真实 transcript）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { convertKimiWire } from '../lib/convert/kimi.mjs'
import { SESSION_FORMAT_VERSION } from '../lib/convert/core.mjs'

// 配对不变量：每个 tool/call 都有对应 tool/result，且 result 的 sourceEventSeqs
// 指向其 tool/call 的 seq（synthesizeSession 兜底保证，见 core.mjs）。
function assertToolPairing(events) {
  const calls = events.filter((e) => e.type === 'tool/call')
  const results = events.filter((e) => e.type === 'tool/result')
  assert.equal(results.length, calls.length, `tool/call(${calls.length}) 与 tool/result(${results.length}) 数量一致`)
  const resultByCall = new Map(results.map((r) => [r.data.message.content[0].toolCallId, r]))
  for (const c of calls) {
    const r = resultByCall.get(c.data.callId)
    assert.ok(r, `tool/result 存在 for call ${c.data.callId}`)
    assert.deepEqual(r.sourceEventSeqs, [c.seq], `call ${c.data.callId} 的 result 指向其 seq`)
  }
}

// 投影 LLM 消息序列：DSH 的 deriveMessages 按事件顺序扁平投影 surface 事件
//（user/message / assistant/message / tool/result），事件顺序即 wire 消息顺序。
function projectSurfaceMessages(events) {
  return events
    .filter((e) => e.type === 'user/message' || e.type === 'assistant/message' || e.type === 'tool/result')
    .map((e) => {
      if (e.type === 'user/message') return { role: 'user' }
      if (e.type === 'assistant/message') {
        return {
          role: 'assistant',
          toolCallIds: e.data.message.content.filter((c) => c.type === 'tool-call').map((c) => c.id),
        }
      }
      return { role: 'tool', toolCallId: e.data.message.content[0].toolCallId }
    })
}

// 消息投影顺序合法（wire 规则）：带 tool-call 块的 assistant 之后、到下一个
// assistant / user 消息之前，其全部 toolCallId 必须已有对应 tool 消息。
function assertMessageOrderLegal(events) {
  const msgs = projectSurfaceMessages(events)
  let open = []
  for (const m of msgs) {
    if (m.role === 'assistant') {
      assert.equal(open.length, 0, `assistant 前有未配对的 tool_calls（残留 ${open.join(',')}）`)
      open = [...m.toolCallIds]
    } else if (m.role === 'tool') {
      const i = open.indexOf(m.toolCallId)
      assert.ok(i !== -1, `tool 消息 ${m.toolCallId} 前没有对应的 tool-call`)
      open.splice(i, 1)
    } else {
      assert.equal(open.length, 0, `user 消息前有未配对的 tool_calls（残留 ${open.join(',')}）`)
    }
  }
  assert.equal(open.length, 0, `末尾残留未配对的 tool_calls（${open.join(',')}）`)
  return msgs
}

// 内部标记事件契约（REQ-32）：导入会话日志首事件（seq 0）为 session/imported。
function assertImportedMarker(events, { tool, sourceId, sourcePath }) {
  const ev = events[0]
  assert.equal(ev.type, 'session/imported')
  assert.equal(ev.seq, 0)
  assert.equal(ev.ignorable, true)
  assert.equal(ev.data.tool, tool)
  assert.equal(ev.data.sourceId, sourceId)
  assert.equal(ev.data.sourcePath, sourcePath)
  assert.equal(typeof ev.data.importedAt, 'number')
  assert.ok(ev.data.importedAt > 0)
  assert.equal(events[1].type, 'turn/start')
}

// 合成 wire.jsonl：首行 metadata + 记录（timestamp 秒级递增）。
function wire(recs, tsBase = 1776162400) {
  const lines = ['{"type":"metadata","protocol_version":"1"}']
  recs.forEach((r, i) => lines.push(JSON.stringify({ timestamp: tsBase + i, message: r })))
  return lines.join('\n')
}

// wire 事件构造：{type, payload} 包一层成 message 记录。
function ev(type, payload = {}) {
  return { type, payload }
}

const SRC = 'D:/kimi/sessions/6f0e2a1b3c4d5e6f7a8b9c0d1e2f3a4b/sess-001'

test('convertKimiWire: 简单问答（TurnBegin/StepBegin/TextPart/TurnEnd）、元数据、标题钉事件', () => {
  const out = convertKimiWire(wire([
    ev('TurnBegin', { user_input: '帮我看看构建失败' }),
    ev('StepBegin', { n: 1 }),
    ev('TextPart', { text: '是缺少依赖。' }),
    ev('TurnEnd'),
  ]), { sourcePath: SRC, kimiId: 'sess-001', cwd: 'D:/demo/kimi-proj' })
  assert.equal(out.turns.length, 1)
  assert.equal(out.messages, 2)
  assert.equal(out.toolCalls, 0)
  assert.equal(out.meta.id, 'import-sess-001')
  assert.equal(out.meta.sourceId, 'sess-001')
  assert.equal(out.meta.version, SESSION_FORMAT_VERSION)
  assert.equal(out.meta.cwd, 'D:/demo/kimi-proj')
  assert.equal(out.meta.createdAt, 1776162400 * 1000) // 首条记录 timestamp（秒 → 毫秒）
  assert.equal(out.title, '帮我看看构建失败') // 首问回填（未钉 session/title）
  assert.ok(!out.events.some((e) => e.type === 'session/title'))
  const types = out.events.map((e) => e.type)
  assert.deepEqual(types, [
    'session/imported', 'turn/start', 'step/start', 'user/message', 'assistant/message', 'step/end', 'turn/end',
  ])
  out.events.forEach((e, i) => assert.equal(e.seq, i))
  assertImportedMarker(out.events, { tool: 'kimi', sourceId: 'sess-001', sourcePath: SRC })
  for (const e of out.events.filter((e) => e.type === 'user/message' || e.type === 'assistant/message')) {
    assert.equal(e.surfaceOp, 'append')
  }
  const asst = out.events.find((e) => e.type === 'assistant/message').data.message
  assert.deepEqual(asst.source, { kind: 'model', provider: 'kimi', model: 'kimi' })
  assert.equal(asst.content[0].text, '是缺少依赖。')
})

test('convertKimiWire: custom_title（state.json）钉 session/title 事件且优先于首问', () => {
  const out = convertKimiWire(wire([
    ev('TurnBegin', { user_input: '首问内容' }),
    ev('StepBegin', { n: 1 }),
    ev('TextPart', { text: '回答' }),
    ev('TurnEnd'),
  ]), { sourcePath: SRC, kimiId: 'sess-001', title: '自定义标题' })
  assert.equal(out.title, '自定义标题')
  assert.equal(out.events.at(-1).type, 'session/title')
  assert.equal(out.events.at(-1).data.title, '自定义标题')
  assertImportedMarker(out.events, { tool: 'kimi', sourceId: 'sess-001', sourcePath: SRC })
})

test('convertKimiWire: ToolCall → tool/call + ToolResult → tool/result（sourceEventSeqs 关联）', () => {
  const out = convertKimiWire(wire([
    ev('TurnBegin', { user_input: '跑一下测试' }),
    ev('StepBegin', { n: 1 }),
    ev('TextPart', { text: '好的' }),
    ev('ToolCall', { type: 'function', id: 'call_01', function: { name: 'Bash', arguments: '{"command":"npm test"}' } }),
    ev('ToolResult', { tool_call_id: 'call_01', return_value: { is_error: false, output: 'all tests passed', message: '', display: [] } }),
    ev('TurnEnd'),
  ]), { sourcePath: SRC, kimiId: 'sess-001' })
  assert.equal(out.turns.length, 1)
  assert.equal(out.toolCalls, 1)
  const call = out.events.find((e) => e.type === 'tool/call')
  assert.equal(call.data.callId, 'call_01')
  assert.equal(call.data.name, 'Bash')
  assert.equal(call.data.arguments, '{"command":"npm test"}')
  const result = out.events.find((e) => e.type === 'tool/result')
  assert.equal(result.data.message.content[0].toolCallId, 'call_01')
  assert.equal(result.data.message.content[0].content[0].text, 'all tests passed')
  assert.equal(result.data.message.content[0].isError, undefined) // is_error:false 不加标记
  assert.deepEqual(result.sourceEventSeqs, [call.seq])
  assert.equal(result.surfaceOp, 'append')
  // tool-call 块出现在 assistant content 里（wire 适配器从 content 块派生 tool_calls）
  const asst = out.events.find((e) => e.type === 'assistant/message').data.message
  assert.deepEqual(asst.content.map((c) => c.type), ['text', 'tool-call'])
  assertToolPairing(out.events)
  assertMessageOrderLegal(out.events)
})

test('convertKimiWire: ThinkPart → reasoning block；ToolResult output 为 ContentPart 数组', () => {
  const out = convertKimiWire(wire([
    ev('TurnBegin', { user_input: '怎么修' }),
    ev('StepBegin', { n: 1 }),
    ev('ThinkPart', { think: '先看日志', encrypted: null }),
    ev('TextPart', { text: '查一下' }),
    ev('ToolCall', { type: 'function', id: 'call_02', function: { name: 'Read', arguments: '{"file":"a.txt"}' } }),
    ev('ToolResult', { tool_call_id: 'call_02', return_value: { is_error: false, output: [{ type: 'text', text: 'A 内容' }, { type: 'think', think: '结果是…' }], message: '', display: [] } }),
    ev('TurnEnd'),
  ]), { sourcePath: SRC, kimiId: 'sess-001' })
  const asst = out.events.find((e) => e.type === 'assistant/message').data.message
  assert.deepEqual(asst.content.map((c) => c.type), ['reasoning', 'text', 'tool-call'])
  assert.equal(asst.content[0].text, '先看日志')
  const result = out.events.find((e) => e.type === 'tool/result')
  assert.deepEqual(result.data.message.content[0].content.map((c) => c.type), ['text', 'reasoning'])
  assert.equal(result.data.message.content[0].content[1].text, '结果是…')
  assertToolPairing(out.events)
})

test('convertKimiWire: 流式 TextPart 分块合并成单块（on_message_part 收原始块）', () => {
  const out = convertKimiWire(wire([
    ev('TurnBegin', { user_input: 'hi' }),
    ev('StepBegin', { n: 1 }),
    ev('TextPart', { text: '你好，' }),
    ev('TextPart', { text: '世界！' }),
    ev('ThinkPart', { think: '思考' }),
    ev('ThinkPart', { think: '继续' }),
    ev('TurnEnd'),
  ]), { sourcePath: SRC, kimiId: 'sess-001' })
  const asst = out.events.find((e) => e.type === 'assistant/message').data.message
  assert.deepEqual(asst.content, [
    { type: 'text', text: '你好，世界！' },
    { type: 'reasoning', text: '思考继续' },
  ])
})

test('convertKimiWire: SteerInput 开新轮（每条用户输入一轮）', () => {
  const out = convertKimiWire(wire([
    ev('TurnBegin', { user_input: '第一个问题' }),
    ev('StepBegin', { n: 1 }),
    ev('TextPart', { text: '第一个回答' }),
    ev('SteerInput', { user_input: '第二个问题' }),
    ev('StepBegin', { n: 2 }),
    ev('TextPart', { text: '第二个回答' }),
    ev('TurnEnd'),
  ]), { sourcePath: SRC, kimiId: 'sess-001' })
  assert.equal(out.turns.length, 2)
  const users = out.events.filter((e) => e.type === 'user/message').map((e) => e.data.content[0].text)
  assert.deepEqual(users, ['第一个问题', '第二个问题'])
  const starts = out.events.filter((e) => e.type === 'turn/start')
  assert.equal(starts.length, 2)
  assertMessageOrderLegal(out.events)
})

test('convertKimiWire: 无 StepBegin 的内容挂隐式步骤（slash 回复等）；turn 外内容忽略', () => {
  const out = convertKimiWire(wire([
    ev('TextPart', { text: 'turn 外回复（忽略）' }),
    ev('TurnBegin', { user_input: '问题' }),
    ev('TextPart', { text: '无 StepBegin 的回复' }),
    ev('TurnEnd'),
  ]), { sourcePath: SRC, kimiId: 'sess-001' })
  assert.equal(out.turns.length, 1)
  const asst = out.events.find((e) => e.type === 'assistant/message')
  assert.equal(asst.data.message.content[0].text, '无 StepBegin 的回复')
  // turn 外文本未进入任何事件
  assert.ok(!out.events.some((e) => e.data && e.data.message && e.data.message.content && e.data.message.content[0].text === 'turn 外回复（忽略）'))
})

test('convertKimiWire: 中断的 ToolCall 补发空 tool/result（配对不变量）', () => {
  const out = convertKimiWire(wire([
    ev('TurnBegin', { user_input: '跑一下' }),
    ev('StepBegin', { n: 1 }),
    ev('ToolCall', { type: 'function', id: 'call_03', function: { name: 'Bash', arguments: '{}' } }),
    ev('TurnEnd'),
  ]), { sourcePath: SRC, kimiId: 'sess-001' })
  assert.equal(out.toolCalls, 1)
  const result = out.events.find((e) => e.type === 'tool/result')
  assert.deepEqual(result.data.message.content[0].content, []) // 空 content，不虚构文本
  assertToolPairing(out.events)
  assertMessageOrderLegal(out.events)
})

test('convertKimiWire: ToolResult is_error → isError 标记；output 为空回退 message', () => {
  const out = convertKimiWire(wire([
    ev('TurnBegin', { user_input: '跑一下' }),
    ev('StepBegin', { n: 1 }),
    ev('ToolCall', { type: 'function', id: 'call_err', function: { name: 'Bash', arguments: '{}' } }),
    ev('ToolResult', { tool_call_id: 'call_err', return_value: { is_error: true, output: '', message: '命令失败：boom', display: [] } }),
    ev('TurnEnd'),
  ]), { sourcePath: SRC, kimiId: 'sess-001' })
  const result = out.events.find((e) => e.type === 'tool/result')
  assert.equal(result.data.message.content[0].isError, true)
  assert.equal(result.data.message.content[0].content[0].text, '命令失败：boom')
})

test('convertKimiWire: 孤儿 ToolResult（无对应调用）丢弃计数；SubagentEvent 跳过计数', () => {
  const out = convertKimiWire(wire([
    ev('TurnBegin', { user_input: '继续' }),
    ev('StepBegin', { n: 1 }),
    ev('TextPart', { text: '好的' }),
    ev('ToolResult', { tool_call_id: 'call_ghost', return_value: { is_error: false, output: '幽灵结果', message: '', display: [] } }),
    ev('SubagentEvent', { parent_tool_call_id: 'call_agent', agent_id: 'agent-0', subagent_type: 'researcher', event: { type: 'TurnBegin', payload: { user_input: '子代理内部' } } }),
    ev('TurnEnd'),
  ]), { sourcePath: SRC, kimiId: 'sess-001' })
  assert.equal(out.droppedToolResults, 1)
  assert.equal(out.subagentEvents, 1)
  assert.equal(out.events.filter((e) => e.type === 'tool/result').length, 0)
  // 子代理镜像未展开（无第二个 turn）
  assert.equal(out.events.filter((e) => e.type === 'turn/start').length, 1)
  assertMessageOrderLegal(out.events)
})

test('convertKimiWire: ToolCallPart 与状态/控制事件跳过（不产生事件）', () => {
  const out = convertKimiWire(wire([
    ev('TurnBegin', { user_input: 'hi' }),
    ev('StepBegin', { n: 1 }),
    ev('ToolCallPart', { arguments_part: '{"co' }),
    ev('ToolCall', { type: 'function', id: 'call_04', function: { name: 'Bash', arguments: '{"command":"ls"}' } }),
    ev('ToolResult', { tool_call_id: 'call_04', return_value: { is_error: false, output: 'out', message: '', display: [] } }),
    ev('StatusUpdate', { context_tokens: 100, token_usage: { input: 10, output: 5 } }),
    ev('CompactionBegin'),
    ev('CompactionEnd'),
    ev('StepInterrupted'),
    ev('ApprovalRequest', { id: 'req-1', tool_call_id: 'call_04', sender: 'shell', action: 'Bash', description: 'x' }),
    ev('Notification', { id: 'n1', category: 'x', type: 'x', source_kind: 'x', source_id: 'x', title: 't', body: 'b', severity: 'info', created_at: 1 }),
    ev('TurnEnd'),
  ]), { sourcePath: SRC, kimiId: 'sess-001' })
  assert.equal(out.turns.length, 1)
  assert.equal(out.toolCalls, 1)
  const call = out.events.find((e) => e.type === 'tool/call')
  assert.equal(call.data.arguments, '{"command":"ls"}') // 完整参数来自最终 ToolCall
  const asst = out.events.find((e) => e.type === 'assistant/message').data.message
  assert.deepEqual(asst.content.map((c) => c.type), ['tool-call']) // 无文本泄漏
  assertToolPairing(out.events)
})

test('convertKimiWire: 畸形行计数、records、多轮切分', () => {
  const lines = ['{"type":"metadata","protocol_version":"1"}', 'not json',
    JSON.stringify({ timestamp: 1776162400, message: ev('TurnBegin', { user_input: '问题一' }) }),
    JSON.stringify({ timestamp: 1776162401, message: ev('TextPart', { text: '回答一' }) }),
    JSON.stringify({ timestamp: 1776162402, message: ev('TurnBegin', { user_input: '问题二' }) }),
    JSON.stringify({ timestamp: 1776162403, message: ev('TextPart', { text: '回答二' }) })]
  const out = convertKimiWire(lines.join('\n'), { sourcePath: SRC, kimiId: 'sess-001' })
  assert.equal(out.skipped, 1) // 畸形行只计 skipped
  assert.equal(out.records, 5) // 成功解析的行数（含 metadata）
  assert.equal(out.turns.length, 2)
  const users = out.events.filter((e) => e.type === 'user/message').map((e) => e.data.content[0].text)
  assert.deepEqual(users, ['问题一', '问题二'])
})

test('convertKimiWire: user_input 为 ContentPart 数组（图片占位等）取 text', () => {
  const out = convertKimiWire(wire([
    ev('TurnBegin', { user_input: [{ type: 'text', text: '看这张图' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,xxx' } }] }),
    ev('StepBegin', { n: 1 }),
    ev('TextPart', { text: '好的' }),
    ev('TurnEnd'),
  ]), { sourcePath: SRC, kimiId: 'sess-001' })
  const user = out.events.find((e) => e.type === 'user/message').data
  assert.equal(user.content[0].text, '看这张图')
})

test('convertKimiWire: 标题归一（REQ-27）与首问回退不钉事件', () => {
  const long = '长'.repeat(90)
  const out = convertKimiWire(wire([
    ev('TurnBegin', { user_input: long }),
    ev('StepBegin', { n: 1 }),
    ev('TextPart', { text: '回答' }),
    ev('TurnEnd'),
  ]), { sourcePath: SRC, kimiId: 'sess-001' })
  assert.equal(out.title, '长'.repeat(79) + '…')
  assert.ok(!out.events.some((e) => e.type === 'session/title'))
})

test('convertKimiWire: sessionId 覆盖与 budget 裁剪透传（REQ-37）', () => {
  const recs = []
  for (let i = 1; i <= 60; i++) {
    recs.push(ev('TurnBegin', { user_input: '问题' + '字'.repeat(49) + i }))
    recs.push(ev('StepBegin', { n: 1 }))
    recs.push(ev('TextPart', { text: '回答' + '字'.repeat(49) + i }))
    recs.push(ev('TurnEnd'))
  }
  const out = convertKimiWire(wire(recs), { sourcePath: SRC, kimiId: 'sess-001', sessionId: 'custom-kimi', budget: 1000 })
  assert.equal(out.meta.id, 'custom-kimi')
  // sourceId 显式取自 kimiId，不因 DSH 会话 id 覆盖/前缀解析而改变（REQ-32）
  assert.equal(out.meta.sourceId, 'sess-001')
  assert.equal(out.events[0].data.sourceId, 'sess-001')
  assert.ok(out.trimmed)
  assert.ok(out.trimmed.droppedTurns > 0)
  assert.ok(out.trimmed.estimatedTokens <= 1000)
  assert.equal(out.trimmed.budget, 1000)
  assertToolPairing(out.events)
  assertMessageOrderLegal(out.events)
  // 无 budget → 原样、无裁剪上报
  const plain = convertKimiWire(wire(recs), { sourcePath: SRC, kimiId: 'sess-001' })
  assert.equal(plain.trimmed, undefined)
  assert.ok(plain.turns.length > out.turns.length)
})

test('convertKimiWire: 空 wire（仅 metadata）不产生事件', () => {
  const out = convertKimiWire('{"type":"metadata","protocol_version":"1"}\n', { sourcePath: SRC, kimiId: 'sess-001' })
  assert.equal(out.turns.length, 0)
  assert.equal(out.events.length, 0)
  assert.equal(out.records, 1)
})

test('convertKimiWire: 无 kimiId 时从 sourcePath 会话目录名派生源 id', () => {
  const out = convertKimiWire(wire([
    ev('TurnBegin', { user_input: 'hi' }),
    ev('StepBegin', { n: 1 }),
    ev('TextPart', { text: '回答' }),
    ev('TurnEnd'),
  ]), { sourcePath: SRC })
  assert.equal(out.meta.id, 'import-sess-001')
  assert.equal(out.meta.sourceId, 'sess-001')
})

test('convertKimiWire: 空 user_input 的 TurnBegin 不建轮（后续内容挂不上则忽略）', () => {
  const out = convertKimiWire(wire([
    ev('TurnBegin', { user_input: '' }),
    ev('StepBegin', { n: 1 }),
    ev('TextPart', { text: '无用户输入的回复' }),
    ev('TurnEnd'),
    ev('TurnBegin', { user_input: '真实问题' }),
    ev('StepBegin', { n: 1 }),
    ev('TextPart', { text: '真实回答' }),
    ev('TurnEnd'),
  ]), { sourcePath: SRC, kimiId: 'sess-001' })
  assert.equal(out.turns.length, 1)
  const users = out.events.filter((e) => e.type === 'user/message')
  assert.equal(users.length, 1)
  assert.equal(users[0].data.content[0].text, '真实问题')
})
