/**
 * dsh-balance — 通用 API 余额监控插件（Host 半）。
 *
 * 在 Composer 下方显示多个 API 提供商的账户余额，默认显示 API 原生币种。
 * 支持预设模板（DeepSeek / OpenAI / OpenRouter）+ 自定义端点，配置存
 * `$DSH_HOME/dsh-balance.json`，通过 `/dsh-balance` 前缀路由供 Client 拉取。
 *
 * 零 @deepseek-ai 依赖：用户级持久化插件 link 进 profile 后，node 模块解析
 * 链上拿不到这些包，因此只用 node 内置模块 + 运行时服务（ctx 注入）。
 */

import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { URL } from 'node:url'

export const name = 'dsh-balance'
// 无硬依赖：credentials 与 webServer 都是「可选/动态」注入，TUI 环境也能加载。
export const inject = []

/** DSH home（$DSH_HOME 优先，默认 ~/.dsh —— 与 dsh-paths 同款逻辑）。 */
function dshHome() {
  const env = process.env.DSH_HOME
  return env && env.trim() !== '' ? env.trim() : join(homedir(), '.dsh')
}

/** 配置文件名（每个 DSH home 一份）。 */
function configFile() {
  return join(dshHome(), 'dsh-balance.json')
}

/** 预设提供商模板：默认 endpoint / 鉴权 / 解析路径 / 币种 / 符号。 */
const TEMPLATES = {
  deepseek: {
    name: 'DeepSeek',
    endpoint: 'https://api.deepseek.com/user/balance',
    apiKeyRef: 'DEEPSEEK_API_KEY',
    authScheme: 'Bearer',
    balancePath: 'balance_infos[0].total_balance',
    currencyPath: 'balance_infos[0].currency',
    symbol: '¥',
  },
  openai: {
    name: 'OpenAI',
    endpoint: 'https://api.openai.com/v1/dashboard/billing/credit_grants',
    apiKeyRef: 'OPENAI_API_KEY',
    authScheme: 'Bearer',
    balancePath: 'total_available',
    currency: 'USD',
    symbol: '$',
  },
  openrouter: {
    name: 'OpenRouter',
    endpoint: 'https://openrouter.ai/api/v1/credits',
    apiKeyRef: 'OPENROUTER_API_KEY',
    authScheme: 'Bearer',
    balancePath: 'data.total_credits',
    currency: 'USD',
    symbol: '$',
  },
  anthropic: {
    name: 'Anthropic',
    endpoint: 'https://api.anthropic.com/v1/organizations/{orgId}/credit_grants',
    apiKeyRef: 'ANTHROPIC_API_KEY',
    authHeader: 'x-api-key',
    authScheme: 'raw',
    headers: { 'anthropic-version': '2023-06-01' },
    balancePath: 'data[0].effective_amount.usd',
    currency: 'USD',
    symbol: '$',
  },
  moonshot: {
    name: 'Kimi (Moonshot)',
    endpoint: 'https://api.moonshot.cn/v1/users/me/balance',
    apiKeyRef: 'MOONSHOT_API_KEY',
    authScheme: 'Bearer',
    balancePath: 'data.available_balance',
    currency: 'CNY',
    symbol: '¥',
  },
}

/** 默认配置（首次运行写入配置文件）。 */
const DEFAULTS = {
  enabled: true,
  usageEnabled: true,
  refreshMs: 300000,
  lowThreshold: 10,
  // 价格表（元/百万 tokens）——DeepSeek v4-pro 官方价（2026-08 定价页）。
  // 空闲时段价；高峰时段（北京 9:00-12:00、14:00-18:00）为 peakFactor 倍。
  // outputPerM 已含 reasoning（completion_tokens 是总输出）。
  pricing: {
    currency: 'CNY',
    model: 'deepseek-v4-pro',
    inputPerM: 4.5,      // 输入（缓存未命中）空闲价
    outputPerM: 13.5,    // 输出 空闲价
    cacheReadPerM: 0.15, // 输入（缓存命中）空闲价
    peakFactor: 2,       // 高峰时段倍率
  },
  providers: [
    { id: 'deepseek', enabled: true, template: 'deepseek' },
    { id: 'openai', enabled: false, template: 'openai' },
    { id: 'openrouter', enabled: false, template: 'openrouter' },
    { id: 'anthropic', enabled: false, template: 'anthropic' },
    { id: 'moonshot', enabled: false, template: 'moonshot' },
  ],
}

function cloneDefaults() {
  return JSON.parse(JSON.stringify(DEFAULTS))
}

