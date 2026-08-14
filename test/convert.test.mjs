// convert.test.mjs — 纯转换逻辑单元测试（无宿主依赖）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { convertClaudeJsonl, convertCodexJsonl, convertChatgptJson, convertCursorJsonl, convertGeminiJson, convertReasonixJsonl, convertOpencodeJson, reasonixStemTime, mintSessionId, parseTime, SESSION_FORMAT_VERSION, tailSessionEvents } from '../convert.mjs'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const load = (name) => readFileSync(join(fixtures, name), 'utf8')

// 配对不变量：每个 tool/call 都有对应 tool/result，且 result 的 sourceEventSeqs
// 指向其 tool/call 的 seq（synthesizeSession 兜底保证，见 convert.mjs）。
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
// （user/message / assistant/message / tool/result），不做重排——事件顺序即
// wire 消息顺序。返回 [{role:'user'} | {role:'assistant', toolCallIds} |
// {role:'tool', toolCallId}] 序列。
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

// 消息投影顺序合法（wire 规则）：带 tool-call 块的 assistant 消息之后、到下一个
// assistant / user 消息之前，其全部 toolCallId 必须已有对应 tool 消息——不允许
// 「带 tool_calls 的 assistant 后紧跟另一条 assistant 而中间无 tool 消息」，
// 也不允许无对应 tool-call 的孤儿 tool 消息。返回投影序列供精确断言。
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

// 内部标记事件契约（REQ-32）：导入会话日志首事件（seq 0）为 session/imported，
// 顶层 ignorable: true，data 四字段（tool / sourceId / sourcePath / importedAt）。
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
  // 标记之后才进入回合事件
  assert.equal(events[1].type, 'turn/start')
}

test('convertClaudeJsonl: 简单问答合成平衡回合', () => {
  const out = convertClaudeJsonl(load('sess-simple-001.jsonl'), { sourcePath: 'D:\\demo\\proj\\sess-simple-001.jsonl' })
  assert.equal(out.turns.length, 1)
  assert.equal(out.messages, 2)
  assert.equal(out.toolCalls, 0)
  assert.equal(out.meta.id, 'import-sess-simple-001')
  assert.equal(out.meta.sourceId, 'sess-simple-001')
  assert.equal(out.meta.version, SESSION_FORMAT_VERSION)
  assert.equal(out.meta.cwd, 'D:\\demo\\proj')
  assert.ok(out.meta.createdAt)

  const types = out.events.map((e) => e.type)
  assert.deepEqual(types, [
    'session/imported', 'turn/start', 'step/start', 'user/message', 'assistant/message', 'step/end', 'turn/end',
  ])
  // seq 连续从 0 开始；首事件是内部标记
  out.events.forEach((e, i) => assert.equal(e.seq, i))
  assertImportedMarker(out.events, { tool: 'claude-code', sourceId: 'sess-simple-001', sourcePath: 'D:\\demo\\proj\\sess-simple-001.jsonl' })
  // surface 事件带 surfaceOp
  const surface = out.events.filter((e) => e.type === 'user/message' || e.type === 'assistant/message')
  for (const e of surface) assert.equal(e.surfaceOp, 'append')
})

test('convertClaudeJsonl: 工具历史（tool/call + tool/result + thinking + 多步）', () => {
  const out = convertClaudeJsonl(load('sess-tool-001.jsonl'))
  assert.equal(out.turns.length, 1)
  assert.equal(out.toolCalls, 1)
  const types = out.events.map((e) => e.type)
  assert.ok(types.includes('tool/call'))
  assert.ok(types.includes('tool/result'))
  assert.ok(types.includes('step/end'))
  assert.ok(types.includes('turn/end'))
  // 平衡：最后一个事件是 turn/end
  assert.equal(types.at(-1), 'turn/end')

  // 每条 user/message 的 id 唯一
  const ids = out.events.filter((e) => e.type === 'user/message').map((e) => e.data.id)
  assert.equal(new Set(ids).size, ids.length)

  // reasoning block（thinking）映射
  const assistant = out.events.find((e) => e.type === 'assistant/message').data.message
  const kinds = assistant.content.map((c) => c.type)
  assert.ok(kinds.includes('reasoning'))
  assert.ok(kinds.includes('text'))
  assert.ok(kinds.includes('tool-call'))

  // tool/call 与 tool/result 关联：sourceEventSeqs 指向 tool/call 的 seq
  const call = out.events.find((e) => e.type === 'tool/call')
  const result = out.events.find((e) => e.type === 'tool/result')
  assert.equal(call.data.callId, 'toolu_01')
  assert.equal(result.data.message.content[0].toolCallId, 'toolu_01')
  assert.deepEqual(result.sourceEventSeqs, [call.seq])
  assert.equal(result.surfaceOp, 'append')
  assertMessageOrderLegal(out.events)
})

test('convertClaudeJsonl: 多步回合（一步一个 assistant 消息）', () => {
  const out = convertClaudeJsonl(load('sess-multi-001.jsonl'))
  assert.equal(out.turns.length, 1)
  assert.equal(out.turns[0].steps.length, 2)
  const steps = out.events.filter((e) => e.type === 'step/start')
  assert.equal(steps.length, 2)
  assert.equal(steps[0].data.step, 1)
  assert.equal(steps[1].data.step, 2)
  const messages = out.events.filter((e) => e.type === 'assistant/message')
  assert.equal(messages.length, 2)
  assert.equal(messages[0].data.step, 1)
  assert.equal(messages[1].data.step, 2)
  // user/message 只在第一步出现
  const users = out.events.filter((e) => e.type === 'user/message')
  assert.equal(users.length, 1)
  assertMessageOrderLegal(out.events)
})

test('convertClaudeJsonl: ai-title → session/title 事件', () => {
  const out = convertClaudeJsonl(load('sess-title-001.jsonl'))
  assert.equal(out.title, '项目问题讨论')
  const titleEv = out.events.find((e) => e.type === 'session/title')
  assert.ok(titleEv)
  assert.equal(titleEv.data.title, '项目问题讨论')
  assert.deepEqual(titleEv.data.messageSeqs, [])
  assert.deepEqual(titleEv.data.source, { kind: 'user' })
})

test('convertClaudeJsonl: 畸形行计数', () => {
  const out = convertClaudeJsonl(load('sess-bad-001.jsonl'))
  assert.equal(out.skipped, 1)
  assert.equal(out.records, 2)
  assert.equal(out.turns.length, 1)
})

test('convertClaudeJsonl: 未回答的提问也成回合', () => {
  const out = convertClaudeJsonl(load('sess-empty-001.jsonl'), { sourcePath: 'D:\\demo\\proj\\sess-empty-001.jsonl' })
  assert.equal(out.turns.length, 1)
  assert.equal(out.messages, 1)
  const types = out.events.map((e) => e.type)
  assert.deepEqual(types, ['session/imported', 'turn/start', 'user/message', 'turn/end'])
})

test('convertClaudeJsonl: sessionId 覆盖参数生效', () => {
  const out = convertClaudeJsonl(load('sess-simple-001.jsonl'), { sessionId: 'custom-id', sourcePath: 'D:\\demo\\proj\\sess-simple-001.jsonl' })
  assert.equal(out.meta.id, 'custom-id')
  // sourceId 显式取自源记录，不因 DSH 会话 id 覆盖/前缀解析而改变（REQ-32）
  assert.equal(out.meta.sourceId, 'sess-simple-001')
  assert.equal(out.events[0].data.sourceId, 'sess-simple-001')
  const ids = out.events.filter((e) => e.type === 'user/message').map((e) => e.data.id)
  assert.ok(ids[0].startsWith('import:custom-id:u1'))
})

test('convertClaudeJsonl: 空输入不产生事件', () => {
  const out = convertClaudeJsonl('')
  assert.equal(out.events.length, 0)
  assert.equal(out.turns.length, 0)
})

