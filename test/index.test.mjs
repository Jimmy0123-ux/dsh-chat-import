// index.test.mjs — 插件级集成测试：mock ctx（fs / sessionPersistence / tools / workspaceRegistry），
// 走真实的 apply → register → execute 路径，并校验返回值符合输出 schema。
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { apply, readOpencodeDb, exportClaudeSession } from '../index.mjs'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { resolveRegistryDir, loadImports } from '../lib/imports.mjs'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const load = (name) => readFileSync(join(fixtures, name), 'utf8')

// REQ-24 registry 隔离：每个用例独立 DSH_HOME（registry 落盘在 $DSH_HOME/dsh-chat-import）
beforeEach(() => {
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-home-'))
})

// fs 版本指纹：内容派生，内容变则 version 变（mock stat 的 version 字段）。
function contentVersion(text) {
  let h = 0
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0
  return 'v' + h
}

// 合成 N 回合 Claude transcript（同一 sessionId，供增量续写测试）。
function claudeTurns(n, sessionId = 'sess-incr-001') {
  const lines = []
  for (let i = 1; i <= n; i++) {
    if (i === 1) {
      lines.push(JSON.stringify({ sessionId, type: 'user', cwd: 'D:\\demo\\proj', message: { role: 'user', content: '问题' + i } }))
    } else {
      lines.push(JSON.stringify({ sessionId, type: 'user', message: { role: 'user', content: '问题' + i } }))
    }
    lines.push(JSON.stringify({ sessionId, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '回答' + i }] } }))
  }
  return lines.join('\n')
}

// 合成 ChatGPT conversations.json 的单个会话对象（mapping 主线程：user/assistant 交替）。
function chatgptConversation(id, title, turns) {
  const mapping = {}
  let prev = null
  let idx = 1
  for (const prompt of turns) {
    for (const role of ['user', 'assistant']) {
      const nodeId = 'n' + idx
      const text = role === 'user' ? prompt : 'reply to ' + prompt
      mapping[nodeId] = {
        id: nodeId,
        message: { id: 'm' + idx, author: { role }, content: { content_type: 'text', parts: [text] }, create_time: 1710000000 + idx },
        parent: prev,
        children: [],
      }
      if (prev) mapping[prev].children.push(nodeId)
      prev = nodeId
      idx++
    }
  }
  return { id, title, create_time: 1710000000, mapping }
}

// 内存态会话库：create/append/list/inspect，模拟 sessionPersistence。
// append 强制 seq 连续（引擎契约：首事件 seq 必须等于已存 next-seq）。
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
      for (let i = 0; i < events.length; i++) {
        const ev = events[i]
        if (typeof ev.seq !== 'number' || ev.seq !== s.events.length + i) {
          throw new Error('append seq 不连续: 期望 ' + (s.events.length + i) + ' 实际 ' + String(ev && ev.seq))
        }
      }
      s.events.push(...events)
    },
    async inspect(id) {
      const s = sessions.get(id)
      if (!s) throw new Error('unknown session ' + id)
      return { meta: s.meta, events: s.events }
    },
    // REQ-16 导出只读面：readFrom(id, fromSeq) 返回 { meta, events }（不 load/prepare）
    async readFrom(id, fromSeq = 0) {
      const s = sessions.get(id)
      if (!s) throw new Error('unknown session ' + id)
      return { meta: s.meta, events: s.events.slice(fromSeq) }
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
  const reads = { count: 0 }
  const writes = [] // export_claude 的写盘记录（{ path, content, options }）

  const fs = {
    async resolve(path) { return { targetKey: path, displayPath: path } },
    // REQ-16 导出写面：createIfAbsent 对已存在（tree 已 seed 或已写过）路径抛 EEXIST，
    // 模拟「新 uuid + createIfAbsent 不覆盖」双保险的第二道闸
    async writeText(target, content, options) {
      const path = target.targetKey
      if (options && options.kind === 'createIfAbsent' && tree[path] !== undefined) {
        throw Object.assign(new Error('EEXIST ' + path), { code: 'EEXIST' })
      }
      tree[path] = content
      writes.push({ path, content, options })
      return { path }
    },
    async stat(target) {
      const v = tree[target.targetKey]
      if (v !== undefined) {
        // 内容派生指纹：size + version（变则 version 变，REQ-24 短路径判定依据）
        return v === 'dir' ? { type: 'directory' } : { type: 'file', size: v.length, version: contentVersion(v) }
      }
      // 树外的真实文件（opencode 临时 SQLite 库）：回退 node:fs
      try {
        const s = statSync(target.targetKey)
        if (s.isDirectory()) return { type: 'directory' }
        return { type: 'file', size: s.size, version: 'real-' + s.size + '-' + s.mtimeMs + '-' + s.ctimeMs }
      } catch {
        return undefined
      }
    },
    async readText(target) {
      reads.count++
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
      if (service === 'sessionPersistence') return persistence
      return undefined
    },
    tools: {
      register(def) { registered.push(def); return () => {} },
    },
  }
  // 测试辅助：按名字取出注册的工具定义
  ctx.tools.registered = (toolName) => registered.find((d) => d.name === toolName)
  return { ctx, persistence, attached, registered, reads, writes }
}

// REQ-32：导入会话日志首事件为 session/imported 标记（seq 0、ignorable），
// sourcePath 来自工具入参（fs 服务归一化路径）。
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
}

