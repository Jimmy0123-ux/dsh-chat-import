// index.test.mjs — 插件级集成测试：mock ctx（fs / sessionPersistence / tools / workspaceRegistry），
// 走真实的 apply → register → execute 路径，并校验返回值符合输出 schema。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { apply, readOpencodeDb } from '../index.mjs'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const load = (name) => readFileSync(join(fixtures, name), 'utf8')

// 内存态会话库：create/append/list，模拟 sessionPersistence。
function makePersistence() {
  const sessions = new Map() // id -> { meta, events: [] }
  return {
    sessions,
    async list() { return [...sessions.values()].map((s) => s.meta) },
    async create(meta) {
      if (sessions.has(meta.id)) throw new Error('duplicate session ' + meta.id)
      sessions.set(meta.id, { meta, events: [] })
    },
    async append(id, events) {
      const s = sessions.get(id)
      if (!s) throw new Error('unknown session ' + id)
      s.events.push(...events)
    },
  }
}

// 目录树：path -> 'dir' | content
function makeCtx(tree) {
  const persistence = makePersistence()
  const attached = []
  const workspaces = new Map()
  const registered = []
  const entriesCache = new Map()

  const fs = {
    async resolve(path) { return { targetKey: path, displayPath: path } },
    async stat(target) {
      const v = tree[target.targetKey]
      if (v === undefined) return undefined
      return { type: v === 'dir' ? 'directory' : 'file', version: 1 }
    },
    async readText(target) {
      const v = tree[target.targetKey]
      if (v === undefined || v === 'dir') throw new Error('FS_NOT_FOUND ' + target.targetKey)
      return v
    },
    async listDir(target) {
      if (!entriesCache.has(target.targetKey)) {
        const entries = []
        const prefix = target.targetKey.endsWith('\\') ? target.targetKey : target.targetKey + '\\'
        for (const [path, v] of Object.entries(tree)) {
          if (path.startsWith(prefix) && path !== prefix) {
            const rest = path.slice(prefix.length)
            if (!rest.includes('\\')) {
              entries.push({
                name: rest,
                type: v === 'dir' ? 'directory' : 'file',
                target: { targetKey: path, displayPath: path },
                version: 1,
              })
            }
          }
        }
        entriesCache.set(target.targetKey, entries.sort((a, b) => a.name.localeCompare(b.name)))
      }
      return entriesCache.get(target.targetKey)
    },
    processPath(target) { return target.targetKey },
  }

  const workspaceRegistry = {
    async resolveByPath(p) { return workspaces.get(p) ?? null },
    async create(p) { const ws = { path: p, attachSession: async (id) => attached.push({ ws: p, id }) }; workspaces.set(p, ws); return ws },
  }

  const ctx = {
    fs,
    sessionPersistence: persistence,
    get(service) {
      if (service === 'workspaceRegistry') return workspaceRegistry
      return undefined
    },
    tools: {
      register(def) { registered.push(def); return () => {} },
    },
  }
  // 测试辅助：按名字取出注册的工具定义
  ctx.tools.registered = (toolName) => registered.find((d) => d.name === toolName)
  return { ctx, persistence, attached, registered }
}

test('apply 注册七个导入工具（single + batch 输出 schema）', () => {
  const { ctx, registered } = makeCtx({})
  apply(ctx)
  assert.equal(registered.length, 7)
  const names = registered.map((d) => d.name).sort()
  assert.deepEqual(names, ['import_chatgpt', 'import_claude', 'import_codex', 'import_cursor', 'import_gemini', 'import_opencode', 'import_reasonix'])
  for (const def of registered) {
    // 输出 schema 是 oneOf（单文件 / 批量）
    assert.ok(Array.isArray(def.output.schema.oneOf))
    assert.equal(def.output.schema.oneOf.length, 2)
  }
})

test('单文件导入：落盘、归组、返回值符合 schema', async () => {
  const simple = load('sess-simple-001.jsonl')
  const { ctx, persistence, attached } = makeCtx({ 'D:\\demo\\proj\\sess-simple-001.jsonl': simple })
  apply(ctx)
  const def = ctx.tools.register.calls ?? registeredDef(ctx)
  const value = await def.execute({ path: 'D:\\demo\\proj\\sess-simple-001.jsonl' })

  assert.equal(value.mode, 'single')
  assert.equal(value.sessionId, 'import-sess-simple-001')
  assert.equal(value.turns, 1)
  assert.equal(value.messages, 2)
  assert.equal(value.toolCalls, 0)
  assert.equal(value.alreadyImported, false)

  // 输出 schema 校验通过（含 turns 为 integer 而非数组）
  const violations = validateJsonSchemaValue(def.output.schema, value)
  assert.deepEqual(violations, [])

  // 落盘：meta + 平衡事件
  const saved = persistence.sessions.get('import-sess-simple-001')
  assert.ok(saved)
  assert.equal(saved.meta.cwd, 'D:\\demo\\proj')
  assert.equal(saved.events.at(-1).type, 'turn/end')
  assert.ok(saved.events.every((e, i) => e.seq === i))

  // 归组
  assert.equal(attached.length, 1)
  assert.equal(attached[0].id, 'import-sess-simple-001')
})

