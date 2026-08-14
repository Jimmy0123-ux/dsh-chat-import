// lib/command.mjs — REQ-42 /import 命令面
//
// 斜杠命令 `/import <source> <path>`（用户触发、不占模型轮次）：解析 source（13 个
// 来源的短名 / 客户端来源 id / 工具全名三态）与 path（单文件或目录/数据根），复用
// 面板同一套导入编排（importDiscoveryItem + IMPORT_SPECS——幂等 / 增量 / force /
// 预算语义与 import_* 工具完全一致）。commands 是可选 host 服务（headless / CLI
// 会话可能不挂载），经 ctx.inject(['commands']) 延迟注册——服务缺席时命令不可用
// 但插件照常激活（与 webServer 晚挂载同一模式）。handler 执行自动落盘
// command/run + command/done 生命周期事件（官方 commands 服务），满足「模型可见
// ⟺ 落盘」。

import { resolveImportBudget } from './budget.mjs'
import { importDiscoveryItem } from './panel.mjs'

// 命令接受的来源名 → discovery format：短名（claude/codex/...）、客户端来源 id
// （claude-code）、工具全名（import_claude）三态都接受。
const TOOL_FORMAT = {
  claude: 'claude', 'claude-code': 'claude', import_claude: 'claude',
  codex: 'codex', import_codex: 'codex',
  chatgpt: 'chatgpt', import_chatgpt: 'chatgpt',
  cursor: 'cursor', import_cursor: 'cursor',
  gemini: 'gemini', import_gemini: 'gemini',
  reasonix: 'reasonix', import_reasonix: 'reasonix',
  opencode: 'opencode', import_opencode: 'opencode',
  zcode: 'zcode', import_zcode: 'zcode',
  grokbuild: 'grokbuild', import_grokbuild: 'grokbuild',
  openclaw: 'openclaw', import_openclaw: 'openclaw',
  pi: 'pi', import_pi: 'pi',
  hermes: 'hermes', import_hermes: 'hermes',
  kimi: 'kimi', import_kimi: 'kimi',
}

const SOURCE_NAMES = 'claude/codex/chatgpt/cursor/gemini/reasonix/opencode/zcode/grokbuild/openclaw/pi/hermes/kimi'

// 把导入结果压成人类可读文本（对齐 import_* 工具 render 的语义：批量计数 +
// 前 5 条失败/跳过明细；单文件按 status 区分）。
function summaryText(out) {
  if (out.mode === 'batch') {
    const bits = ['共扫描 ' + out.total + ' 个']
    if (out.imported) bits.push('新增 ' + out.imported)
    if (out.appended) bits.push('续写 ' + out.appended)
    if (out.alreadyImported) bits.push('已存在 ' + out.alreadyImported)
    if (out.skipped) bits.push('跳过 ' + out.skipped)
    if (out.failed) bits.push('失败 ' + out.failed)
    const detail = (out.results || []).filter((r) => r.status === 'failed' || r.status === 'skipped').slice(0, 5)
      .map((r) => '  - ' + r.path + (r.error ? '：' + r.error : r.reason ? '：' + r.reason : ''))
    return '批量导入完成：' + bits.join('，') + (detail.length ? '\n' + detail.join('\n') : '')
  }
  if (out.status === 'skipped' && out.sessionId === 'none') {
    return '跳过导入：' + (out.skipReason || '非目标格式 transcript')
  }
  if (out.status === 'appended') {
    return '会话 ' + out.sessionId + ' 已续写 ' + out.appendedTurns + ' 轮、' + out.appendedEvents + ' 条事件（源文件新增轮次）'
  }
  if (out.alreadyImported) {
    const why = out.sourceShrunk ? '源文件轮次减少（sourceShrunk），需要完整副本请用工具 force:true'
      : out.changedInPlace ? '源文件在既有轮次内变化（append-only 无法改写）'
        : out.argsChanged ? '导入参数已变化（args-changed），需要按新参数导入请用工具 force:true'
          : out.budgetChanged ? '上下文预算已变化（budget-changed），需要按新预算导入请用工具 force:true'
            : '源文件未变化'
    return '会话 ' + out.sessionId + ' 已存在，跳过导入：' + why + '。'
  }
  return '已导入 ' + out.turns + ' 轮对话（' + out.messages + ' 条消息、' + out.toolCalls + ' 次工具调用）→ 会话 ' + out.sessionId
}

export function registerImportCommand(ctx) {
  // commands 是可选 host 服务（REQ-29 命令面母项）：headless / 无命令服务的 profile
  // 下回调不执行，插件照常激活（与 webServer 晚挂载同一模式）。
  ctx.inject(['commands'], (cmdCtx) => cmdCtx.commands.register({
    name: 'import',
    description:
      '从外部聊天记录导入历史对话为可继续的 DSH 会话。用法：/import <source> <path>（source ∈ ' + SOURCE_NAMES +
      '；path 为 transcript 文件或会话目录/数据根——单文件导入、目录批量，幂等/增量/force/预算语义与 import_* 工具一致）。',
    input: { hint: '<source> <path>' },
    async handler(invocation) {
      const raw = String(invocation.rawInput || '').trim()
      const m = raw.match(/^(\S+)\s+(.+)$/)
      if (!m) {
        return { kind: 'error', text: '用法：/import <source> <path>（source ∈ ' + SOURCE_NAMES + '）' }
      }
      const format = TOOL_FORMAT[m[1].toLowerCase()]
      if (!format) return { kind: 'error', text: '未知来源: ' + m[1] + '（可用：' + SOURCE_NAMES + '）' }
      const path = m[2].trim()
      try {
        const budgetInfo = await resolveImportBudget(ctx, {})
        const out = await importDiscoveryItem(ctx, format, path, [], {
          budget: budgetInfo.budget,
          budgetSource: budgetInfo.source,
        })
        return { kind: 'success', text: summaryText(out) }
      } catch (err) {
        return { kind: 'error', text: '导入失败：' + String((err && err.message) || err) }
      }
    },
  }))
}