test('apply 注册八个工具（7 导入 + export_claude）', () => {
  const { ctx, registered } = makeCtx({})
  apply(ctx)
  assert.equal(registered.length, 8)
  const names = registered.map((d) => d.name).sort()
  assert.deepEqual(names, ['export_claude', 'import_chatgpt', 'import_claude', 'import_codex', 'import_cursor', 'import_gemini', 'import_opencode', 'import_reasonix'])
  for (const def of registered) {
    if (def.name === 'export_claude') {
      // 导出工具：单对象输出 schema（非 oneOf）
      assert.equal(def.output.schema.type, 'object')
      assert.ok(!Array.isArray(def.output.schema.oneOf))
    } else {
      // 导入工具：输出 schema 是 oneOf（单文件 / 批量）
      assert.ok(Array.isArray(def.output.schema.oneOf))
      assert.equal(def.output.schema.oneOf.length, 2)
    }
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

  // 落盘：meta + 平衡事件；首事件为 session/imported 标记（sourcePath = 工具入参）
  const saved = persistence.sessions.get('import-sess-simple-001')
  assert.ok(saved)
  assert.equal(saved.meta.cwd, 'D:\\demo\\proj')
  assert.equal(saved.events.at(-1).type, 'turn/end')
  assert.ok(saved.events.every((e, i) => e.seq === i))
  assertImportedMarker(saved.events, { tool: 'claude-code', sourceId: 'sess-simple-001', sourcePath: 'D:\\demo\\proj\\sess-simple-001.jsonl' })

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

  // 逐文件的 sourcePath 是各自 transcript 路径（目录模式每个文件一个源路径）
  assertImportedMarker(persistence.sessions.get('import-sess-simple-001').events, { tool: 'claude-code', sourceId: 'sess-simple-001', sourcePath: 'D:\\demo\\proj\\sess-simple-001.jsonl' })
  assertImportedMarker(persistence.sessions.get('import-sess-tool-001').events, { tool: 'claude-code', sourceId: 'sess-tool-001', sourcePath: 'D:\\demo\\proj\\sess-tool-001.jsonl' })
  assertImportedMarker(persistence.sessions.get('import-sess-title-001').events, { tool: 'claude-code', sourceId: 'sess-title-001', sourcePath: 'D:\\demo\\proj\\sub\\sess-title-001.jsonl' })

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
  assertImportedMarker(saved.events, { tool: 'codex', sourceId: '019e3b3f-636d-7cb3-aaab-0255eb45ad4f', sourcePath: 'D:\\demo\\codex\\simple.jsonl' })
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
  // 同一文件里的每个会话都带标记，sourcePath 都是 conversations.json（REQ-32）
  assertImportedMarker(saved1.events, { tool: 'chatgpt', sourceId: 'conv-001', sourcePath: 'D:\\demo\\chatgpt\\conversations.json' })
  assertImportedMarker(saved2.events, { tool: 'chatgpt', sourceId: 'conv-002', sourcePath: 'D:\\demo\\chatgpt\\conversations.json' })
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
  assertImportedMarker(saved.events, { tool: 'cursor', sourceId: 'composer-abc', sourcePath: 'D:\\demo\\cursor\\composer-abc.jsonl' })
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
  assertImportedMarker(saved.events, { tool: 'gemini', sourceId: 'b26d7f99-0116-4d1d-b125-98c228a4b933', sourcePath: 'D:\\demo\\gemini\\session-abc.json' })
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
  assertImportedMarker(saved.events, { tool: 'reasonix', sourceId: 'desktop-v2', sourcePath: 'D:\\demo\\reasonix\\desktop-v2.jsonl' })
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

// 往已建好的临时 opencode.db 追加一轮（user + assistant 各一条 text part）。
function addOpencodeTurn(dbPath, sessionId, baseId, userText, asstText, timeBase) {
  const db = new DatabaseSync(dbPath)
  db.prepare('INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)').run(baseId + '-u', sessionId, timeBase, JSON.stringify({ role: 'user' }))
  db.prepare('INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)').run(baseId + '-p1', baseId + '-u', sessionId, timeBase, JSON.stringify({ type: 'text', text: userText }))
  db.prepare('INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)').run(baseId + '-a', sessionId, timeBase + 1, JSON.stringify({ role: 'assistant' }))
  db.prepare('INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)').run(baseId + '-p2', baseId + '-a', sessionId, timeBase + 1, JSON.stringify({ type: 'text', text: asstText }))
  db.close()
}

// 从临时 opencode.db 删除指定 message（含其 parts）。
function deleteOpencodeMessages(dbPath, ids) {
  const db = new DatabaseSync(dbPath)
  for (const id of ids) {
    db.prepare('DELETE FROM part WHERE message_id = ?').run(id)
    db.prepare('DELETE FROM message WHERE id = ?').run(id)
  }
  db.close()
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
  // 标记：tool=opencode、sourceId=源会话 id、sourcePath=opencode.db 路径（工具入参）
  assertImportedMarker(savedA.events, { tool: 'opencode', sourceId: 'ses-a', sourcePath: dbPath })
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

// ---- REQ-24 增量续写（重导 append 新轮次 + 源路径幂等键） ----

test('REQ-24 增长 append：同一会话 seq 连续、只新增轮次、无重复标题/标记', async () => {
  const tree = { 'D:\\demo\\proj\\sess-incr-001.jsonl': claudeTurns(2) }
  const { ctx, persistence } = makeCtx(tree)
  apply(ctx)
  const def = registeredDef(ctx)
  const first = await def.execute({ path: 'D:\\demo\\proj\\sess-incr-001.jsonl' })
  assert.equal(first.status, 'imported')
  assert.equal(first.turns, 2)
  const saved1 = persistence.sessions.get('import-sess-incr-001')
  const before = saved1.events.length
  const firstEvents = [...saved1.events] // 快照：mock 的 append 原地修改同一数组
  assert.equal(saved1.events.filter((e) => e.type === 'turn/start').length, 2)

  // 源文件增长（2 → 3 轮）
  tree['D:\\demo\\proj\\sess-incr-001.jsonl'] = claudeTurns(3)
  const second = await def.execute({ path: 'D:\\demo\\proj\\sess-incr-001.jsonl' })
  assert.equal(second.status, 'appended')
  assert.equal(second.appendedTurns, 1)
  assert.ok(second.appendedEvents > 0)
  assert.equal(second.alreadyImported, false)

  // 同一会话：seq 全连续、只多出尾部轮次
  const saved2 = persistence.sessions.get('import-sess-incr-001')
  assert.ok(saved2)
  assert.ok(saved2.events.every((e, i) => e.seq === i))
  assert.equal(saved2.events.length, before + second.appendedEvents)
  assert.equal(saved2.events.filter((e) => e.type === 'turn/start').length, 3)
  // 续写轮次：turn 续号用源编号（3），末尾 turn/end 平衡
  assert.equal(saved2.events.at(-1).type, 'turn/end')
  assert.equal(saved2.events.at(-1).data.turn, 3)
  // 不重复写 session/imported 标记与 session/title
  assert.equal(saved2.events.filter((e) => e.type === 'session/imported').length, 1)
  assert.equal(saved2.events.filter((e) => e.type === 'session/title').length, 0)
  // 已导入前缀事件未被改写
  assert.deepEqual(saved2.events.slice(0, before), firstEvents)
})

test('REQ-24 未变跳过：version/size 短路径不 readText，已存在不重复落盘', async () => {
  const tree = { 'D:\\demo\\proj\\sess-incr-001.jsonl': claudeTurns(2) }
  const { ctx, persistence, reads } = makeCtx(tree)
  apply(ctx)
  const def = registeredDef(ctx)
  const first = await def.execute({ path: 'D:\\demo\\proj\\sess-incr-001.jsonl' })
  assert.equal(reads.count, 1)
  assert.equal(first.status, 'imported')
  const second = await def.execute({ path: 'D:\\demo\\proj\\sess-incr-001.jsonl' })
  // 未变：短路径跳过（不 readText），返回 already-imported
  assert.equal(second.status, 'already-imported')
  assert.equal(second.alreadyImported, true)
  assert.equal(reads.count, 1)
  assert.equal(persistence.sessions.size, 1)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, second), [])
})

test('REQ-24 sourceShrunk：源文件轮次减少 → 跳过报告，不破坏已导入会话', async () => {
  const tree = { 'D:\\demo\\proj\\sess-incr-001.jsonl': claudeTurns(3) }
  const { ctx, persistence } = makeCtx(tree)
  apply(ctx)
  const def = registeredDef(ctx)
  await def.execute({ path: 'D:\\demo\\proj\\sess-incr-001.jsonl' })
  const before = persistence.sessions.get('import-sess-incr-001').events.length

  tree['D:\\demo\\proj\\sess-incr-001.jsonl'] = claudeTurns(2)
  const second = await def.execute({ path: 'D:\\demo\\proj\\sess-incr-001.jsonl' })
  assert.equal(second.status, 'already-imported')
  assert.equal(second.sourceShrunk, true)
  // 已导入会话原样（仍是 3 轮）
  const saved = persistence.sessions.get('import-sess-incr-001')
  assert.equal(saved.events.length, before)
  assert.equal(saved.events.filter((e) => e.type === 'turn/start').length, 3)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, second), [])
})