test('幂等：重复导入同一文件返回 alreadyImported 且不重复落盘', async () => {
  const simple = load('sess-simple-001.jsonl')
  const { ctx, persistence } = makeCtx({ 'D:\\demo\\proj\\sess-simple-001.jsonl': simple })
  apply(ctx)
  const def = registeredDef(ctx)
  const first = await def.execute({ path: 'D:\\demo\\proj\\sess-simple-001.jsonl' })
  const second = await def.execute({ path: 'D:\\demo\\proj\\sess-simple-001.jsonl' })
  assert.equal(first.alreadyImported, false)
  assert.equal(second.alreadyImported, true)
  assert.equal(persistence.sessions.size, 1)
})

test('单文件导入工具历史：tool/result 带 sourceEventSeqs', async () => {
  const { ctx } = makeCtx({ 'D:\\demo\\proj\\sess-tool-001.jsonl': load('sess-tool-001.jsonl') })
  apply(ctx)
  const def = registeredDef(ctx)
  const value = await def.execute({ path: 'D:\\demo\\proj\\sess-tool-001.jsonl' })
  assert.equal(value.mode, 'single')
  assert.equal(value.toolCalls, 1)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
})

test('目录批量导入：扫描 .jsonl、逐文件独立会话、跳过非 transcript、汇总符合 schema', async () => {
  const tree = {
    'D:\\demo\\proj': 'dir',
    'D:\\demo\\proj\\sess-simple-001.jsonl': load('sess-simple-001.jsonl'),
    'D:\\demo\\proj\\sess-tool-001.jsonl': load('sess-tool-001.jsonl'),
    'D:\\demo\\proj\\notes.txt': 'not a transcript',
    'D:\\demo\\proj\\sub': 'dir',
    'D:\\demo\\proj\\sub\\sess-title-001.jsonl': load('sess-title-001.jsonl'),
  }
  const { ctx, persistence, attached } = makeCtx(tree)
  apply(ctx)
  const def = registeredDef(ctx)
  const value = await def.execute({ path: 'D:\\demo\\proj' })

  assert.equal(value.mode, 'batch')
  assert.equal(value.total, 3) // a/b/c 三个 .jsonl（notes.txt 被过滤）
  assert.equal(value.imported, 3)
  assert.equal(value.alreadyImported, 0)
  assert.equal(value.failed, 0)
  assert.equal(value.results.length, 3)
  const ids = value.results.map((r) => r.sessionId).sort()
  assert.deepEqual(ids, ['import-sess-simple-001', 'import-sess-title-001', 'import-sess-tool-001'])

  // 每个会话独立落盘 + 归组
  assert.equal(persistence.sessions.size, 3)
  assert.equal(attached.length, 3)

  // 输出 schema 校验
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
})

test('目录批量导入：递归参数（false 时不进子目录）', async () => {
  const tree = {
    'D:\\demo\\proj': 'dir',
    'D:\\demo\\proj\\sess-simple-001.jsonl': load('sess-simple-001.jsonl'),
    'D:\\demo\\proj\\sub': 'dir',
    'D:\\demo\\proj\\sub\\sess-title-001.jsonl': load('sess-title-001.jsonl'),
  }
  const { ctx } = makeCtx(tree)
  apply(ctx)
  const def = registeredDef(ctx)
  const value = await def.execute({ path: 'D:\\demo\\proj', recursive: false })
  assert.equal(value.mode, 'batch')
  assert.equal(value.total, 1) // 只扫顶层 sess-simple-001.jsonl
  assert.deepEqual(value.results.map((r) => r.sessionId), ['import-sess-simple-001'])
})

test('目录批量导入：已存在会话计入 alreadyImported', async () => {
  const tree = {
    'D:\\demo\\proj': 'dir',
    'D:\\demo\\proj\\sess-simple-001.jsonl': load('sess-simple-001.jsonl'),
  }
  const { ctx, persistence } = makeCtx(tree)
  apply(ctx)
  const def = registeredDef(ctx)
  await def.execute({ path: 'D:\\demo\\proj' })
  const second = await def.execute({ path: 'D:\\demo\\proj' })
  assert.equal(second.mode, 'batch')
  assert.equal(second.imported, 0)
  assert.equal(second.alreadyImported, 1)
  assert.equal(persistence.sessions.size, 1)
})

test('批量导入：空文件/无内容文件计入 skipped 而非 failed', async () => {
  const tree = {
    'D:\\demo\\proj': 'dir',
    'D:\\demo\\proj\\empty.jsonl': '',
  }
  const { ctx } = makeCtx(tree)
  apply(ctx)
  const def = registeredDef(ctx)
  const value = await def.execute({ path: 'D:\\demo\\proj' })
  assert.equal(value.mode, 'batch')
  assert.equal(value.total, 1)
  assert.equal(value.skipped, 1)
  assert.equal(value.results[0].status, 'skipped')
})

