import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const CONFIG_FILE = join(homedir(), '.agent-balance.json')

export const DEFAULTS = {
  // 价格表（元/百万 tokens）
  pricing: { inputPerM: 1, outputPerM: 3, cacheReadPerM: 0.1, currency: 'CNY' },
  // 可选：把 key 存这里（环境变量优先）
  keys: {},
  providers: [
    { id: 'deepseek', enabled: true, template: 'deepseek' },
    { id: 'openai', enabled: false, template: 'openai' },
    { id: 'openrouter', enabled: false, template: 'openrouter' },
    { id: 'anthropic', enabled: false, template: 'anthropic' },
    { id: 'moonshot', enabled: false, template: 'moonshot' },
  ],
}

export function configPath() {
  return CONFIG_FILE
}

export function loadConfig() {
  if (!existsSync(CONFIG_FILE)) return structuredClone(DEFAULTS)
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return structuredClone(DEFAULTS)
    }
    return {
      ...DEFAULTS,
      ...parsed,
      providers: Array.isArray(parsed.providers) ? parsed.providers : DEFAULTS.providers,
    }
  } catch {
    return structuredClone(DEFAULTS)
  }
}

export function saveConfig(config) {
  mkdirSync(dirname(CONFIG_FILE), { recursive: true })
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8')
}