test('REQ-24 changedInPlace：轮数相等但事件增长 → 跳过（append-only 无法改写）', async () => {
  const v1 = claudeTurns(1)
  // 同轮内多一条 assistant 消息（step2）→ 事件数变多、轮数不变
  const v2 = [
    '{"sessionId":"sess-incr-001","type":"user","cwd":"D:\\\\demo\\\\proj","message":{"role":"user","content":"问题1"}}',
    '{"sessionId":"sess-incr-001","type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"回答1"}]}}',
    '{"sessionId":"sess-incr-001","type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"补充回答"}]}}',
  ].join('\n')
  const tree = { 'D:\\demo\\proj\\sess-incr-001.jsonl': v1 }
  const { ctx, persistence } = makeCtx(tree)
  apply(ctx)
  const def = registeredDef(ctx)
  await def.execute({ path: 'D:\\demo\\proj\\sess-incr-001.jsonl' })
  const before = persistence.sessions.get('import-sess-incr-001').events.length

  tree['D:\\demo\\proj\\sess-incr-001.jsonl'] = v2
  const second = await def.execute({ path: 'D:\\demo\\proj\\sess-incr-001.jsonl' })
  assert.equal(second.status, 'already-imported')
  assert.equal(second.changedInPlace, true)
  assert.equal(persistence.sessions.get('import-sess-incr-001').events.length, before)
})

test('REQ-24 force:true：新 id 完整副本，旧会话原样保留', async () => {
  const tree = { 'D:\\demo\\proj\\sess-incr-001.jsonl': claudeTurns(2) }
  const { ctx, persistence } = makeCtx(tree)
  apply(ctx)
  const def = registeredDef(ctx)
  await def.execute({ path: 'D:\\demo\\proj\\sess-incr-001.jsonl' })
  const oldEvents = persistence.sessions.get('import-sess-incr-001').events

  const forced = await def.execute({ path: 'D:\\demo\\proj\\sess-incr-001.jsonl', force: true })
  assert.equal(forced.status, 'imported')
  assert.equal(forced.sessionId, 'import-sess-incr-001-1')
  assert.deepEqual(forced.forceImported, { previous: 'import-sess-incr-001', current: 'import-sess-incr-001-1' })
  // 两个会话都在：旧会话原样，新会话是完整副本（含 2 轮）
  assert.equal(persistence.sessions.size, 2)
  const copy = persistence.sessions.get('import-sess-incr-001-1')
  assert.ok(copy)
  assert.ok(copy.events.every((e, i) => e.seq === i))
  assert.equal(copy.events.filter((e) => e.type === 'turn/start').length, 2)
  assert.deepEqual(persistence.sessions.get('import-sess-incr-001').events, oldEvents)
  // registry 指向新 id；再 force 一次 → 从当前记录链式避让（import-sess-incr-001-1-1）
  const forced2 = await def.execute({ path: 'D:\\demo\\proj\\sess-incr-001.jsonl', force: true })
  assert.equal(forced2.sessionId, 'import-sess-incr-001-1-1')
  assert.equal(persistence.sessions.size, 3)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, forced), [])
})