test('目录批量导入：subagent 辅助 transcript 跳过，主 transcript 完整导入', async () => {
  // Claude Code 项目目录：<sessionId>.jsonl 主 transcript + <sessionId>/subagents/agent-*.jsonl
  // 辅助 transcript（记录携带父 sessionId）。辅助文件不得建会话（否则与主 transcript 撞 id、
  // 先扫描者胜导致主内容丢失），只导入主 transcript。
  const tree = {
    'D:\\demo\\proj': 'dir',
    'D:\\demo\\proj\\sess-simple-001.jsonl': load('sess-simple-001.jsonl'),
    'D:\\demo\\proj\\sess-simple-001': 'dir',
    'D:\\demo\\proj\\sess-simple-001\\subagents': 'dir',
    'D:\\demo\\proj\\sess-simple-001\\subagents\\agent-abc123.jsonl': load('sess-simple-001.jsonl'),
  }
  const { ctx, persistence } = makeCtx(tree)
  apply(ctx)
  const def = registeredDef(ctx)
  const value = await def.execute({ path: 'D:\\demo\\proj' })

  assert.equal(value.mode, 'batch')
  assert.equal(value.total, 2)
  assert.equal(value.imported, 1)
  assert.equal(value.skipped, 1)
  assert.equal(value.failed, 0)
  const skipped = value.results.find((r) => r.status === 'skipped')
  assert.ok(skipped)
  assert.ok(skipped.reason.includes('auxiliary'))
  assert.ok(skipped.path.includes('agent-abc123.jsonl'))
  // 只有主 transcript 落盘，且内容完整（user + assistant 各 1）
  assert.equal(persistence.sessions.size, 1)
  const saved = persistence.sessions.get('import-sess-simple-001')
  assert.ok(saved)
  assert.equal(saved.events.filter((e) => e.type === 'user/message').length, 1)
  assert.equal(saved.events.filter((e) => e.type === 'assistant/message').length, 1)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
})

test('单文件导入辅助 transcript：跳过并返回 skipReason', async () => {
  const { ctx, persistence } = makeCtx({ 'D:\\demo\\proj\\agent-abc123.jsonl': load('sess-simple-001.jsonl') })
  apply(ctx)
  const def = registeredDef(ctx)
  const value = await def.execute({ path: 'D:\\demo\\proj\\agent-abc123.jsonl' })
  assert.equal(value.mode, 'single')
  assert.equal(value.sessionId, 'none')
  assert.equal(value.turns, 0)
  assert.equal(value.skipped, 1)
  assert.ok(value.skipReason.includes('auxiliary'))
  assert.equal(persistence.sessions.size, 0)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
})

// ---- import_codex 集成 ----

test('import_codex 单文件导入：落盘、归组、返回值符合 schema', async () => {
  const { ctx, persistence, attached } = makeCtx({ 'D:\\demo\\codex\\simple.jsonl': load('codex-simple.jsonl') })
  apply(ctx)
  const def = registeredDef(ctx, 'import_codex')
  const value = await def.execute({ path: 'D:\\demo\\codex\\simple.jsonl' })

  assert.equal(value.mode, 'single')
  assert.equal(value.sessionId, 'import-019e3b3f-636d-7cb3-aaab-0255eb45ad4f')
  assert.equal(value.turns, 1)
  assert.equal(value.messages, 2)
  assert.equal(value.toolCalls, 0)
  assert.equal(value.alreadyImported, false)

  const violations = validateJsonSchemaValue(def.output.schema, value)
  assert.deepEqual(violations, [])

  const saved = persistence.sessions.get('import-019e3b3f-636d-7cb3-aaab-0255eb45ad4f')
  assert.ok(saved)
  assert.equal(saved.meta.cwd, 'D:\\demo\\codex-proj')
  assert.equal(saved.events.at(-1).type, 'turn/end')
  assert.ok(saved.events.every((e, i) => e.seq === i))
  assert.equal(attached.length, 1)
  assert.equal(attached[0].id, 'import-019e3b3f-636d-7cb3-aaab-0255eb45ad4f')
})

test('import_codex 工具历史：tool/result 带 sourceEventSeqs 且 output 落盘', async () => {
  const { ctx, persistence } = makeCtx({ 'D:\\demo\\codex\\tool.jsonl': load('codex-tool.jsonl') })
  apply(ctx)
  const def = registeredDef(ctx, 'import_codex')
  const value = await def.execute({ path: 'D:\\demo\\codex\\tool.jsonl' })
  assert.equal(value.mode, 'single')
  assert.equal(value.toolCalls, 1)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])

  const saved = persistence.sessions.get(value.sessionId)
  const result = saved.events.find((e) => e.type === 'tool/result')
  assert.ok(result)
  assert.equal(result.data.message.content[0].content[0].text, 'README.md\nsrc\n')
})

test('import_codex 目录批量导入：递归扫描、逐文件独立会话、schema 校验', async () => {
  const tree = {
    'D:\\demo\\codex': 'dir',
    'D:\\demo\\codex\\a.jsonl': load('codex-simple.jsonl'),
    'D:\\demo\\codex\\b.jsonl': load('codex-tool.jsonl'),
  }
  const { ctx, persistence, attached } = makeCtx(tree)
  apply(ctx)
  const def = registeredDef(ctx, 'import_codex')
  const value = await def.execute({ path: 'D:\\demo\\codex' })

  assert.equal(value.mode, 'batch')
  assert.equal(value.total, 2)
  assert.equal(value.imported, 2)
  assert.equal(value.alreadyImported, 0)
  assert.equal(value.failed, 0)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
  assert.equal(persistence.sessions.size, 2)
  assert.equal(attached.length, 2)
})