test('turns=0 时不写 session/imported 标记（无可导入内容）', () => {
  // 有记录但无用户回合（纯 info 通知）：不产生空会话，也不加标记
  const info = convertGeminiJson(JSON.stringify({
    sessionId: 'gemini-info-only',
    startTime: '2026-04-17T18:09:18.567Z',
    messages: [{ id: 'i1', type: 'info', content: 'notice' }],
  }), { sourcePath: 'D:\\demo\\gemini\\info.json' })
  assert.equal(info.turns.length, 0)
  assert.equal(info.events.length, 0)
  assert.equal(info.events.some((e) => e.type === 'session/imported'), false)
  // 空输入同理（Claude）
  const empty = convertClaudeJsonl('', { sourcePath: 'D:\\demo\\proj\\empty.jsonl' })
  assert.equal(empty.turns.length, 0)
  assert.equal(empty.events.length, 0)
})

test('convertClaudeJsonl: 主 transcript（fileStem 与 sessionId 一致）正常导入', () => {
  const out = convertClaudeJsonl(load('sess-simple-001.jsonl'), { fileStem: 'sess-simple-001' })
  assert.equal(out.turns.length, 1)
  assert.equal(out.meta.id, 'import-sess-simple-001')
  assert.equal(out.skipReason, undefined)
})

test('convertClaudeJsonl: 辅助 transcript（fileStem ≠ sessionId）跳过并给原因', () => {
  // 辅助 transcript（如 subagents/agent-*.jsonl）记录携带父 sessionId，
  // 文件名与之不一致：不得按记录 sessionId 建会话（会与主 transcript 撞 id）
  const out = convertClaudeJsonl(load('sess-simple-001.jsonl'), { fileStem: 'agent-abc123' })
  assert.equal(out.meta, null)
  assert.equal(out.events.length, 0)
  assert.equal(out.turns.length, 0)
  assert.ok(out.skipReason.includes('auxiliary'))
  assert.ok(out.skipReason.includes('sess-simple-001'))
})

test('convertClaudeJsonl: 无 fileStem 参数保持原行为（纯函数直接调用不受限）', () => {
  const out = convertClaudeJsonl(load('sess-simple-001.jsonl'))
  assert.equal(out.turns.length, 1)
  assert.equal(out.meta.id, 'import-sess-simple-001')
})

