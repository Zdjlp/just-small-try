import { resolveProvider, resolvePath } from './templates.js'
import { resolveKey } from './credentials.js'

/** 拉取单个提供商的余额。 */
export async function fetchProvider(p, config) {
  const prov = resolveProvider(p)
  const keyRef = prov.apiKeyRef || 'DEEPSEEK_API_KEY'
  const key = resolveKey(keyRef, config)
  if (!key) return { id: prov.id, name: prov.name || prov.id, ok: false, error: `未配置 ${keyRef}` }

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
    return { id: prov.id, name: prov.name || prov.id, ok: false, error: '网络错误' }
  }

  let text = ''
  try { text = await res.text() } catch { /* 忽略 */ }

  if (res.status === 401 || res.status === 403) {
    return { id: prov.id, name: prov.name || prov.id, ok: false, error: 'Key 无效或已失效' }
  }
  if (!res.ok) return { id: prov.id, name: prov.name || prov.id, ok: false, error: `HTTP ${res.status}` }

  let body
  try { body = JSON.parse(text) } catch {
    return { id: prov.id, name: prov.name || prov.id, ok: false, error: '响应非 JSON' }
  }

  const balance = resolvePath(body, prov.balancePath)
  if (balance === undefined || balance === null || balance === '') {
    return { id: prov.id, name: prov.name || prov.id, ok: false, error: '无法获取余额' }
  }
  const currency = prov.currencyPath ? resolvePath(body, prov.currencyPath) : prov.currency

  return {
    id: prov.id,
    name: prov.name || prov.id,
    ok: true,
    balance: String(balance),
    currency: String(currency || ''),
    symbol: prov.symbol || '',
  }
}

/** 查所有启用的供应商。 */
export async function checkAll(config) {
  const providers = (config.providers || []).filter((p) => p.enabled !== false)
  const results = []
  for (const p of providers) {
    results.push(await fetchProvider(p, config))
  }
  return results
}