test('import_codex 幂等：重复导入同一文件已存在则跳过', async () => {
  const { ctx, persistence } = makeCtx({ 'D:\\demo\\codex\\a.jsonl': load('codex-simple.jsonl') })
  apply(ctx)
  const def = registeredDef(ctx, 'import_codex')
  const first = await def.execute({ path: 'D:\\demo\\codex\\a.jsonl' })
  const second = await def.execute({ path: 'D:\\demo\\codex\\a.jsonl' })
  assert.equal(first.alreadyImported, false)
  assert.equal(second.alreadyImported, true)
  assert.equal(persistence.sessions.size, 1)
})

// ---- import_chatgpt 集成 ----

test('import_chatgpt 单文件：一文件多会话、恒返回 batch、schema 校验', async () => {
  const { ctx, persistence, attached } = makeCtx({ 'D:\\demo\\chatgpt\\conversations.json': load('chatgpt-export.json') })
  apply(ctx)
  const def = registeredDef(ctx, 'import_chatgpt')
  const value = await def.execute({ path: 'D:\\demo\\chatgpt\\conversations.json' })

  assert.equal(value.mode, 'batch') // 单文件也恒 batch
  assert.equal(value.total, 3) // 3 个会话（含 1 个被跳过的 system-only）
  assert.equal(value.imported, 2)
  assert.equal(value.skipped, 1)
  assert.equal(value.failed, 0)
  assert.equal(value.results.length, 2)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])

  const saved1 = persistence.sessions.get('import-conv-001')
  const saved2 = persistence.sessions.get('import-conv-002')
  assert.ok(saved1)
  assert.ok(saved2)
  assert.equal(saved1.events.at(-1).type, 'session/title')
  assert.ok(saved1.events.every((e, i) => e.seq === i))
  // ChatGPT 无 cwd → 不归组
  assert.equal(attached.length, 0)
})

test('import_chatgpt 幂等：重复导入同一文件只落盘一次', async () => {
  const { ctx, persistence } = makeCtx({ 'D:\\demo\\chatgpt\\conversations.json': load('chatgpt-export.json') })
  apply(ctx)
  const def = registeredDef(ctx, 'import_chatgpt')
  const first = await def.execute({ path: 'D:\\demo\\chatgpt\\conversations.json' })
  const second = await def.execute({ path: 'D:\\demo\\chatgpt\\conversations.json' })
  assert.equal(first.imported, 2)
  assert.equal(second.imported, 0)
  assert.equal(second.alreadyImported, 2)
  assert.equal(persistence.sessions.size, 2)
})

test('import_chatgpt 目录模式：扫描 .json（非 .jsonl）、递归汇总', async () => {
  const tree = {
    'D:\\demo\\chatgpt': 'dir',
    'D:\\demo\\chatgpt\\conversations.json': load('chatgpt-export.json'),
    'D:\\demo\\chatgpt\\sub': 'dir',
    'D:\\demo\\chatgpt\\sub\\more.json': '[{"id":"conv-010","title":"Extra","create_time":1710020000,"mapping":{"x1":{"id":"x1","message":{"id":"mx1","author":{"role":"user"},"content":{"content_type":"text","parts":["hi"]},"create_time":1710020000},"parent":null,"children":[]}}}]',
    'D:\\demo\\chatgpt\\notes.txt': 'not json',
  }
  const { ctx, persistence } = makeCtx(tree)
  apply(ctx)
  const def = registeredDef(ctx, 'import_chatgpt')
  const value = await def.execute({ path: 'D:\\demo\\chatgpt' })

  assert.equal(value.mode, 'batch')
  assert.equal(value.imported, 3) // conv-001 + conv-002 + conv-010
  assert.equal(value.skipped, 1) // system-only 会话
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
  assert.equal(persistence.sessions.size, 3)
})

test('import_chatgpt 非法 JSON：计入 skipped 而非 failed', async () => {
  const { ctx } = makeCtx({ 'D:\\demo\\chatgpt\\bad.json': 'not json' })
  apply(ctx)
  const def = registeredDef(ctx, 'import_chatgpt')
  const value = await def.execute({ path: 'D:\\demo\\chatgpt\\bad.json' })
  assert.equal(value.mode, 'batch')
  assert.equal(value.total, 1)
  assert.equal(value.skipped, 1)
  assert.equal(value.failed, 0)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
})

// ---- import_cursor 集成 ----

test('import_cursor 单文件：composer id 从文件名派生、落盘、schema 校验', async () => {
  const { ctx, persistence } = makeCtx({ 'D:\\demo\\cursor\\composer-abc.jsonl': load('cursor-simple.jsonl') })
  apply(ctx)
  const def = registeredDef(ctx, 'import_cursor')
  const value = await def.execute({ path: 'D:\\demo\\cursor\\composer-abc.jsonl' })

  assert.equal(value.mode, 'single')
  assert.equal(value.sessionId, 'import-composer-abc') // 文件名（去 .jsonl）→ composer id
  assert.equal(value.turns, 1)
  assert.equal(value.messages, 3)
  assert.equal(value.alreadyImported, false)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])

  const saved = persistence.sessions.get('import-composer-abc')
  assert.ok(saved)
  assert.equal(saved.events.at(-1).type, 'turn/end') // Cursor 无 title，事件以 turn/end 收尾
  assert.ok(saved.events.every((e, i) => e.seq === i))
})