/** 读取配置（文件缺失或损坏时回退默认）。 */
function loadConfig() {
  const file = configFile()
  if (!existsSync(file)) return cloneDefaults()
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return cloneDefaults()
    }
    return {
      ...DEFAULTS,
      ...parsed,
      providers: Array.isArray(parsed.providers) ? parsed.providers : DEFAULTS.providers,
    }
  } catch {
    return cloneDefaults()
  }
}

function saveConfig(config) {
  const file = configFile()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(config, null, 2), 'utf8')
}

/** 解析 `a.b[0].c` 风格路径，取不到返回 undefined。 */
function resolvePath(obj, path) {
  if (!path || typeof path !== 'string') return undefined
  const parts = path.replace(/\[/g, '.').replace(/\]/g, '').split('.').filter(Boolean)
  let value = obj
  for (const part of parts) {
    if (value === null || value === undefined) return undefined
    if (/^\d+$/.test(part)) value = value[Number(part)]
    else value = value[part]
  }
  return value
}

/** 把一条 provider 配置解析成最终请求参数（模板默认 + 用户覆盖）。 */
function resolveProvider(p) {
  const t = p && p.template && p.template !== 'custom' ? TEMPLATES[p.template] : null
  if (!t) return p || {}
  return { ...t, ...p }
}

/** 从 $DSH_HOME/.credentials.yaml 直接读取凭据（credentials 服务不可见时的兜底）。 */
function readCredentialFromFile(ref) {
  const file = join(dshHome(), '.credentials.yaml')
  if (!existsSync(file)) return undefined
  try {
    const content = readFileSync(file, 'utf8')
    const re = new RegExp('^\\s*' + ref + '\\s*:\\s*(\\S+)', 'm')
    const m = content.match(re)
    if (!m) return undefined
    return m[1].trim().replace(/^["']|["']$/g, '')
  } catch {
    return undefined
  }
}

/** 向 $DSH_HOME/.credentials.yaml 写入/更新一个凭据（保留其他行）。 */
function writeCredentialToFile(ref, value) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) throw new Error('非法凭据名')
  const v = String(value).trim()
  if (v === '') throw new Error('凭据值不能为空')
  const file = join(dshHome(), '.credentials.yaml')
  const lines = existsSync(file) ? readFileSync(file, 'utf8').split(/\r?\n/) : []
  let found = false
  for (let i = 0; i < lines.length; i++) {
    if (new RegExp('^\\s*' + ref + '\\s*:').test(lines[i])) {
      lines[i] = ref + ': ' + v
      found = true
      break
    }
  }
  if (!found) {
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
    lines.push(ref + ': ' + v)
  }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, lines.join('\n') + '\n', 'utf8')
}

/** 拉取单个提供商的余额。 */
async function fetchProvider(resolveKey, p) {
  const prov = resolveProvider(p)
  const keyRef = prov.apiKeyRef || 'DEEPSEEK_API_KEY'

  let key
  try {
    key = await resolveKey(keyRef)
  } catch {
    key = undefined
  }
  if (!key) return { id: prov.id, ok: false, error: `未配置 ${keyRef}` }

  // endpoint 占位符替换（如 {orgId}）
  let endpoint = prov.endpoint || ''
  if (prov.orgId) endpoint = endpoint.replace(/\{orgId\}/g, encodeURIComponent(prov.orgId))

  const headers = { accept: 'application/json' }
  const extra = prov.headers || {}
  for (const k in extra) headers[k] = extra[k]
  const authHeader = prov.authHeader || 'authorization'
  const scheme = prov.authScheme || 'Bearer'
  headers[authHeader] = scheme === 'raw' ? key : `${scheme} ${key}`

  let res
  try {
    res = await fetch(endpoint, { headers, signal: AbortSignal.timeout(15000) })
  } catch {
    return { id: prov.id, ok: false, error: '网络错误' }
  }

  let text = ''
  try { text = await res.text() } catch { /* 忽略读取失败，走下方状态判断 */ }

  if (res.status === 401 || res.status === 403) {
    return { id: prov.id, ok: false, error: 'Key 无效或已失效' }
  }
  if (!res.ok) return { id: prov.id, ok: false, error: `HTTP ${res.status}` }

  let body
  try { body = JSON.parse(text) } catch {
    return { id: prov.id, ok: false, error: '响应非 JSON' }
  }

  const balance = resolvePath(body, prov.balancePath)
  if (balance === undefined || balance === null || balance === '') {
    return { id: prov.id, ok: false, error: '无法获取余额' }
  }
  const currency = prov.currencyPath
    ? resolvePath(body, prov.currencyPath)
    : prov.currency

  return {
    id: prov.id,
    name: prov.name || prov.id,
    ok: true,
    balance: String(balance),
    currency: String(currency || ''),
    symbol: prov.symbol || '',
  }
}

