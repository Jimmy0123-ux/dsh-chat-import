// lib/dsh.mjs — DSH 自身会话日志（session.jsonl / session.jsonl.zstd）的读取
// 与目录收集适配。DSH 落盘是 zstd 压缩 JSONL，fs.readText 不解压，因此这里用
// 系统 zstd 二进制解压；无 zstd 时让错误自然上报到导入结果。
import { execFileSync } from 'node:child_process'

export function isDshSessionFile(name) {
  return /^session\.jsonl(?:\.zstd)?$/i.test(String(name || ''))
}

export function dshPath(target) {
  return target.displayPath || target.path || target
}

export async function readDshText(ctx, target) {
  const path = dshPath(target)
  if (/\.zstd$/i.test(path)) {
    return execFileSync('zstd', ['-dc', path], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    })
  }
  return ctx.fs.readText(target)
}

// 递归收集目录下的 session.jsonl(.zstd)；跳过 events/conflicts/guardian 等伴生文件。
export async function collectDshFiles(ctx, dirTarget, out, recursive) {
  const entries = await ctx.fs.listDir(dirTarget)
  for (const entry of entries) {
    if (entry.type === 'directory') {
      if (recursive) await collectDshFiles(ctx, entry.target, out, recursive)
    } else if (entry.type === 'file' && isDshSessionFile(entry.name)) {
      out.push(entry.target)
    }
  }
}