test('import_cursor 幂等：同名 composer 文件不重复落盘', async () => {
  const { ctx, persistence } = makeCtx({ 'D:\\demo\\cursor\\composer-abc.jsonl': load('cursor-simple.jsonl') })
  apply(ctx)
  const def = registeredDef(ctx, 'import_cursor')
  const first = await def.execute({ path: 'D:\\demo\\cursor\\composer-abc.jsonl' })
  const second = await def.execute({ path: 'D:\\demo\\cursor\\composer-abc.jsonl' })
  assert.equal(first.alreadyImported, false)
  assert.equal(second.alreadyImported, true)
  assert.equal(persistence.sessions.size, 1)
})

test('import_cursor 目录模式：递归扫描 .jsonl、逐文件独立会话', async () => {
  const tree = {
    'D:\\demo\\cursor': 'dir',
    'D:\\demo\\cursor\\composer-a.jsonl': load('cursor-simple.jsonl'),
    'D:\\demo\\cursor\\sub': 'dir',
    'D:\\demo\\cursor\\sub\\composer-b.jsonl': load('cursor-tool.jsonl'),
  }
  const { ctx, persistence } = makeCtx(tree)
  apply(ctx)
  const def = registeredDef(ctx, 'import_cursor')
  const value = await def.execute({ path: 'D:\\demo\\cursor' })

  assert.equal(value.mode, 'batch')
  assert.equal(value.total, 2)
  assert.equal(value.imported, 2)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
  const ids = [...persistence.sessions.keys()].sort()
  assert.deepEqual(ids, ['import-composer-a', 'import-composer-b'])
})

// ---- import_gemini 集成 ----

test('import_gemini 单文件：落盘、归组、schema 校验', async () => {
  const { ctx, persistence, attached } = makeCtx({ 'D:\\demo\\gemini\\session-abc.json': load('gemini-simple.json') })
  apply(ctx)
  const def = registeredDef(ctx, 'import_gemini')
  const value = await def.execute({ path: 'D:\\demo\\gemini\\session-abc.json' })

  assert.equal(value.mode, 'single')
  assert.equal(value.sessionId, 'import-b26d7f99-0116-4d1d-b125-98c228a4b933')
  assert.equal(value.turns, 1)
  assert.equal(value.alreadyImported, false)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])

  const saved = persistence.sessions.get('import-b26d7f99-0116-4d1d-b125-98c228a4b933')
  assert.ok(saved)
  assert.equal(saved.meta.cwd, 'D:\\demo\\gemini-proj')
  assert.equal(saved.events.at(-1).type, 'turn/end')
  assert.ok(saved.events.every((e, i) => e.seq === i))
  // Gemini 有 cwd → 归组
  assert.equal(attached.length, 1)
})

test('import_gemini 工具历史：内联 tool/result 落盘', async () => {
  const { ctx, persistence } = makeCtx({ 'D:\\demo\\gemini\\session-tool.json': load('gemini-tool.json') })
  apply(ctx)
  const def = registeredDef(ctx, 'import_gemini')
  const value = await def.execute({ path: 'D:\\demo\\gemini\\session-tool.json' })
  assert.equal(value.toolCalls, 2)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])

  const saved = persistence.sessions.get(value.sessionId)
  const results = saved.events.filter((e) => e.type === 'tool/result')
  assert.equal(results.length, 2)
  assert.equal(results[0].data.message.content[0].content[0].text, 'src\nCargo.toml')
  assert.equal(results[1].data.message.content[0].isError, true)
})

test('import_gemini 目录模式：扫描 .json、递归、逐文件独立会话', async () => {
  const tree = {
    'D:\\demo\\gemini': 'dir',
    'D:\\demo\\gemini\\session-a.json': load('gemini-simple.json'),
    'D:\\demo\\gemini\\sub': 'dir',
    'D:\\demo\\gemini\\sub\\session-b.json': load('gemini-multi-turn.json'),
  }
  const { ctx, persistence } = makeCtx(tree)
  apply(ctx)
  const def = registeredDef(ctx, 'import_gemini')
  const value = await def.execute({ path: 'D:\\demo\\gemini' })

  assert.equal(value.mode, 'batch')
  assert.equal(value.total, 2)
  assert.equal(value.imported, 2)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
  assert.equal(persistence.sessions.size, 2)
})

test('import_gemini 非法 JSON：单文件计入 skipped 不落盘', async () => {
  const { ctx, persistence } = makeCtx({ 'D:\\demo\\gemini\\bad.json': 'not json' })
  apply(ctx)
  const def = registeredDef(ctx, 'import_gemini')
  const value = await def.execute({ path: 'D:\\demo\\gemini\\bad.json' })
  assert.equal(value.mode, 'single')
  assert.equal(value.skipped, 1)
  assert.equal(persistence.sessions.size, 0)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
})

