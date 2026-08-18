# agent-balance

零依赖 CLI：**查多供应商 API 余额** + **统计 Codex / Claude Code 的 token 用量与估算金额**。不依赖任何框架，普通命令行用户、Codex、Claude Code 用户都能用。

## 安装

```bash
npm i -g agent-balance
# 或本地开发：
npm link
```

## 用法

```bash
agent-balance check    # 查各供应商余额
agent-balance usage    # 统计当前目录的 Codex/Claude Code 用量
agent-balance config   # 查看配置
agent-balance init     # 初始化配置
```

## 配置

配置文件：`~/.agent-balance.json`（首次运行 `agent-balance init` 生成，或直接手动创建）。

```json
{
  "pricing": { "inputPerM": 1, "outputPerM": 3, "cacheReadPerM": 0.1, "currency": "CNY" },
  "keys": {},
  "providers": [
    { "id": "deepseek", "enabled": true, "template": "deepseek" },
    { "id": "openai", "enabled": true, "template": "openai" },
    {
      "id": "my-api",
      "enabled": true,
      "template": "custom",
      "name": "My API",
      "endpoint": "https://example.com/api/balance",
      "apiKeyRef": "MY_API_KEY",
      "authScheme": "Bearer",
      "balancePath": "data.balance",
      "currency": "USD",
      "symbol": "$"
    }
  ]
}
```

- `pricing`：金额估算价格表（元/百万 tokens）。
- `keys`：可选，把 API key 明文存这里（**环境变量优先**，如 `OPENAI_API_KEY`；这里作兜底）。
- `providers`：供应商列表，`template` 走预设模板，`"custom"` 自定义端点。

## 预设模板

| template | 余额字段 | 币种 | Key |
|---|---|---|---|
| `deepseek` | `balance_infos[0].total_balance` | CNY | `DEEPSEEK_API_KEY` |
| `openai` | `total_available` | USD | `OPENAI_API_KEY` |
| `openrouter` | `data.total_credits` | USD | `OPENROUTER_API_KEY` |
| `anthropic` | `data[0].effective_amount.usd` | USD | `ANTHROPIC_API_KEY` |
| `moonshot` | `data.available_balance` | CNY | `MOONSHOT_API_KEY` |

## 自定义端点字段

| 字段 | 说明 |
|---|---|
| `template` | `"custom"` 自定义，其余走预设模板 |
| `endpoint` | 余额接口完整 URL |
| `apiKeyRef` | 环境变量/keys 里的 key 名 |
| `authScheme` | `Bearer` 或 `raw` |
| `authHeader` | 鉴权头名（默认 `authorization`） |
| `headers` | 额外固定请求头 |
| `orgId` | endpoint 中 `{orgId}` 占位符的替换值 |
| `balancePath` | 余额字段路径，支持 `a.b[0].c` |
| `currencyPath` / `currency` / `symbol` | 币种与符号 |

## 用量统计

按「当前目录」聚合：

- **Codex**：读 `~/.codex/sessions` + `archived_sessions`，取每个 rollout 最后一个 `token_count.total_token_usage`。
- **Claude Code**：读 `~/.claude/projects/<encoded-cwd>/`，累加 `assistant.message.usage`。

金额按 `pricing` 价格表估算（参考值，非账单级精确）。

## License

MIT
