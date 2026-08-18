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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
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
}

/** 默认配置（首次运行写入配置文件）。 */
const DEFAULTS = {
  enabled: true,
  refreshMs: 300000,
  lowThreshold: 10,
  providers: [
    { id: 'deepseek', enabled: true, template: 'deepseek' },
    { id: 'openai', enabled: false, template: 'openai' },
    { id: 'openrouter', enabled: false, template: 'openrouter' },
    { id: 'anthropic', enabled: false, template: 'anthropic' },
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

/** 拉取单个提供商的余额。 */
async function fetchProvider(credentials, p) {
  const prov = resolveProvider(p)
  const keyRef = prov.apiKeyRef || 'DEEPSEEK_API_KEY'

  let key
  try {
    const hit = await credentials.resolve(keyRef)
    key = hit && hit.value
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
  const credentials = ctx.get('credentials')

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
            if (credentials) {
              for (const p of enabledProviders) {
                const r = await fetchProvider(credentials, p)
                if (r.ok) r.low = Number(r.balance) < Number(cfg.lowThreshold)
                providers.push(r)
              }
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

export { fetchProvider, resolvePath, resolveProvider, loadConfig }
