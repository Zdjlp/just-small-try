import { createReadStream } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

async function forEachJsonlLine(path, cb) {
  let rl
  try {
    rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity })
  } catch {
    return
  }
  try {
    for await (const raw of rl) {
      let d
      try { d = JSON.parse(raw) } catch { continue }
      if (d && typeof d === 'object') cb(d)
    }
  } catch {
    /* 读中断：静默 */
  } finally {
    rl.close()
  }
}

async function collectJsonlFiles(root, out, maxDepth, depth) {
  if (depth > maxDepth) return
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const p = join(root, entry.name)
    if (entry.isDirectory()) await collectJsonlFiles(p, out, maxDepth, depth + 1)
    else if (entry.isFile() && p.endsWith('.jsonl')) out.push(p)
  }
}

/** Codex：取最后一个 token_count 的 total_token_usage（会话累计值）。 */
async function parseCodexUsage(path) {
  let cwd = ''
  let last = null
  await forEachJsonlLine(path, (d) => {
    if (d.type === 'session_meta' && d.payload && typeof d.payload.cwd === 'string') cwd = d.payload.cwd
    if (d.type === 'event_msg' && d.payload && d.payload.type === 'token_count' && d.payload.info && d.payload.info.total_token_usage) {
      last = d.payload.info.total_token_usage
    }
  })
  if (!last) return null
  return {
    cwd,
    input: (last.input_tokens || 0) - (last.cached_input_tokens || 0),
    output: last.output_tokens || 0,
    cache: last.cached_input_tokens || 0,
    reasoning: last.reasoning_output_tokens || 0,
  }
}

async function computeCodexUsage(cwd) {
  const files = []
  const root = join(homedir(), '.codex')
  for (const dir of ['sessions', 'archived_sessions']) {
    await collectJsonlFiles(join(root, dir), files, 6, 0)
  }
  let input = 0
  let output = 0
  let cache = 0
  let reasoning = 0
  let sessionCount = 0
  for (const path of files) {
    const r = await parseCodexUsage(path)
    if (r && r.cwd === cwd) {
      input += r.input
      output += r.output
      cache += r.cache
      reasoning += r.reasoning
      sessionCount++
    }
  }
  return { input, output, cache, reasoning, sessionCount }
}

function encodeClaudeCwd(cwd) {
  return cwd.replace(/[\\/:]/g, '-')
}

/** Claude Code：累加 assistant 记录的 usage。 */
async function parseClaudeUsage(path) {
  let input = 0
  let output = 0
  let cache = 0
  await forEachJsonlLine(path, (d) => {
    if (d.type === 'assistant' && d.message && d.message.usage) {
      const u = d.message.usage
      input += u.input_tokens || 0
      output += u.output_tokens || 0
      cache += u.cache_read_input_tokens || 0
    }
  })
  return { input, output, cache }
}

async function computeClaudeUsage(cwd) {
  const base = join(homedir(), '.claude', 'projects')
  const target = encodeClaudeCwd(cwd).toLowerCase()
  let entries
  try {
    entries = await readdir(base, { withFileTypes: true })
  } catch {
    return { input: 0, output: 0, cache: 0, reasoning: 0, sessionCount: 0 }
  }
  let input = 0
  let output = 0
  let cache = 0
  let sessionCount = 0
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name.toLowerCase() !== target) continue
    const files = []
    await collectJsonlFiles(join(base, entry.name), files, 2, 0)
    for (const path of files) {
      const r = await parseClaudeUsage(path)
      if (r) {
        input += r.input
        output += r.output
        cache += r.cache
        sessionCount++
      }
    }
  }
  return { input, output, cache, reasoning: 0, sessionCount }
}

/** 统计当前目录（cwd）在 Codex / Claude Code 上的用量。 */
export async function computeUsage(cwd, pricing) {
  const codex = await computeCodexUsage(cwd)
  const claude = await computeClaudeUsage(cwd)
  const tokens = {
    input: codex.input + claude.input,
    output: codex.output + claude.output,
    cache: codex.cache + claude.cache,
    reasoning: codex.reasoning + claude.reasoning,
  }
  const p = pricing || {}
  // output 已含 reasoning（Codex output_tokens 含 reasoning_output_tokens），不重复计。
  const cost = (tokens.input / 1e6) * (p.inputPerM || 0)
    + (tokens.cache / 1e6) * (p.cacheReadPerM || 0)
    + (tokens.output / 1e6) * (p.outputPerM || 0)
  const peakFactor = p.peakFactor || 1
  return {
    project: cwd,
    bySource: { codex, claude },
    tokens,
    cost: Number(cost.toFixed(4)),
    costPeak: Number((cost * peakFactor).toFixed(4)),
  }
}