// ---- import_reasonix 集成 ----

test('import_reasonix 单文件：meta 派生 cwd/标题、落盘、schema 校验', async () => {
  const { ctx, persistence, attached } = makeCtx({
    'D:\\demo\\reasonix\\desktop-v2.jsonl': load('reasonix-v2.jsonl'),
    'D:\\demo\\reasonix\\desktop-v2.meta.json': load('reasonix-v2.meta.json'),
  })
  apply(ctx)
  const def = registeredDef(ctx, 'import_reasonix')
  const value = await def.execute({ path: 'D:\\demo\\reasonix\\desktop-v2.jsonl' })

  assert.equal(value.mode, 'single')
  assert.equal(value.sessionId, 'import-desktop-v2') // 文件名 stem
  assert.equal(value.turns, 1)
  assert.equal(value.toolCalls, 1)
  assert.equal(value.alreadyImported, false)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])

  const saved = persistence.sessions.get('import-desktop-v2')
  assert.ok(saved)
  assert.equal(saved.meta.cwd, 'D:\\Reasonix') // meta.workspace → cwd
  assert.equal(saved.events.at(-1).type, 'session/title') // meta.summary → 标题
  assert.ok(saved.events.every((e, i) => e.seq === i))
  // cwd → 归组
  assert.equal(attached.length, 1)
  assert.equal(attached[0].id, 'import-desktop-v2')
})

test('import_reasonix 目录模式：递归扫描、排除 WAL 伴生文件、逐文件独立会话', async () => {
  const tree = {
    'D:\\demo\\reasonix': 'dir',
    'D:\\demo\\reasonix\\desktop-a.jsonl': load('reasonix-v1.jsonl'),
    'D:\\demo\\reasonix\\desktop-a.jsonl.bak': load('reasonix-v1.jsonl'),
    'D:\\demo\\reasonix\\sub': 'dir',
    'D:\\demo\\reasonix\\sub\\desktop-b.jsonl': load('reasonix-multi-turn.jsonl'),
    // V2 WAL / 伴生文件：目录扫描必须排除
    'D:\\demo\\reasonix\\desktop-a.events.jsonl': '{"type":"event"}',
    'D:\\demo\\reasonix\\desktop-a.conflicts.jsonl': '{}',
    'D:\\demo\\reasonix\\desktop-a.guardian.jsonl': '{}',
  }
  const { ctx, persistence } = makeCtx(tree)
  apply(ctx)
  const def = registeredDef(ctx, 'import_reasonix')
  const value = await def.execute({ path: 'D:\\demo\\reasonix' })

  assert.equal(value.mode, 'batch')
  assert.equal(value.total, 2) // desktop-a.jsonl + sub/desktop-b.jsonl（bak/WAL 均排除）
  assert.equal(value.imported, 2)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
  const ids = [...persistence.sessions.keys()].sort()
  assert.deepEqual(ids, ['import-desktop-a', 'import-desktop-b'])
})

test('import_reasonix 幂等：同名 stem 不重复落盘', async () => {
  const { ctx, persistence } = makeCtx({ 'D:\\demo\\reasonix\\desktop-a.jsonl': load('reasonix-v1.jsonl') })
  apply(ctx)
  const def = registeredDef(ctx, 'import_reasonix')
  const first = await def.execute({ path: 'D:\\demo\\reasonix\\desktop-a.jsonl' })
  const second = await def.execute({ path: 'D:\\demo\\reasonix\\desktop-a.jsonl' })
  assert.equal(first.alreadyImported, false)
  assert.equal(second.alreadyImported, true)
  assert.equal(persistence.sessions.size, 1)
})


// ---- import_opencode 集成（真实 SQLite 临时库） ----

// 合成 opencode 会话（两代消息形状：平铺 modelID / 无模型回退会话级）。
function opencodeTestSessions() {
  return [
    {
      id: 'ses-a',
      title: 'Fix build',
      directory: 'E:/demo/opencode',
      createdAt: 1786000000000,
      model: { id: 'deepseek-v4-flash', providerID: 'opencode-go' },
      messages: [
        { id: 'msg-a1', createdAt: 1786000000001, data: { role: 'user' }, parts: [
          { id: 'p-a1', createdAt: 1786000000001, data: { type: 'text', text: '为什么构建失败' } },
        ] },
        { id: 'msg-a2', createdAt: 1786000000002, data: { role: 'assistant', modelID: 'deepseek-v4-pro', path: { cwd: 'E:/demo/opencode' } }, parts: [
          { id: 'p-a2', createdAt: 1786000000002, data: { type: 'reasoning', text: '看日志' } },
          { id: 'p-a3', createdAt: 1786000000003, data: { type: 'tool', tool: 'bash', callID: 'call-a1', state: { status: 'completed', input: { command: 'cargo build' }, output: 'Compiling...' } } },
          { id: 'p-a4', createdAt: 1786000000004, data: { type: 'text', text: '修好了' } },
        ] },
      ],
    },
    {
      id: 'ses-b',
      title: 'Refactor',
      directory: 'E:/demo/opencode',
      createdAt: 1786000100000,
      model: { id: 'deepseek-v4-flash', providerID: 'opencode-go' },
      messages: [
        { id: 'msg-b1', createdAt: 1786000100001, data: { role: 'user' }, parts: [
          { id: 'p-b1', createdAt: 1786000100001, data: { type: 'text', text: '重构模块' } },
        ] },
        { id: 'msg-b2', createdAt: 1786000100002, data: { role: 'assistant' }, parts: [
          { id: 'p-b2', createdAt: 1786000100002, data: { type: 'text', text: '完成' } },
        ] },
      ],
    },
  ]
}

