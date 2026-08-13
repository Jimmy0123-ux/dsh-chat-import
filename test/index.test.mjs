// index.test.mjs — 插件级集成测试：mock ctx（fs / sessionPersistence / tools / workspaceRegistry），
// 走真实的 apply → register → execute 路径，并校验返回值符合输出 schema。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { apply } from '../index.mjs'
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

test('apply 注册 import_claude / import_codex / import_chatgpt / import_cursor 工具（single + batch 输出 schema）', () => {
  const { ctx, registered } = makeCtx({})
  apply(ctx)
  assert.equal(registered.length, 4)
  const names = registered.map((d) => d.name).sort()
  assert.deepEqual(names, ['import_chatgpt', 'import_claude', 'import_codex', 'import_cursor'])
  for (const def of registered) {
    // 输出 schema 是 oneOf（单文件 / 批量）
    assert.ok(Array.isArray(def.output.schema.oneOf))
    assert.equal(def.output.schema.oneOf.length, 2)
  }
})

test('单文件导入：落盘、归组、返回值符合 schema', async () => {
  const simple = load('simple.jsonl')
  const { ctx, persistence, attached } = makeCtx({ 'D:\\demo\\proj\\simple.jsonl': simple })
  apply(ctx)
  const def = ctx.tools.register.calls ?? registeredDef(ctx)
  const value = await def.execute({ path: 'D:\\demo\\proj\\simple.jsonl' })

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
  const simple = load('simple.jsonl')
  const { ctx, persistence } = makeCtx({ 'D:\\demo\\proj\\simple.jsonl': simple })
  apply(ctx)
  const def = registeredDef(ctx)
  const first = await def.execute({ path: 'D:\\demo\\proj\\simple.jsonl' })
  const second = await def.execute({ path: 'D:\\demo\\proj\\simple.jsonl' })
  assert.equal(first.alreadyImported, false)
  assert.equal(second.alreadyImported, true)
  assert.equal(persistence.sessions.size, 1)
})

test('单文件导入工具历史：tool/result 带 sourceEventSeqs', async () => {
  const { ctx } = makeCtx({ 'D:\\demo\\proj\\tool.jsonl': load('tool.jsonl') })
  apply(ctx)
  const def = registeredDef(ctx)
  const value = await def.execute({ path: 'D:\\demo\\proj\\tool.jsonl' })
  assert.equal(value.mode, 'single')
  assert.equal(value.toolCalls, 1)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
})

test('目录批量导入：扫描 .jsonl、逐文件独立会话、跳过非 transcript、汇总符合 schema', async () => {
  const tree = {
    'D:\\demo\\proj': 'dir',
    'D:\\demo\\proj\\a.jsonl': load('simple.jsonl'),
    'D:\\demo\\proj\\b.jsonl': load('tool.jsonl'),
    'D:\\demo\\proj\\notes.txt': 'not a transcript',
    'D:\\demo\\proj\\sub': 'dir',
    'D:\\demo\\proj\\sub\\c.jsonl': load('title.jsonl'),
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
    'D:\\demo\\proj\\a.jsonl': load('simple.jsonl'),
    'D:\\demo\\proj\\sub': 'dir',
    'D:\\demo\\proj\\sub\\c.jsonl': load('title.jsonl'),
  }
  const { ctx } = makeCtx(tree)
  apply(ctx)
  const def = registeredDef(ctx)
  const value = await def.execute({ path: 'D:\\demo\\proj', recursive: false })
  assert.equal(value.mode, 'batch')
  assert.equal(value.total, 1) // 只扫顶层 a.jsonl
  assert.deepEqual(value.results.map((r) => r.sessionId), ['import-sess-simple-001'])
})

test('目录批量导入：已存在会话计入 alreadyImported', async () => {
  const tree = {
    'D:\\demo\\proj': 'dir',
    'D:\\demo\\proj\\a.jsonl': load('simple.jsonl'),
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

// 辅助：从 ctx.tools 按名字取回定义（apply 内部调用 register）
function registeredDef(ctx, toolName = 'import_claude') {
  return ctx.tools.registered(toolName)
}