test('REQ-24 两路径共享 sessionId：都导入、后缀避让、互不覆盖', async () => {
  // Claude 主 transcript 命名 = <sessionId>.jsonl；两个不同目录的同名文件共享同一源 sessionId
  const tree = {
    'D:\\demo\\proj\\a\\shared-session.jsonl': claudeTurns(1, 'shared-session'),
    'D:\\demo\\proj\\b\\shared-session.jsonl': [
      '{"sessionId":"shared-session","type":"user","message":{"role":"user","content":"另一个文件的问题"}}',
      '{"sessionId":"shared-session","type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"另一个文件的回答"}]}}',
    ].join('\n'),
  }
  const { ctx, persistence } = makeCtx(tree)
  apply(ctx)
  const def = registeredDef(ctx)
  const ra = await def.execute({ path: 'D:\\demo\\proj\\a\\shared-session.jsonl' })
  const rb = await def.execute({ path: 'D:\\demo\\proj\\b\\shared-session.jsonl' })
  assert.equal(ra.status, 'imported')
  assert.equal(ra.sessionId, 'import-shared-session')
  // 第二个文件目标 id 被占用 → 后缀避让，不覆盖第一个文件的内容
  assert.equal(rb.status, 'imported')
  assert.equal(rb.sessionId, 'import-shared-session-1')
  assert.equal(persistence.sessions.size, 2)
  const a = persistence.sessions.get('import-shared-session')
  const b = persistence.sessions.get('import-shared-session-1')
  assert.ok(a.events.some((e) => e.type === 'user/message' && e.data.content[0].text.includes('问题')))
  assert.ok(b.events.some((e) => e.type === 'user/message' && e.data.content[0].text.includes('另一个文件')))
  // 两个路径各自有 registry 记录，重导各自幂等（不互相串扰）
  const rb2 = await def.execute({ path: 'D:\\demo\\proj\\b\\shared-session.jsonl' })
  assert.equal(rb2.status, 'already-imported')
  assert.equal(persistence.sessions.size, 2)
})

test('REQ-24 legacy 回填：registry 丢失但会话在 → already-imported + 回填基线', async () => {
  const tree = { 'D:\\demo\\proj\\sess-incr-001.jsonl': claudeTurns(2) }
  const { ctx, persistence } = makeCtx(tree)
  apply(ctx)
  const def = registeredDef(ctx)
  await def.execute({ path: 'D:\\demo\\proj\\sess-incr-001.jsonl' })
  assert.equal(persistence.sessions.size, 1)

  // 模拟 registry 丢失（旧版本无 registry）：清空 imports.json
  const regFile = join(resolveRegistryDir(), 'imports.json')
  mkdirSync(dirname(regFile), { recursive: true })
  writeFileSync(regFile, '{ "version": 1, "imports": {} }')

  const second = await def.execute({ path: 'D:\\demo\\proj\\sess-incr-001.jsonl' })
  assert.equal(second.status, 'already-imported')
  assert.equal(second.backfilled, true)
  assert.equal(persistence.sessions.size, 1) // 不重复落盘
  // 回填后 registry 有该路径的基线记录；再导（未变）走短路径跳过
  const reg = await loadImports(resolveRegistryDir())
  const rec = reg.imports['D:\\demo\\proj\\sess-incr-001.jsonl']
  assert.ok(rec)
  assert.equal(rec.kind, 'single')
  assert.equal(rec.dshId, 'import-sess-incr-001')
  assert.equal(rec.turns, 2)
  const third = await def.execute({ path: 'D:\\demo\\proj\\sess-incr-001.jsonl' })
  assert.equal(third.status, 'already-imported')
})

test('REQ-24 用户 DSH 续聊后 append：fromSeq 取 inspect 权威游标，seq 接在用户事件后', async () => {
  const tree = { 'D:\\demo\\proj\\sess-incr-001.jsonl': claudeTurns(2) }
  const { ctx, persistence } = makeCtx(tree)
  apply(ctx)
  const def = registeredDef(ctx)
  await def.execute({ path: 'D:\\demo\\proj\\sess-incr-001.jsonl' })
  const saved1 = persistence.sessions.get('import-sess-incr-001')
  const base = saved1.events.length

  // 用户在 DSH 里继续聊了 2 条消息（会话日志增长，registry 记录过期）
  const chat = [
    { type: 'user/message', seq: base, time: Date.now(), surfaceOp: 'append', data: { id: 'live:u1', role: 'user', content: [{ type: 'text', text: 'DSH 里继续问' }], source: { kind: 'user' } } },
    { type: 'assistant/message', seq: base + 1, time: Date.now(), surfaceOp: 'append', data: { id: 'live:a1', role: 'assistant', content: [{ type: 'text', text: 'DSH 里继续答' }], source: { kind: 'model', provider: 'dsh' } } },
  ]
  await persistence.append('import-sess-incr-001', chat)

  tree['D:\\demo\\proj\\sess-incr-001.jsonl'] = claudeTurns(3)
  const second = await def.execute({ path: 'D:\\demo\\proj\\sess-incr-001.jsonl' })
  assert.equal(second.status, 'appended')
  const saved2 = persistence.sessions.get('import-sess-incr-001')
  assert.ok(saved2.events.every((e, i) => e.seq === i))
  // 用户事件原样保留；续写从 base+2 开始
  assert.equal(saved2.events[base].data.id, 'live:u1')
  assert.equal(saved2.events[base + 1].data.id, 'live:a1')
  assert.ok(saved2.events[base + 2].seq >= base + 2)
  assert.equal(saved2.events.at(-1).type, 'turn/end')
  assert.equal(saved2.events.at(-1).data.turn, 3)
  assert.equal(saved2.events.filter((e) => e.type === 'turn/start').length, 3)
})