/** 递归列出目录下的 .jsonl 文件（有界深度）。 */
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
    if (entry.isDirectory()) {
      await collectJsonlFiles(p, out, maxDepth, depth + 1)
    } else if (entry.isFile() && p.endsWith('.jsonl')) {
      out.push(p)
    }
  }
}

/** 逐行解析 JSONL（坏行跳过，IO 错误静默）。 */
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

/** 解析 Codex rollout：取最后一个 token_count 事件的 total_token_usage（会话累计值）。 */
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

/** 统计 Codex 在当前项目（cwd）的累计 token 用量。 */
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

/** Claude Code 的 cwd → projects 目录名编码（best-effort：路径分隔符与冒号 → '-'）。 */
function encodeClaudeCwd(cwd) {
  return cwd.replace(/[\\/:]/g, '-')
}

/** 解析 Claude Code session jsonl：累加 assistant 记录的 usage。 */
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

/** 统计 Claude Code 在当前项目（cwd）的累计 token 用量。 */
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

/** 统计「当前项目」（同 cwd 的所有会话）的累计 token 用量。 */
async function computeProjectUsage(ctx, sessionId) {
  const sessionQuery = ctx.get('sessionQuery')
  const sessionPersistence = ctx.get('sessionPersistence')

  let cwd
  if (sessionQuery) {
    try {
      const snap = await sessionQuery.readSession(sessionId)
      cwd = snap && snap.session && snap.session.cwd
    } catch { /* 忽略 */ }
  }
  if (!cwd && sessionPersistence) {
    try {
      const headers = await sessionPersistence.list()
      const h = headers.find((x) => String(x.id) === String(sessionId))
      cwd = h && h.cwd
    } catch { /* 忽略 */ }
  }
  if (!cwd) return { ok: false, error: '无法确定当前项目目录' }

  const logs = []
  if (sessionQuery) {
    try {
      const records = await sessionQuery.listSessions()
      for (const rec of records) {
        if (rec.header && rec.header.cwd === cwd) {
          try {
            const snap = await sessionQuery.readSession(rec.header.id)
            if (snap) logs.push(snap)
          } catch { /* 忽略 */ }
        }
      }
    } catch { /* 忽略 */ }
  } else if (sessionPersistence) {
    try {
      const headers = await sessionPersistence.list()
      for (const h of headers) {
        if (h.cwd === cwd) {
          try {
            const snap = await sessionPersistence.readFrom(h.id, 0)
            if (snap) logs.push(snap)
          } catch { /* 忽略 */ }
        }
      }
    } catch { /* 忽略 */ }
  }

  let input = 0
  let output = 0
  let cache = 0
  let reasoning = 0
  for (const log of logs) {
    const events = log.events || []
    for (const ev of events) {
      if (ev && ev.type === 'assistant/message' && ev.data && ev.data.usage) {
        const u = ev.data.usage
        input += u.inputTokens || 0
        output += u.outputTokens || 0
        cache += u.cacheReadTokens || 0
        reasoning += u.reasoningTokens || 0
      }
    }
  }

  const dsh = { input, output, cache, reasoning, sessionCount: logs.length }
  const codex = await computeCodexUsage(cwd)
  const claude = await computeClaudeUsage(cwd)

  return {
    ok: true,
    project: cwd,
    sessionCount: logs.length,
    tokens: {
      input: input + codex.input + claude.input,
      output: output + codex.output + claude.output,
      cache: cache + codex.cache + claude.cache,
      reasoning: reasoning + codex.reasoning + claude.reasoning,
    },
    bySource: { dsh, codex, claude },
  }
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(body)
}

async function readBody(req, maxBytes = 256 * 1024) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > maxBytes) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** 同源校验（保护本地写端点）：要求 JSON content-type + Origin host 与 Host 一致。 */
function sameOriginGuard(req) {
  const contentType = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
  if (contentType !== 'application/json') return '请求必须为 application/json'
  const host = String(req.headers.host ?? '')
  const origin = String(req.headers.origin ?? '')
  if (origin === '') return '缺少 Origin 头，已拒绝'
  let originHost = ''
  try { originHost = new URL(origin).host } catch { return '非法 Origin 头，已拒绝' }
  if (originHost !== host) return '跨站请求已拒绝'
  return null
}

