// convert.test.mjs — 纯转换逻辑单元测试（无宿主依赖）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { convertClaudeJsonl, convertCodexJsonl, convertChatgptJson, convertCursorJsonl, convertGeminiJson, convertReasonixJsonl, reasonixStemTime, mintSessionId, parseTime, SESSION_FORMAT_VERSION } from '../convert.mjs'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const load = (name) => readFileSync(join(fixtures, name), 'utf8')

test('convertClaudeJsonl: 简单问答合成平衡回合', () => {
  const out = convertClaudeJsonl(load('sess-simple-001.jsonl'))
  assert.equal(out.turns.length, 1)
  assert.equal(out.messages, 2)
  assert.equal(out.toolCalls, 0)
  assert.equal(out.meta.id, 'import-sess-simple-001')
  assert.equal(out.meta.version, SESSION_FORMAT_VERSION)
  assert.equal(out.meta.cwd, 'D:\\demo\\proj')
  assert.ok(out.meta.createdAt)

  const types = out.events.map((e) => e.type)
  assert.deepEqual(types, [
    'turn/start', 'step/start', 'user/message', 'assistant/message', 'step/end', 'turn/end',
  ])
  // seq 连续从 0 开始
  out.events.forEach((e, i) => assert.equal(e.seq, i))
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
  const out = convertClaudeJsonl(load('sess-empty-001.jsonl'))
  assert.equal(out.turns.length, 1)
  assert.equal(out.messages, 1)
  const types = out.events.map((e) => e.type)
  assert.deepEqual(types, ['turn/start', 'user/message', 'turn/end'])
})

test('convertClaudeJsonl: sessionId 覆盖参数生效', () => {
  const out = convertClaudeJsonl(load('sess-simple-001.jsonl'), { sessionId: 'custom-id' })
  assert.equal(out.meta.id, 'custom-id')
  const ids = out.events.filter((e) => e.type === 'user/message').map((e) => e.data.id)
  assert.ok(ids[0].startsWith('import:custom-id:u1'))
})

test('convertClaudeJsonl: 空输入不产生事件', () => {
  const out = convertClaudeJsonl('')
  assert.equal(out.events.length, 0)
  assert.equal(out.turns.length, 0)
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

test('convertClaudeJsonl: 跨 step 的 tool/result 仍用 sourceEventSeqs 关联其 tool/call', () => {
  // 异步工具：调用在 step1，结果随后续 step2 到达；sourceEventSeqs 必须跨 step 关联
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
  assert.equal(result.data.step, 2)
  assert.deepEqual(result.sourceEventSeqs, [call.seq])
  assert.equal(result.surfaceOp, 'append')
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
  const out = convertCodexJsonl(load('codex-simple.jsonl'))
  assert.equal(out.turns.length, 1)
  assert.equal(out.messages, 2)
  assert.equal(out.toolCalls, 0)
  assert.equal(out.meta.id, 'import-019e3b3f-636d-7cb3-aaab-0255eb45ad4f')
  assert.equal(out.meta.version, SESSION_FORMAT_VERSION)
  assert.equal(out.meta.cwd, 'D:\\demo\\codex-proj')
  assert.ok(out.meta.createdAt)

  const types = out.events.map((e) => e.type)
  assert.deepEqual(types, [
    'turn/start', 'step/start', 'user/message', 'assistant/message', 'step/end', 'turn/end',
  ])
  // seq 连续从 0 开始；最后一个事件是 turn/end（平衡）
  out.events.forEach((e, i) => assert.equal(e.seq, i))
  assert.equal(types.at(-1), 'turn/end')
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
  const out = convertChatgptJson(load('chatgpt-export.json'))
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

// ---- Cursor agent transcript ----

test('convertCursorJsonl: 简单问答、user_query 剥离、平衡回合', () => {
  const out = convertCursorJsonl(load('cursor-simple.jsonl'), { cursorId: 'abc123' })
  assert.equal(out.turns.length, 1)
  assert.equal(out.messages, 3) // user + assistant×2
  assert.equal(out.toolCalls, 0)
  assert.equal(out.meta.id, 'import-abc123') // cursorId 传入
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

test('convertCursorJsonl: tool_use → tool/call（无 tool_result），input 对象序列化', () => {
  const out = convertCursorJsonl(load('cursor-tool.jsonl'))
  assert.equal(out.toolCalls, 2)
  const calls = out.events.filter((e) => e.type === 'tool/call')
  assert.equal(calls[0].data.name, 'Glob')
  assert.equal(calls[0].data.arguments, '{"target_directory":".","glob_pattern":"**/*.rs"}')
  assert.equal(calls[1].data.name, 'Read')
  // transcript 不含 tool_result：没有 tool/result 事件
  assert.equal(out.events.filter((e) => e.type === 'tool/result').length, 0)
  // 平衡：最后（非 title）事件是 turn/end
  const types = out.events.map((e) => e.type)
  assert.equal([...types].reverse().find((t) => t !== 'session/title'), 'turn/end')
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
  const out = convertGeminiJson(load('gemini-simple.json'))
  assert.equal(out.turns.length, 1)
  assert.equal(out.messages, 2)
  assert.equal(out.toolCalls, 0)
  assert.equal(out.meta.id, 'import-b26d7f99-0116-4d1d-b125-98c228a4b933')
  assert.equal(out.meta.cwd, 'D:\\demo\\gemini-proj') // directories[0] → cwd
  assert.ok(out.meta.createdAt) // startTime ISO → ms
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
  const out = convertReasonixJsonl(load('reasonix-v1.jsonl'), { reasonixId: 'desktop-202606020721-1' })
  assert.equal(out.turns.length, 1)
  assert.equal(out.toolCalls, 1)
  assert.equal(out.meta.id, 'import-desktop-202606020721-1')
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