test('REQ-24 显式 sessionId 变更：以新 id 建完整副本（force 副本语义），旧会话原样', async () => {
  const tree = { 'D:\\demo\\proj\\sess-incr-001.jsonl': claudeTurns(2) }
  const { ctx, persistence } = makeCtx(tree)
  apply(ctx)
  const def = registeredDef(ctx)
  const first = await def.execute({ path: 'D:\\demo\\proj\\sess-incr-001.jsonl', sessionId: 'custom-a' })
  assert.equal(first.sessionId, 'custom-a')

  const second = await def.execute({ path: 'D:\\demo\\proj\\sess-incr-001.jsonl', sessionId: 'custom-b' })
  assert.equal(second.status, 'imported')
  assert.equal(second.sessionId, 'custom-b')
  assert.deepEqual(second.forceImported, { previous: 'custom-a', current: 'custom-b' })
  assert.equal(persistence.sessions.size, 2)
  assert.ok(persistence.sessions.get('custom-a'))
  assert.ok(persistence.sessions.get('custom-b'))
  // registry 指向新 id
  const reg = await loadImports(resolveRegistryDir())
  assert.equal(reg.imports['D:\\demo\\proj\\sess-incr-001.jsonl'].dshId, 'custom-b')
})

test('REQ-24 损坏 registry 容错：按空 registry 处理并继续导入', async () => {
  const regFile = join(resolveRegistryDir(), 'imports.json')
  mkdirSync(dirname(regFile), { recursive: true })
  writeFileSync(regFile, 'not json {{{')
  const tree = { 'D:\\demo\\proj\\sess-incr-001.jsonl': claudeTurns(2) }
  const { ctx, persistence } = makeCtx(tree)
  apply(ctx)
  const def = registeredDef(ctx)
  const value = await def.execute({ path: 'D:\\demo\\proj\\sess-incr-001.jsonl' })
  assert.equal(value.status, 'imported')
  assert.equal(persistence.sessions.size, 1)
  // 导入后 registry 被重建为合法内容
  const reg = await loadImports(resolveRegistryDir())
  assert.ok(reg.imports['D:\\demo\\proj\\sess-incr-001.jsonl'])
})

test('REQ-24 batch 汇总：目录内单文件增长 → appended 计数与结果 status', async () => {
  const tree = {
    'D:\\demo\\proj': 'dir',
    'D:\\demo\\proj\\sess-incr-001.jsonl': claudeTurns(2),
    'D:\\demo\\proj\\sess-static-001.jsonl': claudeTurns(1, 'sess-static-001'),
  }
  const { ctx, persistence } = makeCtx(tree)
  apply(ctx)
  const def = registeredDef(ctx)
  const first = await def.execute({ path: 'D:\\demo\\proj' })
  assert.equal(first.imported, 2)
  assert.equal(first.appended, 0)

  tree['D:\\demo\\proj\\sess-incr-001.jsonl'] = claudeTurns(3)
  const second = await def.execute({ path: 'D:\\demo\\proj' })
  assert.equal(second.mode, 'batch')
  assert.equal(second.appended, 1)
  assert.equal(second.alreadyImported, 1) // sess-static 未变短路径跳过
  assert.equal(second.imported, 0)
  const appendedResult = second.results.find((r) => r.status === 'appended')
  assert.ok(appendedResult)
  assert.equal(appendedResult.sessionId, 'import-sess-incr-001')
  assert.equal(appendedResult.appendedTurns, 1)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, second), [])
  assert.equal(persistence.sessions.get('import-sess-incr-001').events.filter((e) => e.type === 'turn/start').length, 3)
})

test('REQ-24 ChatGPT 多会话：逐会话增长 append / 新增 / 消失 missingFromSource', async () => {
  const v1 = JSON.stringify([
    chatgptConversation('conv-001', 'Alpha', ['问题A']),
    chatgptConversation('conv-002', 'Beta', ['问题B']),
  ])
  const v2 = JSON.stringify([
    chatgptConversation('conv-001', 'Alpha', ['问题A', '问题A2']), // 增长
    chatgptConversation('conv-003', 'Gamma', ['问题C']), // 新增
  ]) // conv-002 消失
  const tree = { 'D:\\demo\\chatgpt\\conversations.json': v1 }
  const { ctx, persistence } = makeCtx(tree)
  apply(ctx)
  const def = registeredDef(ctx, 'import_chatgpt')
  const first = await def.execute({ path: 'D:\\demo\\chatgpt\\conversations.json' })
  assert.equal(first.imported, 2)
  assert.equal(persistence.sessions.size, 2)
  const conv1Before = persistence.sessions.get('import-conv-001').events.length

  tree['D:\\demo\\chatgpt\\conversations.json'] = v2
  const second = await def.execute({ path: 'D:\\demo\\chatgpt\\conversations.json' })
  assert.equal(second.mode, 'batch')
  assert.equal(second.appended, 1) // conv-001 增长
  assert.equal(second.imported, 1) // conv-003 新增
  assert.deepEqual(second.missingFromSource, ['conv-002'])
  const appended = second.results.find((r) => r.status === 'appended')
  assert.ok(appended)
  assert.equal(appended.sessionId, 'import-conv-001')
  assert.equal(appended.appendedTurns, 1)
  const conv1 = persistence.sessions.get('import-conv-001')
  assert.ok(conv1.events.every((e, i) => e.seq === i))
  assert.equal(conv1.events.length, conv1Before + appended.appendedEvents)
  assert.equal(conv1.events.filter((e) => e.type === 'turn/start').length, 2)
  assert.ok(persistence.sessions.get('import-conv-003'))
  assert.ok(persistence.sessions.get('import-conv-002')) // 消失的会话原样保留
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, second), [])
})

