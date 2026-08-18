// 供应商余额模板（默认 endpoint / 鉴权 / 解析路径 / 币种 / 符号）
export const TEMPLATES = {
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

/** 把一条 provider 配置解析成最终请求参数（模板默认 + 用户覆盖）。 */
export function resolveProvider(p) {
  const t = p && p.template && p.template !== 'custom' ? TEMPLATES[p.template] : null
  if (!t) return p || {}
  return { ...t, ...p }
}

/** 解析 `a.b[0].c` 风格路径。 */
export function resolvePath(obj, path) {
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