// 合成一个含对话压缩（compaction）的 opencode 会话：c1/c2 被压掉，c3 起为尾巴，c5 是触发器（无正文），c6 是摘要。
function opencodeCompactedSession() {
  return {
    id: 'ses-comp',
    title: 'Long task',
    directory: 'E:/demo/opencode',
    createdAt: 1786000000000,
    model: { id: 'deepseek-v4-flash', providerID: 'opencode-go' },
    messages: [
      { id: 'msg-c1', createdAt: 1786000000001, data: { role: 'user' }, parts: [
        { id: 'p-c1', createdAt: 1786000000001, data: { type: 'text', text: '第一个问题' } },
      ] },
      { id: 'msg-c2', createdAt: 1786000000002, data: { role: 'assistant' }, parts: [
        { id: 'p-c2', createdAt: 1786000000002, data: { type: 'text', text: '第一个回答' } },
      ] },
      { id: 'msg-c3', createdAt: 1786000000003, data: { role: 'user' }, parts: [
        { id: 'p-c3', createdAt: 1786000000003, data: { type: 'text', text: '第二个问题' } },
      ] },
      { id: 'msg-c4', createdAt: 1786000000004, data: { role: 'assistant' }, parts: [
        { id: 'p-c4', createdAt: 1786000000004, data: { type: 'text', text: '第二个回答' } },
      ] },
      { id: 'msg-c5', createdAt: 1786000000005, data: { role: 'user' }, parts: [
        { id: 'p-c5', createdAt: 1786000000005, data: { type: 'compaction', tail_start_id: 'msg-c3' } },
      ] },
      { id: 'msg-c6', createdAt: 1786000000006, data: { role: 'assistant', mode: 'compaction', summary: true }, parts: [
        { id: 'p-c6', createdAt: 1786000000006, data: { type: 'text', text: '前面做过的所有事摘要。' } },
      ] },
    ],
  }
}

// 在 os.tmpdir() 建临时 opencode.db（opencode schema 的 session/message/part 三表），返回 db 路径。
function makeOpencodeDb(sessions) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-opencode-'))
  const dbPath = join(dir, 'opencode.db')
  const db = new DatabaseSync(dbPath)
  db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, directory TEXT, time_created INTEGER, model TEXT)')
  db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)')
  db.exec('CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT)')
  for (const s of sessions) {
    db.prepare('INSERT INTO session (id, title, directory, time_created, model) VALUES (?, ?, ?, ?, ?)').run(s.id, s.title, s.directory, s.createdAt, JSON.stringify(s.model))
    for (const m of s.messages) {
      db.prepare('INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)').run(m.id, s.id, m.createdAt, JSON.stringify(m.data))
      for (const p of m.parts) {
        db.prepare('INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)').run(p.id, m.id, s.id, p.createdAt, JSON.stringify(p.data))
      }
    }
  }
  db.close()
  return dbPath
}

test('import_opencode 单库文件：批量形态、逐会话落盘、schema 校验', async () => {
  const dbPath = makeOpencodeDb(opencodeTestSessions())
  const { ctx, persistence, attached } = makeCtx({}) // stat 不在 tree 里 → 按 DB 文件处理
  apply(ctx)
  const def = registeredDef(ctx, 'import_opencode')
  const value = await def.execute({ path: dbPath })

  assert.equal(value.mode, 'batch') // 单 .db 也恒批量
  assert.equal(value.total, 2)
  assert.equal(value.imported, 2)
  assert.equal(value.alreadyImported, 0)
  assert.equal(value.skipped, 0)
  assert.equal(value.failed, 0)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])

  const savedA = persistence.sessions.get('import-ses-a')
  assert.ok(savedA)
  assert.equal(savedA.meta.cwd, 'E:/demo/opencode')
  assert.equal(savedA.meta.createdAt, 1786000000000)
  assert.equal(savedA.events.at(-1).type, 'session/title')
  assert.ok(savedA.events.every((e, i) => e.seq === i))
  // tool/call + tool/result 关联落盘
  const call = savedA.events.find((e) => e.type === 'tool/call')
  const result = savedA.events.find((e) => e.type === 'tool/result')
  assert.equal(call.data.callId, 'call-a1')
  assert.deepEqual(result.sourceEventSeqs, [call.seq])
  assert.equal(result.data.message.content[0].content[0].text, 'Compiling...')
  // 会话级模型回退（msg-b2 无模型）
  const savedB = persistence.sessions.get('import-ses-b')
  assert.ok(savedB)
  const asstB = savedB.events.find((e) => e.type === 'assistant/message').data.message
  assert.equal(asstB.source.model, 'deepseek-v4-flash')
  // 有 cwd → 归组两个会话
  assert.equal(attached.length, 2)
})