test('REQ-24 opencode DB 增长 append：同库新增轮次续写同一会话', async () => {
  const dbPath = makeOpencodeDb(opencodeTestSessions())
  const { ctx, persistence } = makeCtx({})
  apply(ctx)
  const def = registeredDef(ctx, 'import_opencode')
  const first = await def.execute({ path: dbPath })
  assert.equal(first.imported, 2)
  const before = persistence.sessions.get('import-ses-a').events.length

  // 库增长：ses-a 追加一轮
  addOpencodeTurn(dbPath, 'ses-a', 'msg-a3', '继续追问', '追加回答', 1786000000100)
  const second = await def.execute({ path: dbPath })
  assert.equal(second.mode, 'batch')
  assert.equal(second.appended, 1)
  assert.equal(second.alreadyImported, 1) // ses-b 未变
  const appended = second.results.find((r) => r.status === 'appended')
  assert.ok(appended)
  assert.equal(appended.sessionId, 'import-ses-a')
  const sesA = persistence.sessions.get('import-ses-a')
  assert.ok(sesA.events.every((e, i) => e.seq === i))
  assert.equal(sesA.events.length, before + appended.appendedEvents)
  assert.equal(sesA.events.filter((e) => e.type === 'turn/start').length, 2)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, second), [])
})

test('REQ-24 opencode 消息删除（turns 变少）→ sourceShrunk 跳过', async () => {
  const dbPath = makeOpencodeDb(opencodeTestSessions())
  addOpencodeTurn(dbPath, 'ses-a', 'msg-a3', '继续追问', '追加回答', 1786000000100)
  const { ctx, persistence } = makeCtx({})
  apply(ctx)
  const def = registeredDef(ctx, 'import_opencode')
  await def.execute({ path: dbPath })
  const before = persistence.sessions.get('import-ses-a').events.length

  // 删除追加的一轮 → ses-a 轮次变少
  deleteOpencodeMessages(dbPath, ['msg-a3-u', 'msg-a3-a'])
  const second = await def.execute({ path: dbPath })
  const shrunk = second.results.find((r) => r.sessionId === 'import-ses-a')
  assert.ok(shrunk)
  assert.equal(shrunk.status, 'already-imported')
  assert.equal(shrunk.sourceShrunk, true)
  assert.equal(persistence.sessions.get('import-ses-a').events.length, before)
})

test('REQ-24 opencode fullHistory 入 args 指纹：参数变化 → args-changed 跳过', async () => {
  const dbPath = makeOpencodeDb(opencodeTestSessions())
  const { ctx, persistence } = makeCtx({})
  apply(ctx)
  const def = registeredDef(ctx, 'import_opencode')
  await def.execute({ path: dbPath }) // 默认（尊重压缩）
  const second = await def.execute({ path: dbPath, fullHistory: true })
  assert.equal(second.mode, 'batch')
  assert.equal(second.alreadyImported, 2)
  assert.equal(second.imported, 0)
  assert.equal(second.appended, 0)
  assert.ok(second.results.every((r) => r.argsChanged === true))
  assert.equal(persistence.sessions.size, 2) // 未新增副本
  // force:true 可换新参数导入（副本）
  const forced = await def.execute({ path: dbPath, fullHistory: true, force: true })
  assert.equal(forced.imported, 2)
  assert.equal(persistence.sessions.size, 4)
})

test('REQ-24 opencode 未变 DB：短路径跳过（version/size 不变）', async () => {
  const dbPath = makeOpencodeDb(opencodeTestSessions())
  const { ctx, persistence } = makeCtx({})
  apply(ctx)
  const def = registeredDef(ctx, 'import_opencode')
  await def.execute({ path: dbPath })
  const second = await def.execute({ path: dbPath })
  assert.equal(second.imported, 0)
  assert.equal(second.alreadyImported, 2)
  assert.equal(persistence.sessions.size, 2)
})

// ---- export_claude 集成（REQ-16 反向导出） ----

// 直接在 mock persistence 里 seed 合成会话（精确控制事件形状，绕过导入转换）。
async function seedSession(persistence, id, meta, events) {
  await persistence.create(meta)
  await persistence.append(id, events)
}

// 合成 DSH 事件（形状对齐真实日志：surface 事件带 surfaceOp:'append'）。
function mkEvent(type, seq, time, data, extra = {}) {
  return { type, seq, time, data, ...extra }
}

const OUT = join('C:', 'Users', 'test', '.claude', 'projects') // 跨平台 join，避免分隔符断言

test('export_claude 落盘：import → export 闭环、路径 <outputDir>/<slug>/<uuid>.jsonl、schema 校验', async () => {
  const tree = { 'D:\\demo\\proj\\sess-simple-001.jsonl': load('sess-simple-001.jsonl') }
  const { ctx, persistence, writes } = makeCtx(tree)
  apply(ctx)
  await registeredDef(ctx, 'import_claude').execute({ path: 'D:\\demo\\proj\\sess-simple-001.jsonl' })
  assert.equal(persistence.sessions.size, 1)

  const def = registeredDef(ctx, 'export_claude')
  const value = await def.execute({ sessionId: 'import-sess-simple-001', outputDir: OUT })

  assert.equal(value.mode, 'single')
  assert.equal(value.sourceSessionId, 'import-sess-simple-001')
  assert.equal(value.slug, 'D--demo-proj') // D:\demo\proj → ':'、'\'、'\' 各一个 '-'
  assert.equal(value.cwd, 'D:\\demo\\proj')
  assert.match(value.sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.equal(value.recordCount, 4) // mode + permission-mode + user + assistant
  assert.equal(value.mapping.turns, 1)
  assert.equal(value.mapping.messages, 2)
  assert.equal(value.mapping.toolCalls, 0)
  assert.equal(value.mapping.toolResults, 0)
  assert.equal(value.dryRun, false)
  assert.equal(value.filePath, join(OUT, 'D--demo-proj', value.sessionId + '.jsonl'))
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])

  // 落盘：createIfAbsent + 内容可解析、布局正确（每行一记录、恰一个结尾换行）
  assert.equal(writes.length, 1)
  assert.equal(writes[0].path, value.filePath)
  assert.equal(writes[0].options.kind, 'createIfAbsent')
  const body = writes[0].content.slice(0, -1)
  assert.equal(writes[0].content.endsWith('\n'), true)
  const lines = body.split('\n').map((l) => JSON.parse(l))
  assert.equal(lines.length, 4)
  assert.equal(lines[0].type, 'mode')
  const pm = lines[1]
  assert.deepEqual(Object.keys(pm).sort(), ['permissionMode', 'sessionId', 'type'])
  const user = lines[2]
  assert.equal(user.type, 'user')
  assert.equal(user.parentUuid, null)
  assert.equal(typeof user.message.content, 'string')
  assert.equal(user.cwd, 'D:\\demo\\proj')
  const asst = lines[3]
  assert.equal(asst.type, 'assistant')
  assert.equal(asst.parentUuid, user.uuid)
  assert.equal(asst.message.stop_reason, 'end_turn')
})

