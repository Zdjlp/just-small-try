#!/usr/bin/env node
import { loadConfig, saveConfig, configPath, DEFAULTS } from '../lib/config.js'
import { checkAll } from '../lib/balance.js'
import { computeUsage } from '../lib/usage.js'

function formatTokens(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'
  return String(n)
}

function formatBalance(p) {
  const n = Number(p.balance)
  const s = Number.isFinite(n) ? n.toFixed(2) : String(p.balance)
  return (p.symbol || '') + s
}

async function cmdCheck() {
  const config = loadConfig()
  const results = await checkAll(config)
  if (results.length === 0) {
    console.log('没有启用的供应商。运行 `agent-balance config` 查看/修改配置。')
    return
  }
  for (const r of results) {
    if (r.ok) console.log(`${r.name}: ${formatBalance(r)} (${r.currency || '?'})`)
    else console.log(`${r.name}: ${r.error}`)
  }
}

async function cmdUsage() {
  const config = loadConfig()
  const u = await computeUsage(process.cwd(), config.pricing)
  console.log(`项目: ${u.project}`)
  const codex = u.bySource.codex
  const claude = u.bySource.claude
  if (codex.sessionCount > 0) {
    console.log(`Codex (${codex.sessionCount} 会话): ${formatTokens(codex.input + codex.output + codex.cache)} tok`)
  }
  if (claude.sessionCount > 0) {
    console.log(`Claude Code (${claude.sessionCount} 会话): ${formatTokens(claude.input + claude.output + claude.cache)} tok`)
  }
  if (codex.sessionCount === 0 && claude.sessionCount === 0) {
    console.log('当前目录没有检测到 Codex / Claude Code 用量')
  } else {
    const total = u.tokens.input + u.tokens.output + u.tokens.cache // output 已含 reasoning
    const range = u.costPeak && u.costPeak > u.cost ? `${u.cost}~${u.costPeak}` : `${u.cost}`
    console.log(`合计: ${formatTokens(total)} tok · 估算 ¥${range}（空闲~高峰时段）`)
  }
}

function cmdConfig() {
  console.log(`配置文件: ${configPath()}`)
  console.log(JSON.stringify(loadConfig(), null, 2))
}

function cmdInit() {
  saveConfig(structuredClone(DEFAULTS))
  console.log(`已初始化配置: ${configPath()}`)
}

function help() {
  console.log([
    'agent-balance — 查 API 余额 + 统计 Codex/Claude Code 用量',
    '',
    '用法:',
    '  agent-balance check    查各供应商余额',
    '  agent-balance usage    统计当前目录的 Codex/Claude Code 用量',
    '  agent-balance config   查看配置',
    '  agent-balance init     初始化配置',
  ].join('\n'))
}

const cmd = process.argv[2] || 'check'
if (cmd === 'check') await cmdCheck()
else if (cmd === 'usage') await cmdUsage()
else if (cmd === 'config') cmdConfig()
else if (cmd === 'init') cmdInit()
else if (cmd === 'help' || cmd === '--help' || cmd === '-h') help()
else { console.log(`未知命令: ${cmd}`); help() }