test('import_opencode 目录模式：自动定位 opencode.db、schema 校验', async () => {
  const dbPath = makeOpencodeDb(opencodeTestSessions())
  const dirPath = dirname(dbPath)
  const { ctx, persistence } = makeCtx({ [dirPath]: 'dir' }) // stat 命中 → 目录分支
  apply(ctx)
  const def = registeredDef(ctx, 'import_opencode')
  const value = await def.execute({ path: dirPath })

  assert.equal(value.mode, 'batch')
  assert.equal(value.total, 2)
  assert.equal(value.imported, 2)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
  assert.equal(persistence.sessions.size, 2)
})

test('import_opencode sessionIds 过滤：只导指定源会话', async () => {
  const dbPath = makeOpencodeDb(opencodeTestSessions())
  const { ctx, persistence } = makeCtx({})
  apply(ctx)
  const def = registeredDef(ctx, 'import_opencode')
  const value = await def.execute({ path: dbPath, sessionIds: ['ses-b'] })

  assert.equal(value.mode, 'batch')
  assert.equal(value.total, 2) // 库里 2 个会话，只处理被选中的
  assert.equal(value.imported, 1)
  assert.equal(value.results.length, 1)
  assert.equal(value.results[0].sessionId, 'import-ses-b')
  assert.equal(persistence.sessions.size, 1)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
})

test('import_opencode 幂等：重复导入同一库只落盘一次', async () => {
  const dbPath = makeOpencodeDb(opencodeTestSessions())
  const { ctx, persistence } = makeCtx({})
  apply(ctx)
  const def = registeredDef(ctx, 'import_opencode')
  const first = await def.execute({ path: dbPath })
  const second = await def.execute({ path: dbPath })

  assert.equal(first.imported, 2)
  assert.equal(second.imported, 0)
  assert.equal(second.alreadyImported, 2)
  assert.equal(persistence.sessions.size, 2)
})

test('readOpencodeDb：只读抽取会话、消息/part 排序、模型解析', () => {
  const dbPath = makeOpencodeDb(opencodeTestSessions())
  const sessions = readOpencodeDb(dbPath)

  assert.equal(sessions.length, 2)
  const a = sessions.find((s) => s.id === 'ses-a')
  assert.equal(a.title, 'Fix build')
  assert.equal(a.directory, 'E:/demo/opencode')
  assert.equal(a.model, 'deepseek-v4-flash') // session.model JSON 字符串 → id
  assert.equal(a.createdAt, 1786000000000)
  assert.equal(a.messages.length, 2)
  assert.equal(a.messages[0].role, 'user')
  assert.equal(a.messages[1].role, 'assistant')
  assert.equal(a.messages[1].model, 'deepseek-v4-pro') // data.modelID 平铺
  assert.equal(a.messages[1].cwd, 'E:/demo/opencode') // data.path.cwd
  assert.equal(a.messages[1].parts.length, 3)
  assert.equal(a.messages[1].parts[0].type, 'reasoning')
  assert.equal(a.messages[1].parts[1].type, 'tool')
  // 无模型的消息不携带 model
  const b = sessions.find((s) => s.id === 'ses-b')
  assert.equal(b.messages[1].model, undefined)
})

test('readOpencodeDb：尊重压缩只导摘要+尾巴，fullHistory 导全量', () => {
  const dbPath = makeOpencodeDb([opencodeCompactedSession()])
  const [s] = readOpencodeDb(dbPath)
  assert.equal(s.summary, '前面做过的所有事摘要。')
  assert.equal(s.messages.length, 3) // c3/c4/c5（c1/c2 被压掉，c6 摘要消息剔除）
  assert.equal(s.messages[0].id, 'msg-c3')
  assert.equal(s.messages[1].id, 'msg-c4')
  assert.equal(s.messages[2].id, 'msg-c5')

  const [full] = readOpencodeDb(dbPath, { fullHistory: true })
  assert.equal(full.summary, undefined)
  assert.equal(full.messages.length, 6) // 全量
})

test('import_opencode fullHistory：true 导入全量历史', async () => {
  const dbPath = makeOpencodeDb([opencodeCompactedSession()])
  const { ctx, persistence } = makeCtx({})
  apply(ctx)
  const def = registeredDef(ctx, 'import_opencode')
  const value = await def.execute({ path: dbPath, fullHistory: true })
  assert.equal(value.imported, 1)
  const saved = persistence.sessions.get('import-ses-comp')
  assert.ok(saved)
  assert.equal(saved.events.filter((e) => e.type === 'user/message').length, 2) // c1 + c3（c5 无正文被跳过）
  assert.equal(saved.events.filter((e) => e.type === 'assistant/message').length, 3) // c2 + c4 + c6
})

test('import_opencode 读不到 DB：失败大声抛错', async () => {
  const { ctx } = makeCtx({})
  apply(ctx)
  const def = registeredDef(ctx, 'import_opencode')
  await assert.rejects(() => def.execute({ path: join(tmpdir(), 'no-such-opencode.db') }))
})

// 辅助：从 ctx.tools 按名字取回定义（apply 内部调用 register）
function registeredDef(ctx, toolName = 'import_claude') {
  return ctx.tools.registered(toolName)
}