test('export_claude 带标题会话：ai-title 放首个 user 后、assistant 前；返回 title', async () => {
  const tree = { 'D:\\demo\\proj\\sess-title-001.jsonl': load('sess-title-001.jsonl') }
  const { ctx, writes } = makeCtx(tree)
  apply(ctx)
  await registeredDef(ctx, 'import_claude').execute({ path: 'D:\\demo\\proj\\sess-title-001.jsonl' })

  const def = registeredDef(ctx, 'export_claude')
  const value = await def.execute({ sessionId: 'import-sess-title-001', outputDir: OUT })
  assert.equal(value.recordCount, 5) // mode + permission-mode + user + ai-title + assistant
  assert.equal(typeof value.title, 'string')
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])

  const lines = writes[0].content.slice(0, -1).split('\n').map((l) => JSON.parse(l))
  const user = lines[2]
  const ai = lines[3]
  assert.equal(ai.type, 'ai-title')
  assert.equal(ai.aiTitle, value.title)
  assert.equal(Object.hasOwn(ai, 'uuid'), false)
  assert.equal(Object.hasOwn(ai, 'parentUuid'), false)
  assert.equal(lines[4].parentUuid, user.uuid) // assistant 链越过 ai-title
})

test('export_claude 工具会话：tool_use/tool_result 配对、sourceToolAssistantUUID、stop_reason', async () => {
  const tree = { 'D:\\demo\\proj\\sess-tool-001.jsonl': load('sess-tool-001.jsonl') }
  const { ctx, writes } = makeCtx(tree)
  apply(ctx)
  await registeredDef(ctx, 'import_claude').execute({ path: 'D:\\demo\\proj\\sess-tool-001.jsonl' })

  const def = registeredDef(ctx, 'export_claude')
  const value = await def.execute({ sessionId: 'import-sess-tool-001', outputDir: OUT })
  assert.equal(value.recordCount, 6) // mode + permission-mode + user + assistant + tool_result + assistant
  assert.equal(value.mapping.toolCalls, 1)
  assert.equal(value.mapping.toolResults, 1)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])

  const lines = writes[0].content.slice(0, -1).split('\n').map((l) => JSON.parse(l))
  const asst1 = lines[3]
  const thinking = asst1.message.content.find((b) => b.type === 'thinking')
  assert.deepEqual(thinking, { type: 'thinking', thinking: thinking.thinking, signature: '' })
  const toolUse = asst1.message.content.find((b) => b.type === 'tool_use')
  assert.ok(toolUse)
  assert.equal(toolUse.name, 'Bash')
  assert.deepEqual(toolUse.input, { command: 'ls -la' })
  assert.equal(asst1.message.stop_reason, 'tool_use')

  const tr = lines[4]
  assert.equal(tr.type, 'user')
  assert.equal(tr.parentUuid, asst1.uuid)
  assert.equal(tr.sourceToolAssistantUUID, asst1.uuid)
  assert.equal(tr.message.content[0].type, 'tool_result')
  assert.equal(tr.message.content[0].tool_use_id, 'toolu_01')
  assert.equal(tr.message.content[0].content, 'README.md\nsrc\n')
  assert.equal(Object.hasOwn(tr.message.content[0], 'is_error'), false) // fixture is_error:false → 不写
  assert.equal(lines[5].message.stop_reason, 'end_turn')
})

test('export_claude dryRun：不写盘、返回目标路径与统计', async () => {
  const tree = { 'D:\\demo\\proj\\sess-simple-001.jsonl': load('sess-simple-001.jsonl') }
  const { ctx, writes } = makeCtx(tree)
  apply(ctx)
  await registeredDef(ctx, 'import_claude').execute({ path: 'D:\\demo\\proj\\sess-simple-001.jsonl' })

  const def = registeredDef(ctx, 'export_claude')
  const value = await def.execute({ sessionId: 'import-sess-simple-001', outputDir: OUT, dryRun: true })
  assert.equal(value.dryRun, true)
  assert.equal(writes.length, 0) // 不写盘
  assert.equal(typeof value.filePath, 'string')
  assert.equal(value.recordCount, 4)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
})

test('export_claude cwd 覆盖：slug/记录 cwd 用入参而非 header', async () => {
  const tree = { 'D:\\demo\\proj\\sess-simple-001.jsonl': load('sess-simple-001.jsonl') }
  const { ctx, writes } = makeCtx(tree)
  apply(ctx)
  await registeredDef(ctx, 'import_claude').execute({ path: 'D:\\demo\\proj\\sess-simple-001.jsonl' })

  const value = await registeredDef(ctx, 'export_claude').execute({
    sessionId: 'import-sess-simple-001',
    outputDir: OUT,
    cwd: "C:\\Users\\Meier's\\work", // 含非字母数字：验证 slug 替换
  })
  assert.equal(value.cwd, "C:\\Users\\Meier's\\work")
  assert.equal(value.slug, 'C--Users-Meier-s-work')
  assert.equal(value.filePath, join(OUT, 'C--Users-Meier-s-work', value.sessionId + '.jsonl'))
  const lines = writes[0].content.slice(0, -1).split('\n').map((l) => JSON.parse(l))
  assert.equal(lines[2].cwd, "C:\\Users\\Meier's\\work")
})