test('convertClaudeJsonl: 后置的 tool/result 挂到 call 所属 step（不落最近一步）', () => {
  // 异步工具：调用在 step1，结果随后续 assistant（step2）之后到达。tool_result
  // 必须挂回 call 所属 step（step1），否则投影顺序里带 tool_calls 的 assistant
  // 后面紧跟另一条 assistant（step2），违反 wire 规则。
  const raw = [
    '{"sessionId":"sess-cross-001","type":"user","message":{"role":"user","content":"请查一下"}}',
    '{"sessionId":"sess-cross-001","type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"好"},{"type":"tool_use","id":"toolu_01","name":"fs_read","input":{}}]}}',
    '{"sessionId":"sess-cross-001","type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"继续"}]}}',
    '{"sessionId":"sess-cross-001","type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_01","content":[{"type":"text","text":"结果"}]}]}}',
  ].join('\n')
  const out = convertClaudeJsonl(raw, { fileStem: 'sess-cross-001' })
  const call = out.events.find((e) => e.type === 'tool/call')
  const result = out.events.find((e) => e.type === 'tool/result')
  assert.ok(call)
  assert.ok(result)
  assert.equal(call.data.step, 1)
  assert.equal(result.data.step, 1) // 挂到 call 所属 step，而不是结果到达时的最近一步（2）
  assert.deepEqual(result.sourceEventSeqs, [call.seq])
  assert.equal(result.surfaceOp, 'append')
  // 投影顺序：user → assistant(带 tool-call) → tool → assistant，合法
  const msgs = assertMessageOrderLegal(out.events)
  assert.deepEqual(msgs.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant'])
})

test('convertClaudeJsonl: 中断的 tool_use（无 tool_result）补发空 tool/result', () => {
  // 会话在工具结果返回前中断：assistant 带 tool_use 但没有后续 tool_result。
  // 不补 result 的话 resume 时模型 API 拒绝（tool_calls 无对应 tool 消息）。
  const raw = [
    '{"sessionId":"sess-cut-001","type":"user","message":{"role":"user","content":"跑一下测试"}}',
    '{"sessionId":"sess-cut-001","type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_02","name":"Bash","input":{"command":"npm test"}}]}}',
  ].join('\n')
  const out = convertClaudeJsonl(raw, { fileStem: 'sess-cut-001' })
  assert.equal(out.toolCalls, 1)
  const result = out.events.find((e) => e.type === 'tool/result')
  assert.ok(result)
  // 补发结果：空 content、sourceEventSeqs 指向其 call、同 step
  assert.deepEqual(result.data.message.content[0].content, [])
  assert.equal(result.data.message.content[0].toolCallId, 'toolu_02')
  assert.equal(result.surfaceOp, 'append')
  assertToolPairing(out.events)
  // 平衡：turn/end 收尾
  assert.equal(out.events.at(-1).type, 'turn/end')
  assertMessageOrderLegal(out.events)
})

test('convertClaudeJsonl: assistant 连续 tool_use、结果后置 → 投影顺序合法', () => {
  // Claude 源格式：assistant[callA] assistant[callB] user[resultA] user[resultB]
  // （结果后置）。结果必须挂回各自 call 的 step，投影顺序才是
  // user → assistant(A) → tool(A) → assistant(B) → tool(B)；挂最近一步会变成
  // assistant(A) → assistant(B) → tool(A) → tool(B)，被模型 API 拒绝。
  const raw = [
    '{"sessionId":"sess-post-001","type":"user","message":{"role":"user","content":"并行读两个文件"}}',
    '{"sessionId":"sess-post-001","type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"读 A"},{"type":"tool_use","id":"toolu_A","name":"Read","input":{"file":"a.txt"}}]}}',
    '{"sessionId":"sess-post-001","type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"读 B"},{"type":"tool_use","id":"toolu_B","name":"Read","input":{"file":"b.txt"}}]}}',
    '{"sessionId":"sess-post-001","type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_A","content":[{"type":"text","text":"A 内容"}]}]}}',
    '{"sessionId":"sess-post-001","type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_B","content":[{"type":"text","text":"B 内容"}]}]}}',
  ].join('\n')
  const out = convertClaudeJsonl(raw, { fileStem: 'sess-post-001' })
  assert.equal(out.toolCalls, 2)
  assert.equal(out.droppedToolResults, 0)
  const msgs = assertMessageOrderLegal(out.events)
  assert.deepEqual(msgs.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant', 'tool'])
  // 每条 tool 消息与其 call 的 assistant 同 step
  const calls = out.events.filter((e) => e.type === 'tool/call')
  const results = out.events.filter((e) => e.type === 'tool/result')
  assert.deepEqual(calls.map((c) => [c.data.callId, c.data.step]), [['toolu_A', 1], ['toolu_B', 2]])
  assert.deepEqual(results.map((r) => [r.data.message.content[0].toolCallId, r.data.step]), [['toolu_A', 1], ['toolu_B', 2]])
})

test('convertClaudeJsonl: 同 step 内多个 tool_result 按 call 顺序对齐', () => {
  // 并行工具：一个 assistant 消息带两个 tool_use，结果乱序返回（resultB 先到）。
  // 结果必须按该 step 的 toolCalls 顺序（A 在 B 前）对齐，保证投影出的 tool
  // 消息与 assistant 的 tool_calls 一一对应、顺序一致。
  const raw = [
    '{"sessionId":"sess-align-001","type":"user","message":{"role":"user","content":"读两个文件"}}',
    '{"sessionId":"sess-align-001","type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"Read","input":{"file":"a"}},{"type":"tool_use","id":"toolu_2","name":"Read","input":{"file":"b"}}]}}',
    '{"sessionId":"sess-align-001","type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_2","content":[{"type":"text","text":"B"}]},{"type":"tool_result","tool_use_id":"toolu_1","content":[{"type":"text","text":"A"}]}]}}',
  ].join('\n')
  const out = convertClaudeJsonl(raw, { fileStem: 'sess-align-001' })
  const results = out.events.filter((e) => e.type === 'tool/result').map((r) => r.data.message.content[0].toolCallId)
  assert.deepEqual(results, ['toolu_1', 'toolu_2'])
  assertMessageOrderLegal(out.events)
})

test('convertClaudeJsonl: 无对应 tool_use 的孤儿 tool_result 丢弃并计数', () => {
  // transcript 里出现没有对应 tool_use 的 tool_result（如从中途开始的文件）。
  // 挂 lastStep 会投影出无 call 的孤儿 tool 消息，被模型 API 拒绝 → 丢弃并计数。
  const raw = [
    '{"sessionId":"sess-orphan-001","type":"user","message":{"role":"user","content":"继续"}}',
    '{"sessionId":"sess-orphan-001","type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"好的"}]}}',
    '{"sessionId":"sess-orphan-001","type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_ghost","content":[{"type":"text","text":"幽灵结果"}]}]}}',
  ].join('\n')
  const out = convertClaudeJsonl(raw, { fileStem: 'sess-orphan-001' })
  assert.equal(out.droppedToolResults, 1)
  assert.equal(out.events.filter((e) => e.type === 'tool/result').length, 0)
  assertMessageOrderLegal(out.events)
})

test('convertClaudeJsonl: 部分调用无结果 → 空 result 补在 call 所属 step', () => {
  // step1 调用 A 有真实结果；step2 调用 B 的结果从未到达（中断）。
  // 兜底空 result 必须补在 B 自己的 step，保持每条 tool 消息紧邻其 assistant。
  const raw = [
    '{"sessionId":"sess-mix-001","type":"user","message":{"role":"user","content":"跑一下"}}',
    '{"sessionId":"sess-mix-001","type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_A","name":"Bash","input":{"command":"a"}}]}}',
    '{"sessionId":"sess-mix-001","type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_A","content":[{"type":"text","text":"A 结果"}]}]}}',
    '{"sessionId":"sess-mix-001","type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_B","name":"Bash","input":{"command":"b"}}]}}',
  ].join('\n')
  const out = convertClaudeJsonl(raw, { fileStem: 'sess-mix-001' })
  assert.equal(out.toolCalls, 2)
  const results = out.events.filter((e) => e.type === 'tool/result')
  assert.equal(results.length, 2)
  const byId = Object.fromEntries(results.map((r) => [r.data.message.content[0].toolCallId, r]))
  assert.equal(byId['toolu_A'].data.step, 1)
  assert.equal(byId['toolu_A'].data.message.content[0].content[0].text, 'A 结果')
  assert.equal(byId['toolu_B'].data.step, 2) // 空 result 补在 call 自己的 step
  assert.deepEqual(byId['toolu_B'].data.message.content[0].content, [])
  assertToolPairing(out.events)
  assertMessageOrderLegal(out.events)
})

test('mintSessionId: 清理非法字符并截断', () => {
  assert.equal(mintSessionId('abc_123-def'), 'import-abc_123-def')
  // 全非法字符时回退为时间戳（仍是合法 id）
  assert.match(mintSessionId('中文/路径\\特殊:字符'), /^import-\d+$/)
  const long = mintSessionId('x'.repeat(200))
  assert.ok(long.length <= 8 + 64)
})

test('parseTime: 解析 ISO 时间戳', () => {
  const t = parseTime('2026-08-01T10:00:00.000Z')
  assert.equal(typeof t, 'number')
  assert.ok(t > 0)
  assert.equal(parseTime(undefined), Date.now())
})

// ---- Codex / ChatGPT CLI rollout ----

test('convertCodexJsonl: 简单问答合成平衡回合（元数据来自 session_meta/turn_context）', () => {
  const out = convertCodexJsonl(load('codex-simple.jsonl'), { sourcePath: 'D:\\demo\\codex\\simple.jsonl' })
  assert.equal(out.turns.length, 1)
  assert.equal(out.messages, 2)
  assert.equal(out.toolCalls, 0)
  assert.equal(out.meta.id, 'import-019e3b3f-636d-7cb3-aaab-0255eb45ad4f')
  assert.equal(out.meta.sourceId, '019e3b3f-636d-7cb3-aaab-0255eb45ad4f')
  assert.equal(out.meta.version, SESSION_FORMAT_VERSION)
  assert.equal(out.meta.cwd, 'D:\\demo\\codex-proj')
  assert.ok(out.meta.createdAt)

  const types = out.events.map((e) => e.type)
  assert.deepEqual(types, [
    'session/imported', 'turn/start', 'step/start', 'user/message', 'assistant/message', 'step/end', 'turn/end',
  ])
  // seq 连续从 0 开始；最后一个事件是 turn/end（平衡）
  out.events.forEach((e, i) => assert.equal(e.seq, i))
  assert.equal(types.at(-1), 'turn/end')
  assertImportedMarker(out.events, { tool: 'codex', sourceId: '019e3b3f-636d-7cb3-aaab-0255eb45ad4f', sourcePath: 'D:\\demo\\codex\\simple.jsonl' })
  // surface 事件带 surfaceOp
  for (const e of out.events.filter((e) => e.type === 'user/message' || e.type === 'assistant/message')) {
    assert.equal(e.surfaceOp, 'append')
  }
  // assistant 的 source 带 codex provider 与真实 model
  const asst = out.events.find((e) => e.type === 'assistant/message').data.message
  assert.deepEqual(asst.source, { kind: 'model', provider: 'codex', model: 'gpt-5.5' })
})

test('convertCodexJsonl: function_call + function_call_output 按 call_id 跨行配对', () => {
  const out = convertCodexJsonl(load('codex-tool.jsonl'))
  assert.equal(out.turns.length, 1)
  assert.equal(out.toolCalls, 1)
  assert.equal(out.messages, 4) // user + assistant×2 + tool/result
  const types = out.events.map((e) => e.type)
  assert.ok(types.includes('tool/call'))
  assert.ok(types.includes('tool/result'))
  assert.equal(types.at(-1), 'turn/end')

  const call = out.events.find((e) => e.type === 'tool/call')
  assert.equal(call.data.callId, 'call_7ZuPytXrZQEdP2DBuForbrV8')
  assert.equal(call.data.name, 'shell_command')
  assert.equal(call.data.arguments, '{"cmd":"ls -la","workdir":"D:\\\\demo\\\\codex-proj"}')

  const result = out.events.find((e) => e.type === 'tool/result')
  assert.equal(result.data.message.content[0].toolCallId, 'call_7ZuPytXrZQEdP2DBuForbrV8')
  assert.deepEqual(result.sourceEventSeqs, [call.seq])
  assert.equal(result.surfaceOp, 'append')
  // output 是纯文本，直接作为 text block
  assert.equal(result.data.message.content[0].content[0].text, 'README.md\nsrc\n')
  assertMessageOrderLegal(out.events)
})

test('convertCodexJsonl: 注入块被过滤、reasoning 加密被跳过、custom_tool_call 用 input', () => {
  const out = convertCodexJsonl(load('codex-custom-tool.jsonl'))
  assert.equal(out.turns.length, 1)
  // 注入的 <environment_context> 不进入 prompt
  const user = out.events.find((e) => e.type === 'user/message').data
  assert.equal(user.content[0].text, '帮我修这个 bug')
  // 加密 reasoning 不产生 reasoning 块
  assert.equal(out.events.filter((e) => e.type === 'assistant/message').length, 2)
  const asst = out.events.filter((e) => e.type === 'assistant/message').map((e) => e.data.message)
  for (const m of asst) {
    assert.ok(!m.content.some((c) => c.type === 'reasoning'))
  }
  // custom_tool_call（apply_patch）→ tool/call，arguments 是 input 序列化
  const call = out.events.find((e) => e.type === 'tool/call')
  assert.equal(call.data.name, 'apply_patch')
  assert.equal(call.data.callId, 'call_sYb5HPObaiJRLYhllTHqbIxP')
  assert.ok(call.data.arguments.includes('*** Begin Patch'))
  const result = out.events.find((e) => e.type === 'tool/result')
  assert.equal(result.data.message.content[0].content[0].text, 'Patch applied successfully.')
  assert.deepEqual(result.sourceEventSeqs, [call.seq])
})

test('convertCodexJsonl: function_call 无 function_call_output 补发空 tool/result', () => {
  // 工具调用后会话结束/输出缺失：call_id 无对应 output → 合成空 result 保证配对
  const raw = [
    '{"timestamp":"2026-05-18T13:21:30.751Z","type":"session_meta","payload":{"id":"019e3b3f-636d-7cb3-aaab-0255eb45ad4f","timestamp":"2026-05-18T13:21:10.510Z","cwd":"D:\\\\demo\\\\codex-proj","originator":"codex-tui"}}',
    '{"timestamp":"2026-05-18T13:21:30.754Z","type":"turn_context","payload":{"turn_id":"t1","model":"gpt-5.5"}}',
    '{"timestamp":"2026-05-18T13:21:30.754Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"查一下"}]}}',
    '{"timestamp":"2026-05-18T13:21:31.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"好"}]}}',
    '{"timestamp":"2026-05-18T13:21:31.500Z","type":"response_item","payload":{"type":"function_call","name":"shell_command","arguments":"{\\"cmd\\":\\"ls\\"}","call_id":"call_orphan_001"}}',
  ].join('\n')
  const out = convertCodexJsonl(raw, { sessionId: 'codex-cut' })
  assert.equal(out.toolCalls, 1)
  const result = out.events.find((e) => e.type === 'tool/result')
  assert.ok(result)
  assert.deepEqual(result.data.message.content[0].content, [])
  assert.equal(result.data.message.content[0].toolCallId, 'call_orphan_001')
  assertToolPairing(out.events)
  assert.equal(out.events.at(-1).type, 'turn/end')
  assertMessageOrderLegal(out.events)
})

test('convertCodexJsonl: event_msg 重复消息不重复计数、多轮正确切分', () => {
  const out = convertCodexJsonl(load('codex-multi-turn.jsonl'))
  assert.equal(out.turns.length, 2)
  assert.equal(out.messages, 4) // 每轮 user + assistant（event_msg 重复不计）
  const starts = out.events.filter((e) => e.type === 'turn/start')
  assert.equal(starts.length, 2)
  const users = out.events.filter((e) => e.type === 'user/message')
  assert.equal(users.length, 2)
  assert.equal(users[0].data.content[0].text, '第一个问题')
  assert.equal(users[1].data.content[0].text, '第二个问题')
  const ends = out.events.filter((e) => e.type === 'turn/end')
  assert.equal(ends.length, 2)
})

test('convertCodexJsonl: 畸形行计数与会话 id 覆盖', () => {
  const raw = 'not json\n' + load('codex-simple.jsonl')
  const out = convertCodexJsonl(raw, { sessionId: 'custom-codex' })
  assert.equal(out.skipped, 1)
  assert.equal(out.meta.id, 'custom-codex')
})

test('convertCodexJsonl: 空输入不产生事件', () => {
  const out = convertCodexJsonl('')
  assert.equal(out.events.length, 0)
  assert.equal(out.turns.length, 0)
})

// ---- ChatGPT 网页导出 conversations.json ----

test('convertChatgptJson: 一文件多会话、多轮、mapping 主线程', () => {
  const out = convertChatgptJson(load('chatgpt-export.json'), { sourcePath: 'D:\\demo\\chatgpt\\conversations.json' })
  assert.equal(out.records, 3)
  assert.equal(out.conversations.length, 2) // conv-003 只有 system，被跳过
  assert.equal(out.skipped, 1)

  // conv-001：user → assistant → user
  const c1 = out.conversations.find((c) => c.meta.id === 'import-conv-001')
  assert.ok(c1)
  assert.equal(c1.title, 'Python debugging help')
  assert.equal(c1.turns.length, 2)
  assert.equal(c1.messages, 3)
  assert.equal(c1.toolCalls, 0)
  assertImportedMarker(c1.events, { tool: 'chatgpt', sourceId: 'conv-001', sourcePath: 'D:\\demo\\chatgpt\\conversations.json' })
  const types1 = c1.events.map((e) => e.type)
  // 事件以 turn/end 平衡收尾（session/title 钉在最后，不破坏回合平衡）
  assert.equal(types1.filter((t) => t === 'turn/end').length, 2)
  assert.equal([...types1].reverse().find((t) => t !== 'session/title'), 'turn/end')
  c1.events.forEach((e, i) => assert.equal(e.seq, i))
  // 时间戳：Unix 秒 → ms
  assert.equal(c1.meta.createdAt, 1710000000 * 1000)
  // assistant source
  const asst = c1.events.find((e) => e.type === 'assistant/message').data.message
  assert.deepEqual(asst.source, { kind: 'model', provider: 'chatgpt', model: 'chatgpt' })

  // conv-002：分支取最后 child（n4），占位节点 n3 跳过
  const c2 = out.conversations.find((c) => c.meta.id === 'import-conv-002')
  assert.ok(c2)
  assert.equal(c2.turns.length, 1)
  assertImportedMarker(c2.events, { tool: 'chatgpt', sourceId: 'conv-002', sourcePath: 'D:\\demo\\chatgpt\\conversations.json' })
  const asst2 = c2.events.filter((e) => e.type === 'assistant/message').map((e) => e.data.message.content[0].text)
  assert.deepEqual(asst2, ['Here is a simple aglio e olio recipe.', 'Actually, use cacio e pepe instead.'])
})

test('convertChatgptJson: 非数组 / 非法 JSON 返回空并计数 skipped', () => {
  const out = convertChatgptJson('not json at all')
  assert.equal(out.conversations.length, 0)
  assert.equal(out.skipped, 1)
  const obj = convertChatgptJson('{"a":1}')
  assert.equal(obj.conversations.length, 0)
  assert.equal(obj.skipped, 1)
})

test('convertChatgptJson: 无 cwd（ChatGPT 是聊天，不归组工作区）', () => {
  const out = convertChatgptJson(load('chatgpt-export.json'))
  const c1 = out.conversations.find((c) => c.meta.id === 'import-conv-001')
  assert.equal(c1.meta.cwd, undefined)
})

test('convertChatgptJson: tool 节点降级为文本块，不再产生孤儿 tool/result', () => {
  // ChatGPT 导出无结构化 tool-call（assistant 从不带 tool_calls 数组）；tool 节点
  // 挂 tool/result 只会产生没有对应 tool/call 的孤儿结果，resume 被模型端拒绝。
  // 按契约降级为最近一步的文本块。
  const raw = JSON.stringify([{
    id: 'conv-tool-001',
    title: 'Tool chat',
    create_time: 1710009000,
    mapping: {
      'n1': {
        id: 'n1',
        message: { id: 'm1', author: { role: 'user' }, content: { content_type: 'text', parts: ['跑一下测试'] }, create_time: 1710009000 },
        parent: null,
        children: ['n2'],
      },
      'n2': {
        id: 'n2',
        message: { id: 'm2', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['好的，执行 npm test。'] }, create_time: 1710009050 },
        parent: 'n1',
        children: ['n3'],
      },
      'n3': {
        id: 'n3',
        message: { id: 'm3', author: { role: 'tool' }, content: { content_type: 'code', parts: ['all tests passed'] }, create_time: 1710009060 },
        parent: 'n2',
        children: [],
      },
    },
  }])
  const out = convertChatgptJson(raw)
  assert.equal(out.conversations.length, 1)
  const c = out.conversations[0]
  // 不再产生 tool/result / tool/call 事件
  assert.equal(c.events.filter((e) => e.type === 'tool/result').length, 0)
  assert.equal(c.toolCalls, 0)
  // 工具文本挂到最近一步的 assistant 消息内容里
  const asst = c.events.find((e) => e.type === 'assistant/message').data.message
  assert.ok(asst.content.some((b) => b.type === 'text' && b.text === 'all tests passed'))
  // 平衡：最后（非 title）事件是 turn/end
  const types = c.events.map((e) => e.type)
  assert.equal([...types].reverse().find((t) => t !== 'session/title'), 'turn/end')
})

// ---- Cursor agent transcript ----

test('convertCursorJsonl: 简单问答、user_query 剥离、平衡回合', () => {
  const out = convertCursorJsonl(load('cursor-simple.jsonl'), { cursorId: 'abc123', sourcePath: 'D:\\demo\\cursor\\composer-abc.jsonl' })
  assert.equal(out.turns.length, 1)
  assert.equal(out.messages, 3) // user + assistant×2
  assert.equal(out.toolCalls, 0)
  assert.equal(out.meta.id, 'import-abc123') // cursorId 传入
  assert.equal(out.meta.sourceId, 'abc123')
  assertImportedMarker(out.events, { tool: 'cursor', sourceId: 'abc123', sourcePath: 'D:\\demo\\cursor\\composer-abc.jsonl' })
  const types = out.events.map((e) => e.type)
  assert.equal(types.filter((t) => t === 'turn/end').length, 1)
  out.events.forEach((e, i) => assert.equal(e.seq, i))
  // user_query 标签被剥离
  const user = out.events.find((e) => e.type === 'user/message').data
  assert.equal(user.content[0].text, 'Create a basic python interpreter in rust.')
  // provider
  const asst = out.events.find((e) => e.type === 'assistant/message').data.message
  assert.deepEqual(asst.source, { kind: 'model', provider: 'cursor', model: 'cursor' })
})

test('convertCursorJsonl: tool_use → tool/call + 合成空 tool/result，input 对象序列化', () => {
  const out = convertCursorJsonl(load('cursor-tool.jsonl'))
  assert.equal(out.toolCalls, 2)
  const calls = out.events.filter((e) => e.type === 'tool/call')
  assert.equal(calls.length, 2)
  assert.equal(calls[0].data.name, 'Glob')
  assert.equal(calls[0].data.arguments, '{"target_directory":".","glob_pattern":"**/*.rs"}')
  assert.equal(calls[1].data.name, 'Read')
  // transcript 不含 tool_result → synthesizeSession 为每个 call 补发空 tool/result
  // （空 content，不虚构文本），保证 resume 时 call/result 配对
  const results = out.events.filter((e) => e.type === 'tool/result')
  assert.equal(results.length, 2)
  assert.deepEqual(results[0].data.message.content[0].content, [])
  assertToolPairing(out.events)
  // 平衡：最后（非 title）事件是 turn/end
  const types = out.events.map((e) => e.type)
  assert.equal([...types].reverse().find((t) => t !== 'session/title'), 'turn/end')
  assertMessageOrderLegal(out.events)
})

test('convertCursorJsonl: [REDACTED] 哨兵过滤', () => {
  const out = convertCursorJsonl(load('cursor-redacted.jsonl'))
  assert.equal(out.turns.length, 1)
  const texts = out.events.filter((e) => e.type === 'assistant/message').map((e) => e.data.message.content[0].text)
  // 整段 [REDACTED] 被丢弃；含前缀的保留前缀
  assert.deepEqual(texts, ['Applied the refactor.'])
  assert.equal(out.messages, 2) // user + 一条有效 assistant
})

test('convertCursorJsonl: 多轮切分、畸形行计数、无 cursorId 回退时间戳 id', () => {
  const out = convertCursorJsonl('not json\n' + load('cursor-multi-turn.jsonl'), {})
  assert.equal(out.skipped, 1)
  assert.equal(out.turns.length, 2)
  const starts = out.events.filter((e) => e.type === 'turn/start')
  assert.equal(starts.length, 2)
  // 无 cursorId 时 id 仍合法（时间戳回退）
  assert.match(out.meta.id, /^import-\d+$/)
})

// ---- Gemini CLI 会话 ----

test('convertGeminiJson: 简单会话、元数据、平衡回合', () => {
  const out = convertGeminiJson(load('gemini-simple.json'), { sourcePath: 'D:\\demo\\gemini\\session-abc.json' })
  assert.equal(out.turns.length, 1)
  assert.equal(out.messages, 2)
  assert.equal(out.toolCalls, 0)
  assert.equal(out.meta.id, 'import-b26d7f99-0116-4d1d-b125-98c228a4b933')
  assert.equal(out.meta.sourceId, 'b26d7f99-0116-4d1d-b125-98c228a4b933')
  assert.equal(out.meta.cwd, 'D:\\demo\\gemini-proj') // directories[0] → cwd
  assert.ok(out.meta.createdAt) // startTime ISO → ms
  assertImportedMarker(out.events, { tool: 'gemini', sourceId: 'b26d7f99-0116-4d1d-b125-98c228a4b933', sourcePath: 'D:\\demo\\gemini\\session-abc.json' })
  const types = out.events.map((e) => e.type)
  assert.equal([...types].reverse().find((t) => t !== 'session/title'), 'turn/end')
  out.events.forEach((e, i) => assert.equal(e.seq, i))
  // 用户 parts 数组 → prompt
  const user = out.events.find((e) => e.type === 'user/message').data
  assert.equal(user.content[0].text, 'Create a basic python interpreter in rust.')
  // thoughts → reasoning；真实 model
  const asst = out.events.find((e) => e.type === 'assistant/message').data.message
  assert.ok(asst.content.some((c) => c.type === 'reasoning'))
  assert.deepEqual(asst.source, { kind: 'model', provider: 'gemini', model: 'gemini-3-flash-preview' })
})

test('convertGeminiJson: 内联 toolCalls → tool/call + tool/result（含错误标记）', () => {
  const out = convertGeminiJson(load('gemini-tool.json'))
  assert.equal(out.turns.length, 1)
  assert.equal(out.toolCalls, 2)
  const calls = out.events.filter((e) => e.type === 'tool/call')
  const results = out.events.filter((e) => e.type === 'tool/result')
  assert.equal(calls.length, 2)
  assert.equal(results.length, 2)
  assert.equal(calls[0].data.name, 'list_directory')
  assert.equal(calls[0].data.arguments, '{"path":"."}')
  // tool/result 与 tool/call 通过 sourceEventSeqs 关联
  assert.deepEqual(results[0].sourceEventSeqs, [calls[0].seq])
  assert.equal(results[0].data.message.content[0].content[0].text, 'src\nCargo.toml')
  // 第二个调用是 error → isError 标记
  assert.equal(results[1].data.message.content[0].isError, true)
  assert.equal(results[1].data.message.content[0].content[0].text, 'Compilation error: missing semicolon')
  // info 消息跳过：没有多余回合
  assert.equal(out.turns.length, 1)
  assertMessageOrderLegal(out.events)
})

test('convertGeminiJson: toolCalls 无 result 补发空 tool/result', () => {
  // 调用没有内联 result（geminiToolResultText 返回 null）→ 合成空 result 保证配对
  const raw = JSON.stringify({
    sessionId: 'gemini-cut-001',
    startTime: '2026-04-17T18:09:18.567Z',
    directories: ['D:\\demo\\gemini-proj'],
    messages: [
      { id: 'u1', type: 'user', content: [{ text: '跑一下' }] },
      {
        id: 'g1', type: 'gemini', content: '好',
        model: 'gemini-3-flash-preview',
        toolCalls: [
          { id: 'tc_01', name: 'run_shell_command', args: { command: 'npm test' }, status: 'success', result: [] },
        ],
      },
    ],
  })
  const out = convertGeminiJson(raw)
  assert.equal(out.toolCalls, 1)
  const result = out.events.find((e) => e.type === 'tool/result')
  assert.ok(result)
  assert.deepEqual(result.data.message.content[0].content, [])
  assert.equal(result.data.message.content[0].toolCallId, 'tc_01')
  assertToolPairing(out.events)
  assert.equal(out.events.at(-1).type, 'turn/end')
})

test('convertGeminiJson: 多轮切分、kind 缺失兼容', () => {
  const out = convertGeminiJson(load('gemini-multi-turn.json'))
  assert.equal(out.turns.length, 2)
  const starts = out.events.filter((e) => e.type === 'turn/start')
  assert.equal(starts.length, 2)
  const users = out.events.filter((e) => e.type === 'user/message')
  assert.equal(users.length, 2)
})

test('convertGeminiJson: 非法 JSON / 非会话结构返回空并 skipped', () => {
  const bad = convertGeminiJson('not json')
  assert.equal(bad.meta, null)
  assert.equal(bad.skipped, 1)
  const wrong = convertGeminiJson('{"foo":1}')
  assert.equal(wrong.meta, null)
  assert.equal(wrong.skipped, 1)
})

// ---- Reasonix ----

test('convertReasonixJsonl: v1 嵌套 tool_calls + tool_call_id 配对 + reasoning', () => {
  const out = convertReasonixJsonl(load('reasonix-v1.jsonl'), { reasonixId: 'desktop-202606020721-1', sourcePath: 'D:\\demo\\reasonix\\desktop-a.jsonl' })
  assert.equal(out.turns.length, 1)
  assert.equal(out.toolCalls, 1)
  assert.equal(out.meta.id, 'import-desktop-202606020721-1')
  assert.equal(out.meta.sourceId, 'desktop-202606020721-1')
  assertImportedMarker(out.events, { tool: 'reasonix', sourceId: 'desktop-202606020721-1', sourcePath: 'D:\\demo\\reasonix\\desktop-a.jsonl' })
  const types = out.events.map((e) => e.type)
  assert.equal([...types].reverse().find((t) => t !== 'session/title'), 'turn/end')
  out.events.forEach((e, i) => assert.equal(e.seq, i))
  // 工具调用与结果配对
  const call = out.events.find((e) => e.type === 'tool/call')
  assert.equal(call.data.name, 'search_files')
  assert.equal(call.data.arguments, '{"pattern": "codegraph"}')
  const result = out.events.find((e) => e.type === 'tool/result')
  assert.deepEqual(result.sourceEventSeqs, [call.seq])
  assert.equal(result.data.message.content[0].content[0].text, '找到了 codegraph v0.9.8')
  // reasoning_content → reasoning block
  const asst = out.events.filter((e) => e.type === 'assistant/message').map((e) => e.data.message)
  assert.ok(asst.some((m) => m.content.some((c) => c.type === 'reasoning')))
  // provider
  assert.deepEqual(asst[0].source, { kind: 'model', provider: 'reasonix', model: 'reasonix' })
  assertMessageOrderLegal(out.events)
})

test('convertReasonixJsonl: v2 扁平 tool_calls + createdAt 时间戳', () => {
  const out = convertReasonixJsonl(load('reasonix-v2.jsonl'), { reasonixId: 'desktop-202606020725-2', cwd: 'D:\\Reasonix', title: '查看当前编辑 xlsx 的 skill' })
  assert.equal(out.turns.length, 1)
  assert.equal(out.toolCalls, 1)
  assert.equal(out.meta.cwd, 'D:\\Reasonix')
  assert.equal(out.meta.createdAt, 1780325474978) // 取第一条消息的 createdAt
  const call = out.events.find((e) => e.type === 'tool/call')
  assert.equal(call.data.name, 'list_directory')
  const result = out.events.find((e) => e.type === 'tool/result')
  assert.deepEqual(result.sourceEventSeqs, [call.seq])
  // title 来自 meta.summary → session/title 事件
  const titleEv = out.events.find((e) => e.type === 'session/title')
  assert.equal(titleEv.data.title, '查看当前编辑 xlsx 的 skill')
})

test('convertReasonixJsonl: 多轮切分、畸形行计数', () => {
  const out = convertReasonixJsonl('not json\n' + load('reasonix-multi-turn.jsonl'), {})
  assert.equal(out.skipped, 1)
  assert.equal(out.turns.length, 2)
  const starts = out.events.filter((e) => e.type === 'turn/start')
  assert.equal(starts.length, 2)
  // 无 reasonixId 时退化为时间戳 id（仍合法）
  assert.match(out.meta.id, /^import-\d+$/)
})

test('convertReasonixJsonl: tool_calls 无 tool 消息补发空 tool/result', () => {
  // assistant 声明 tool_calls 但没有后续 role=tool 消息（会话中断）→ 合成空 result
  const raw = [
    '{"role":"user","content":"查一下"}',
    '{"role":"assistant","content":"好","tool_calls":[{"id":"call_rx_01","type":"function","function":{"name":"search_files","arguments":"{\\"q\\":\\"x\\"}"}}]}',
  ].join('\n')
  const out = convertReasonixJsonl(raw, { reasonixId: 'desktop-202606020799-9' })
  assert.equal(out.toolCalls, 1)
  const result = out.events.find((e) => e.type === 'tool/result')
  assert.ok(result)
  assert.deepEqual(result.data.message.content[0].content, [])
  assert.equal(result.data.message.content[0].toolCallId, 'call_rx_01')
  assertToolPairing(out.events)
  assert.equal(out.events.at(-1).type, 'turn/end')
})

test('convertReasonixJsonl: 转录无 createdAt 时回退文件名内嵌时间戳', () => {
  const out = convertReasonixJsonl(load('reasonix-v1.jsonl'), { reasonixId: 'desktop-202606020721-1' })
  // stem 内嵌 202606020721（本地时间）→ 2026-06-02 07:21，不再取导入时刻
  assert.equal(out.meta.createdAt, new Date(2026, 5, 2, 7, 21).getTime())
})

test('reasonixStemTime: desktop/subagent 命名解析、无或非法时间戳回退 null', () => {
  assert.equal(reasonixStemTime('desktop-202607020158-1'), new Date(2026, 6, 2, 1, 58).getTime())
  assert.equal(reasonixStemTime('subagent-sub-1-202606030923'), new Date(2026, 5, 3, 9, 23).getTime())
  assert.equal(reasonixStemTime('code-tmp'), null)
  assert.equal(reasonixStemTime('desktop-202613990000-1'), null) // 非法月份
})
// ---- opencode 会话（SQLite → 中间 JSON） ----

test('convertOpencodeJson: 简单问答、元数据、平衡回合', () => {
  const out = convertOpencodeJson(load('opencode-simple.json'), { sourcePath: 'E:/demo/opencode/opencode.db' })
  assert.equal(out.turns.length, 1)
  assert.equal(out.messages, 2)
  assert.equal(out.toolCalls, 0)
  assert.equal(out.meta.id, 'import-ses_simple001')
  assert.equal(out.meta.sourceId, 'ses_simple001')
  assert.equal(out.meta.version, SESSION_FORMAT_VERSION)
  assert.equal(out.meta.cwd, 'E:/demo/opencode-proj')
  assert.equal(out.meta.createdAt, 1786000000000)
  assert.equal(out.title, 'Fix the build')
  assertImportedMarker(out.events, { tool: 'opencode', sourceId: 'ses_simple001', sourcePath: 'E:/demo/opencode/opencode.db' })
  const types = out.events.map((e) => e.type)
  // 回合平衡：最后一个（非 title）事件是 turn/end；seq 连续
  assert.equal([...types].reverse().find((t) => t !== 'session/title'), 'turn/end')
  out.events.forEach((e, i) => assert.equal(e.seq, i))
  for (const e of out.events.filter((e) => e.type === 'user/message' || e.type === 'assistant/message' || e.type === 'tool/result')) {
    assert.equal(e.surfaceOp, 'append')
  }
  const user = out.events.find((e) => e.type === 'user/message').data
  assert.equal(user.content[0].text, '帮我看看构建失败的原因')
  // 消息级 model（字符串）优先于会话级 model
  const asst = out.events.find((e) => e.type === 'assistant/message').data.message
  assert.equal(asst.content[0].text, '是缺少依赖，补上即可。')
  assert.deepEqual(asst.source, { kind: 'model', provider: 'opencode', model: 'deepseek-v4-pro' })
  // title → session/title 事件
  const titleEv = out.events.find((e) => e.type === 'session/title')
  assert.equal(titleEv.data.title, 'Fix the build')
  assert.deepEqual(titleEv.data.source, { kind: 'user' })
})

test('convertOpencodeJson: reasoning + tool/call + tool/result（error 标记、sourceEventSeqs 关联）', () => {
  const out = convertOpencodeJson(load('opencode-tool.json'))
  assert.equal(out.turns.length, 1)
  assert.equal(out.toolCalls, 2)
  const calls = out.events.filter((e) => e.type === 'tool/call')
  const results = out.events.filter((e) => e.type === 'tool/result')
  assert.equal(calls.length, 2)
  assert.equal(results.length, 2)
  assert.equal(calls[0].data.name, 'bash')
  assert.equal(calls[0].data.callId, 'call_01')
  assert.equal(calls[0].data.arguments, '{"command":"cargo run"}')
  // 每个 result 通过 sourceEventSeqs 关联自己的 call
  assert.deepEqual(results[0].sourceEventSeqs, [calls[0].seq])
  assert.deepEqual(results[1].sourceEventSeqs, [calls[1].seq])
  assert.equal(results[0].data.message.content[0].toolCallId, 'call_01')
  assert.equal(results[0].data.message.content[0].content[0].text, "thread 'main' panicked at src/main.rs:12")
  assert.equal(results[0].data.message.content[0].isError, undefined)
  // 第二个工具是 error → isError 标记
  assert.equal(results[1].data.message.content[0].isError, true)
  assert.equal(results[1].data.message.content[0].content[0].text, 'error: compilation failed')
  // reasoning → reasoning block；tool-call 出现在 assistant content 里
  const asst = out.events.find((e) => e.type === 'assistant/message').data.message
  const kinds = asst.content.map((c) => c.type)
  assert.ok(kinds.includes('reasoning'))
  assert.ok(kinds.includes('text'))
  assert.ok(kinds.includes('tool-call'))
  assert.equal(asst.content.find((c) => c.type === 'reasoning').text, '先跑一下复现命令看崩溃栈。')
  // 平铺 modelID 优先
  assert.deepEqual(asst.source, { kind: 'model', provider: 'opencode', model: 'deepseek-v4-max' })
  assertMessageOrderLegal(out.events)
})

test('convertOpencodeJson: file/patch/subtask → text 块，结构块跳过，空 output 工具仍配对', () => {
  const out = convertOpencodeJson(load('opencode-extras.json'))
  assert.equal(out.turns.length, 1)
  assert.equal(out.toolCalls, 1)
  const asst = out.events.find((e) => e.type === 'assistant/message').data.message
  const texts = asst.content.filter((c) => c.type === 'text').map((c) => c.text)
  assert.ok(texts.includes('[image: diagram.png]'))
  assert.ok(texts.includes('[patch: 2 files]'))
  assert.ok(texts.includes('[subtask: npm test — 跑测试]'))
  // step-start / step-finish / compaction 不产生任何内容块
  assert.ok(!asst.content.some((c) => c.type === 'step-start' || c.type === 'step-finish' || c.type === 'compaction'))
  // 工具 state 无 output → 仍发 result（空文本），保持 call/result 配对
  const call = out.events.find((e) => e.type === 'tool/call')
  const result = out.events.find((e) => e.type === 'tool/result')
  assert.equal(call.data.arguments, '{"command":"git diff"}')
  assert.deepEqual(result.sourceEventSeqs, [call.seq])
  assert.equal(result.data.message.content[0].content[0].text, '')
  assert.equal(result.data.message.content[0].isError, undefined)
  // 空 output 已有 result → 兜底不重复补：call/result 严格 1:1
  assertToolPairing(out.events)
  // 消息无模型 → 回退会话级 model（对象解析 id）
  assert.deepEqual(asst.source, { kind: 'model', provider: 'opencode', model: 'deepseek-v4-flash' })
})

test('convertOpencodeJson: 模型回退链（msg.modelID → msg.model.modelID → session.model.id）', () => {
  const raw = JSON.stringify({
    id: 'ses_chain',
    createdAt: 1786000300000,
    model: { id: 'session-model', providerID: 'opencode-go' },
    messages: [
      { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
      { id: 'm2', role: 'assistant', model: { modelID: 'msg-object-model' }, parts: [{ type: 'text', text: 'a' }] },
      { id: 'm3', role: 'assistant', parts: [{ type: 'text', text: 'b' }] },
    ],
  })
  const out = convertOpencodeJson(raw)
  assert.equal(out.turns.length, 1) // 一个 user → 两个 assistant 步
  const sources = out.events.filter((e) => e.type === 'assistant/message').map((e) => e.data.message.source)
  assert.equal(sources[0].model, 'msg-object-model') // 消息级对象 modelID 优先
  assert.equal(sources[1].model, 'session-model') // 无消息级 → 会话级 id
  // 全程无消息级/会话级模型时回退 provider 名
  const bare = convertOpencodeJson(JSON.stringify({
    id: 'ses_bare',
    messages: [
      { id: 'b1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
      { id: 'b2', role: 'assistant', parts: [{ type: 'text', text: 'ok' }] },
    ],
  }))
  assert.equal(bare.events.find((e) => e.type === 'assistant/message').data.message.source.model, 'opencode')
})

test('convertOpencodeJson: 非法 JSON / 无 messages 返回空并 skipped（对齐 Gemini 失败形态）', () => {
  const bad = convertOpencodeJson('not json')
  assert.equal(bad.meta, null)
  assert.equal(bad.skipped, 1)
  assert.deepEqual(bad.events, [])
  assert.deepEqual(bad.turns, [])
  assert.equal(bad.messages, 0)
  assert.equal(bad.toolCalls, 0)
  const wrong = convertOpencodeJson('{"id":"x"}')
  assert.equal(wrong.meta, null)
  assert.equal(wrong.skipped, 1)
})

test('convertOpencodeJson: sessionId 覆盖参数生效、空 messages 不产生会话', () => {
  const out = convertOpencodeJson(load('opencode-simple.json'), { sessionId: 'custom-opencode' })
  assert.equal(out.meta.id, 'custom-opencode')
  const ids = out.events.filter((e) => e.type === 'user/message').map((e) => e.data.id)
  assert.ok(ids[0].startsWith('import:custom-opencode:u1'))
  // 无 messages → 空事件，由 index 层计 skipped
  const empty = convertOpencodeJson('{"id":"ses_empty","createdAt":1,"messages":[]}')
  assert.equal(empty.turns.length, 0)
  assert.equal(empty.events.length, 0)
})

test('convertOpencodeJson: 压缩摘要 summary → 首个 assistant 步骤前置 reasoning 块', () => {
  const raw = JSON.stringify({
    id: 'ses_comp',
    title: 'Long task',
    directory: 'E:/demo/opencode-proj',
    createdAt: 1786000000000,
    summary: '前面做过的所有事都被压成这段摘要。',
    messages: [
      { id: 'msg-c1', role: 'user', createdAt: 1, parts: [{ type: 'text', text: '继续' }] },
      { id: 'msg-c2', role: 'assistant', createdAt: 2, parts: [{ type: 'text', text: '好的' }] },
    ],
  })
  const out = convertOpencodeJson(raw)
  const firstStep = out.turns[0].steps[0]
  assert.equal(firstStep.content[0].type, 'reasoning')
  assert.equal(firstStep.content[0].text, '前面做过的所有事都被压成这段摘要。')
  // 摘要只前置一次，不重复
  const reasoning = out.events
    .filter((e) => e.type === 'assistant/message')
    .flatMap((e) => e.data.message.content)
    .filter((c) => c.type === 'reasoning')
  assert.equal(reasoning.length, 1)
})

// ---- tailSessionEvents（REQ-24 增量续写的事件级截取） ----

// 合成三回合 Claude transcript：turn1 文本问答、turn2 工具调用（call+result）、
// turn3 文本问答 + ai-title。
function threeTurnClaude() {
  return [
    '{"sessionId":"sess-incr-001","type":"user","message":{"role":"user","content":"第一个问题"}}',
    '{"sessionId":"sess-incr-001","type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"第一个回答"}]}}',
    '{"sessionId":"sess-incr-001","type":"user","message":{"role":"user","content":"第二个问题"}}',
    '{"sessionId":"sess-incr-001","type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"好"},{"type":"tool_use","id":"toolu_01","name":"Read","input":{"file":"a.txt"}}]}}',
    '{"sessionId":"sess-incr-001","type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_01","content":[{"type":"text","text":"A 内容"}]}]}}',
    '{"sessionId":"sess-incr-001","type":"user","message":{"role":"user","content":"第三个问题"}}',
    '{"sessionId":"sess-incr-001","type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"第三个回答"}]}}',
    '{"sessionId":"sess-incr-001","type":"ai-title","aiTitle":"三回合会话"}',
  ].join('\n')
}

test('tailSessionEvents: 按 turn 切片、seq 从 fromSeq 连续重编号、续号用源编号', () => {
  const out = convertClaudeJsonl(threeTurnClaude(), { sourcePath: 'D:\\demo\\proj\\sess-incr-001.jsonl' })
  assert.equal(out.turns.length, 3)
  const headCount = out.events.find((e) => e.type === 'turn/start' && e.data.turn === 2).seq
  const fromSeq = 40 // 模拟已存日志长度
  const tail = tailSessionEvents(out, { fromTurn: 2, fromSeq })
  assert.equal(tail.firstTurn, 2)
  assert.equal(tail.droppedBoundaryResults, 0)
  // 尾部不含 session/imported 标记与 session/title（续写不重复写标记/标题）
  assert.ok(!tail.events.some((e) => e.type === 'session/imported'))
  assert.ok(!tail.events.some((e) => e.type === 'session/title'))
  // seq 从 fromSeq 连续
  tail.events.forEach((e, i) => assert.equal(e.seq, fromSeq + i))
  // 第一个事件是 turn2 的 turn/start；turn 续号用源编号（2、3）
  assert.equal(tail.events[0].type, 'turn/start')
  assert.equal(tail.events[0].data.turn, 2)
  const starts = tail.events.filter((e) => e.type === 'turn/start').map((e) => e.data.turn)
  assert.deepEqual(starts, [2, 3])
  // 尾部以 turn/end 收尾（平衡）；surfaceOp 保留
  assert.equal(tail.events.at(-1).type, 'turn/end')
  const surface = tail.events.filter((e) => e.type === 'user/message' || e.type === 'assistant/message')
  assert.ok(surface.length > 0)
  for (const e of surface) assert.equal(e.surfaceOp, 'append')
  // 尾部事件集合 = 完整转换里 turn2 起的事件（session/title 被剥离）
  const headSeq = out.events.find((e) => e.type === 'turn/start' && e.data.turn === 2).seq
  const fromTurn2 = out.events.filter((e) => e.seq >= headSeq && e.type !== 'session/title')
  assert.equal(tail.events.length, fromTurn2.length)
  for (const [i, e] of fromTurn2.entries()) {
    assert.equal(tail.events[i].type, e.type)
    assert.deepEqual(tail.events[i].data, e.data)
  }
})

test('tailSessionEvents: 尾内 tool/result 的 sourceEventSeqs 重映射到新 seq', () => {
  const out = convertClaudeJsonl(threeTurnClaude(), { sourcePath: 'D:\\demo\\proj\\sess-incr-001.jsonl' })
  const tail = tailSessionEvents(out, { fromTurn: 2, fromSeq: 100 })
  const call = tail.events.find((e) => e.type === 'tool/call')
  const result = tail.events.find((e) => e.type === 'tool/result')
  assert.ok(call)
  assert.ok(result)
  assert.equal(call.data.callId, 'toolu_01')
  // 重映射后 result 指向尾内 call 的新 seq
  assert.deepEqual(result.sourceEventSeqs, [call.seq])
  // 尾部事件不引用旧 seq（全部落在 [fromSeq, fromSeq+len) 内）
  for (const e of tail.events) {
    if (Array.isArray(e.sourceEventSeqs)) {
      for (const s of e.sourceEventSeqs) assert.ok(s >= 100)
    }
  }
})

test('tailSessionEvents: dropSessionEvents=false 保留 session/title（标题 last-wins 无害）', () => {
  const out = convertClaudeJsonl(threeTurnClaude(), { sourcePath: 'D:\\demo\\proj\\sess-incr-001.jsonl' })
  const tail = tailSessionEvents(out, { fromTurn: 3, fromSeq: 200, dropSessionEvents: false })
  const titleEv = tail.events.find((e) => e.type === 'session/title')
  assert.ok(titleEv)
  assert.equal(titleEv.data.title, '三回合会话')
  assert.equal(titleEv.seq, tail.events.at(-1).seq) // title 钉在尾部末尾
  // 默认剥离
  const stripped = tailSessionEvents(out, { fromTurn: 3, fromSeq: 200 })
  assert.ok(!stripped.events.some((e) => e.type === 'session/title'))
})

test('tailSessionEvents: 指向尾外的 sourceEventSeqs 原样保留并计 droppedBoundaryResults', () => {
  // 合成一个跨界场景：turn2 的 tool/result 引用 turn1 的 tool/call（跨轮异步结果）。
  // 手工构造 converted 事件：turn1 含 call（seq 5），turn2 含 result（sourceEventSeqs=[5]）。
  const ev = (type, seq, data, extra) => ({ type, seq, data, ...extra })
  const converted = {
    events: [
      ev('session/imported', 0, {}),
      ev('turn/start', 1, { turn: 1 }),
      ev('user/message', 2, {}, { surfaceOp: 'append' }),
      ev('assistant/message', 3, {}, { surfaceOp: 'append' }),
      ev('tool/call', 4, { callId: 'toolu_x' }),
      ev('turn/end', 5, { turn: 1 }),
      ev('turn/start', 6, { turn: 2 }),
      ev('user/message', 7, {}, { surfaceOp: 'append' }),
      ev('tool/result', 8, { toolCallId: 'toolu_x' }, { surfaceOp: 'append', sourceEventSeqs: [4] }),
      ev('turn/end', 9, { turn: 2 }),
    ],
    turns: [{}, {}],
  }
  const tail = tailSessionEvents(converted, { fromTurn: 2, fromSeq: 50 })
  assert.equal(tail.droppedBoundaryResults, 1)
  const result = tail.events.find((e) => e.type === 'tool/result')
  // 指向尾外的引用原样保留（前段 seq 未变，旧值仍指向真实调用）
  assert.deepEqual(result.sourceEventSeqs, [4])
  assert.deepEqual(tail.events.map((e) => e.seq), [50, 51, 52, 53])
})
