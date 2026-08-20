import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const CONFIG_FILE = join(homedir(), '.agent-balance.json')

export const DEFAULTS = {
  // 价格表（元/百万 tokens）——DeepSeek v4-pro 官方价（2026-08 定价页）。
  // 空闲时段价；高峰时段（北京 9:00-12:00、14:00-18:00）为 peakFactor 倍。
  // outputPerM 已含 reasoning（output_tokens 是总输出）。
  pricing: {
    currency: 'CNY',
    model: 'deepseek-v4-pro',
    inputPerM: 4.5,
    outputPerM: 13.5,
    cacheReadPerM: 0.15,
    peakFactor: 2,
  },
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