test('export_claude 会话不存在：抛错', async () => {
  const { ctx } = makeCtx({})
  apply(ctx)
  const def = registeredDef(ctx, 'export_claude')
  await assert.rejects(() => def.execute({ sessionId: 'no-such-session' }), /会话不存在/)
})

test('export_claude 无 cwd（header 无且未提供）：抛错', async () => {
  const { ctx, persistence } = makeCtx({})
  await seedSession(persistence, 'sess-nocwd', { version: 0, id: 'sess-nocwd', createdAt: 1786000000000 }, [
    mkEvent('user/message', 0, 1786000000000, { id: 'u1', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }, { surfaceOp: 'append' }),
    mkEvent('assistant/message', 1, 1786000000000, { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'hello' }], source: { kind: 'model', provider: 'dsh' } }, { surfaceOp: 'append' }),
  ])
  apply(ctx)
  const def = registeredDef(ctx, 'export_claude')
  await assert.rejects(() => def.execute({ sessionId: 'sess-nocwd' }), /cwd/)
})

test('export_claude createIfAbsent：目标已存在（uuid 碰撞模拟）时不覆盖', async () => {
  const tree = { 'D:\\demo\\proj\\sess-simple-001.jsonl': load('sess-simple-001.jsonl') }
  const { ctx } = makeCtx(tree)
  apply(ctx)
  await registeredDef(ctx, 'import_claude').execute({ path: 'D:\\demo\\proj\\sess-simple-001.jsonl' })

  const fixed = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  const target = join(OUT, 'D--demo-proj', fixed + '.jsonl')
  tree[target] = 'preexisting' // 目标文件已存在
  await assert.rejects(
    () => exportClaudeSession(ctx, { sessionId: 'import-sess-simple-001', outputDir: OUT }, { uuid: () => fixed }),
    /EEXIST/,
  )
  assert.equal(tree[target], 'preexisting') // 未被覆盖
})

test('export_claude 注入会话：非人类 user/message 跳过并计数', async () => {
  const { ctx, persistence, writes } = makeCtx({})
  await seedSession(persistence, 'sess-inject', { version: 0, id: 'sess-inject', createdAt: 1786000000000, cwd: 'D:\\demo\\proj' }, [
    mkEvent('user/message', 0, 1786000000000, { id: 'i1', role: 'user', content: [{ type: 'text', text: '系统注入' }], source: { kind: 'system' } }, { surfaceOp: 'append' }),
    mkEvent('user/message', 1, 1786000000000, { id: 'u1', role: 'user', content: [{ type: 'text', text: '真实提问' }], source: { kind: 'user' } }, { surfaceOp: 'append' }),
    mkEvent('assistant/message', 2, 1786000000000, { id: 'a1', role: 'assistant', content: [{ type: 'text', text: '回答' }], source: { kind: 'model', provider: 'dsh' } }, { surfaceOp: 'append' }),
  ])
  apply(ctx)
  const def = registeredDef(ctx, 'export_claude')
  const value = await def.execute({ sessionId: 'sess-inject', outputDir: OUT })
  assert.equal(value.mapping.skippedInjections, 1)
  assert.equal(value.recordCount, 4) // 注入不落记录
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
  const lines = writes[0].content.slice(0, -1).split('\n').map((l) => JSON.parse(l))
  assert.equal(lines[2].message.content, '真实提问')
  assert.equal(lines[2].parentUuid, null) // 首个真实 user 成为链头
})

test('export_claude 中断会话：末尾补发空 tool_result，会话日志只读不被触碰', async () => {
  const { ctx, persistence, writes } = makeCtx({})
  const events = [
    mkEvent('user/message', 0, 1786000000000, { id: 'u1', role: 'user', content: [{ type: 'text', text: '提问' }], source: { kind: 'user' } }, { surfaceOp: 'append' }),
    mkEvent('assistant/message', 1, 1786000000000, { turn: 1, step: 1, id: 'a1', role: 'assistant', content: [{ type: 'tool-call', id: 'callZ', name: 'Bash', arguments: '{}' }], source: { kind: 'model', provider: 'dsh' } }, { surfaceOp: 'append' }),
    mkEvent('tool/call', 2, 1786000000000, { turn: 1, step: 1, callId: 'callZ', name: 'Bash', arguments: '{}' }),
  ]
  await seedSession(persistence, 'sess-interrupted', { version: 0, id: 'sess-interrupted', createdAt: 1786000000000, cwd: 'D:\\demo\\proj' }, events)
  apply(ctx)
  const def = registeredDef(ctx, 'export_claude')
  const value = await def.execute({ sessionId: 'sess-interrupted', outputDir: OUT })
  assert.equal(value.recordCount, 5) // 末尾补发 1 条
  assert.equal(value.mapping.toolResults, 1)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])

  const lines = writes[0].content.slice(0, -1).split('\n').map((l) => JSON.parse(l))
  const last = lines[4]
  assert.equal(last.message.content[0].type, 'tool_result')
  assert.deepEqual(last.message.content[0].content, [])
  assert.equal(last.parentUuid, lines[3].uuid)
  // 会话日志未被触碰（只读来源）
  const saved = persistence.sessions.get('sess-interrupted')
  assert.equal(saved.events.length, events.length)
  assert.equal(saved.events.filter((e) => e.type === 'tool/result').length, 0)
})

// 辅助：从 ctx.tools 按名字取回定义（apply 内部调用 register）
function registeredDef(ctx, toolName = 'import_claude') {
  return ctx.tools.registered(toolName)
}
