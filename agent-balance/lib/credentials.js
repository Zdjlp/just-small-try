// 读 key：环境变量优先，兜底读配置文件里的 keys 字段
export function resolveKey(ref, config) {
  if (process.env[ref]) return process.env[ref]
  if (config && config.keys && config.keys[ref]) return config.keys[ref]
  return undefined
}