export function apply(ctx) {
  // 凭据解析：优先 credentials 服务；服务不可见时兜底读 $DSH_HOME/.credentials.yaml。
  async function resolveKey(ref) {
    const credentials = ctx.get('credentials')
    if (credentials) {
      try {
        const hit = await credentials.resolve(ref)
        if (hit && hit.value) return hit.value
      } catch { /* 忽略，走文件兜底 */ }
    }
    return readCredentialFromFile(ref)
  }

  // webServer 是 web-only 服务：动态注入，TUI/无 web 环境也能加载。
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      const handler = async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const path = url.pathname
        try {
          // 余额快照（徽章轮询用）
          if (req.method === 'GET' && path === '/dsh-balance/api/state') {
            const cfg = loadConfig()
            if (cfg.enabled !== true) {
              sendJson(res, 200, { enabled: false, providers: [] })
              return
            }
            const enabledProviders = (cfg.providers || []).filter((p) => p.enabled !== false)
            const providers = []
            for (const p of enabledProviders) {
              const r = await fetchProvider(resolveKey, p)
              if (r.ok) r.low = Number(r.balance) < Number(cfg.lowThreshold)
              providers.push(r)
            }
            sendJson(res, 200, {
              enabled: true,
              refreshMs: cfg.refreshMs,
              lowThreshold: cfg.lowThreshold,
              providers,
            })
            return
          }
          // 配置读取（设置面板用）
          if (req.method === 'GET' && path === '/dsh-balance/api/config') {
            sendJson(res, 200, { config: loadConfig(), templates: TEMPLATES })
            return
          }
          // 当前项目用量（token + 估算金额）
          if (req.method === 'GET' && path === '/dsh-balance/api/usage') {
            const sessionId = url.searchParams.get('sessionId') || ''
            if (!sessionId) { sendJson(res, 400, { error: '缺少 sessionId' }); return }
            const cfg = loadConfig()
            if (cfg.usageEnabled !== true) { sendJson(res, 200, { ok: true, enabled: false }); return }
            const usage = await computeProjectUsage(ctx, sessionId)
            if (!usage.ok) { sendJson(res, 200, usage); return }
            const p = cfg.pricing || DEFAULTS.pricing
            const d = usage.bySource.dsh
            // outputTokens 已含 reasoningTokens（DeepSeek completion_tokens 是总输出），
            // 故金额只按 output 计，不再重复加 reasoning。
            const cost = (d.input / 1e6) * (p.inputPerM || 0)
              + (d.cache / 1e6) * (p.cacheReadPerM || 0)
              + (d.output / 1e6) * (p.outputPerM || 0)
            const peakFactor = p.peakFactor || 1
            sendJson(res, 200, {
              ...usage,
              cost: Number(cost.toFixed(4)),
              costPeak: Number((cost * peakFactor).toFixed(4)),
              pricing: p,
            })
            return
          }
          // 凭据配置状态（不返回 key 值，只返回是否已配置）
          if (req.method === 'GET' && path === '/dsh-balance/api/credentials') {
            const cfg = loadConfig()
            const list = (cfg.providers || []).map((p) => {
              const prov = resolveProvider(p)
              const ref = prov.apiKeyRef || 'DEEPSEEK_API_KEY'
              return {
                id: prov.id,
                name: prov.name || prov.id,
                apiKeyRef: ref,
                configured: readCredentialFromFile(ref) !== undefined,
              }
            })
            sendJson(res, 200, { providers: list })
            return
          }
          // 写入凭据（写到 .credentials.yaml）
          if (req.method === 'POST' && path === '/dsh-balance/api/credentials') {
            const guardError = sameOriginGuard(req)
            if (guardError !== null) { sendJson(res, 403, { error: guardError }); return }
            const body = await readBody(req)
            try {
              writeCredentialToFile(String(body.ref || ''), String(body.value || ''))
              sendJson(res, 200, { ok: true })
            } catch (e) {
              sendJson(res, 400, { error: e && e.message ? e.message : String(e) })
            }
            return
          }
          // 配置更新（设置面板写回）
          if (req.method === 'POST' && path === '/dsh-balance/api/config') {
            const guardError = sameOriginGuard(req)
            if (guardError !== null) { sendJson(res, 403, { error: guardError }); return }
            const body = await readBody(req)
            const current = loadConfig()
            const next = { ...current, ...body }
            if (Array.isArray(body.providers)) next.providers = body.providers
            saveConfig(next)
            sendJson(res, 200, { ok: true, config: next })
            return
          }
          sendJson(res, 404, { error: 'not found' })
        } catch (error) {
          sendJson(res, 400, { error: error && error.message ? error.message : String(error) })
        }
      }

      return webCtx.webServer.register({ kind: 'prefix', path: '/dsh-balance', handler })
    })
  })
}


