# dsh-balance

DeepSeek Harness (DSH) 的**通用 API 余额 + 用量监控插件**：在对话输入框（Composer）下方显示多个 API 提供商的账户余额，以及当前项目的累计 token 用量与估算金额。

## 功能

- **多提供商余额**：内置 DeepSeek / OpenAI / OpenRouter / Anthropic / Kimi(Moonshot) 预设模板，并支持**自定义端点**（任意 HTTP API + JSON 解析路径）。
- **项目用量统计**：聚合当前项目（工作目录）在 **DSH / Codex / Claude Code** 上的累计 token 用量，按可配置价格表估算金额。
- **多币种**：余额默认按 API 返回的原生币种显示（¥ / $ …），符号随 `currency` 字段映射。
- **可开关**：总开关、各提供商开关、项目用量开关，均可在设置面板即时切换。
- **凭据免手改**：设置面板里直接填 key，写入 `$DSH_HOME/.credentials.yaml`，无需手动编辑文件。
- **轻量**：零 `@deepseek-ai` 依赖、零构建工具链；Host 用原生 `fetch`，Client 手写 CJS bundle。

## 目录结构

```
dsh-balance/
├── lib/
│   ├── index.js      # Host 半：余额/用量/凭据路由 + 配置存储 + 原生 fetch
│   └── client.js     # Client 半：Composer 徽章 + 设置面板（手写 bundle，无需构建）
├── package.json
├── LICENSE
└── README.md
```

## 安装

1. 将本目录放到一个稳定位置（例如 `D:\DSH\plugins\dsh-balance`）。
2. 编辑 profile 的 `package.json`（如 `D:\DSH\profiles\web\package.json`），在 `dependencies` 中加一行：

   ```json
   "dsh-balance": "link:D:/DSH/plugins/dsh-balance"
   ```

3. 编辑 profile 的 `cordis.patch.yml`，加入：

   ```yaml
   - insert:
       - id: dsh-balance
         name: dsh-balance
   ```

4. 在 profile 目录执行 `pnpm install`（建立本地 link）。
5. 重启 DSH。

## 配置

插件首次运行会生成 `$DSH_HOME/dsh-balance.json`（`$DSH_HOME` 即 `D:\DSH`）。也可在 Web UI 的「设置 → 余额监控」面板里修改。

```json
{
  "enabled": true,
  "usageEnabled": true,
  "refreshMs": 300000,
  "lowThreshold": 10,
  "pricing": { "inputPerM": 1, "outputPerM": 3, "cacheReadPerM": 0.1, "currency": "CNY" },
  "providers": [
    { "id": "deepseek",    "enabled": true,  "template": "deepseek" },
    { "id": "openai",      "enabled": false, "template": "openai" },
    { "id": "openrouter",  "enabled": false, "template": "openrouter" },
    { "id": "anthropic",   "enabled": false, "template": "anthropic" },
    { "id": "moonshot",    "enabled": false, "template": "moonshot" },
    {
      "id": "my-api",
      "enabled": false,
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

- `usageEnabled`：是否统计并显示项目用量（token/金额）。
- `pricing`：金额估算价格表（元/百万 tokens），可按各厂商当前价调整。

### 预设模板

| template | endpoint | 余额字段 | 币种 | Key |
|---|---|---|---|---|
| `deepseek` | `https://api.deepseek.com/user/balance` | `balance_infos[0].total_balance` | CNY | `DEEPSEEK_API_KEY` |
| `openai` | `https://api.openai.com/v1/dashboard/billing/credit_grants` | `total_available` | USD | `OPENAI_API_KEY` |
| `openrouter` | `https://openrouter.ai/api/v1/credits` | `data.total_credits` | USD | `OPENROUTER_API_KEY` |
| `anthropic` | `https://api.anthropic.com/v1/organizations/{orgId}/credit_grants` | `data[0].effective_amount.usd` | USD | `ANTHROPIC_API_KEY` |
| `moonshot` | `https://api.moonshot.cn/v1/users/me/balance` | `data.available_balance` | CNY | `MOONSHOT_API_KEY` |

> Anthropic 需要在 provider 配置里填 `orgId`（organization id）；余额默认取第一个 credit grant 的 `effective_amount.usd`（best-effort），精确统计请改用自定义端点。

### 自定义端点字段

| 字段 | 说明 |
|---|---|
| `template` | `"custom"` 表示自定义，其余走预设模板默认值 |
| `endpoint` | 余额接口完整 URL |
| `apiKeyRef` | 凭据名（即 `.credentials.yaml` 里的 key 名，环境变量风格） |
| `authScheme` | `Bearer`（拼 `Bearer <key>`）或 `raw`（原样发送 key） |
| `authHeader` | 鉴权头名（默认 `authorization`；Anthropic 用 `x-api-key`） |
| `headers` | 额外固定请求头，如 `{"anthropic-version":"2023-06-01"}` |
| `orgId` | endpoint 中 `{orgId}` 占位符的替换值（Anthropic 需要） |
| `balancePath` | 余额字段路径，支持 `a.b[0].c` 风格 |
| `currencyPath` | 币种字段路径（可选，缺省用 `currency`） |
| `currency` / `symbol` | 币种代码与显示符号 |

## 项目用量统计

按「当前项目 = 当前会话的工作目录」聚合，三个来源：

| 来源 | 读取位置 | 说明 |
|---|---|---|
| DSH | 会话日志 `assistant/message` 的 `usage` | 同 cwd 的所有会话累加 |
| Codex | `~/.codex/sessions` + `archived_sessions` | 取每个 rollout 最后一个 `token_count.total_token_usage` |
| Claude Code | `~/.claude/projects/<encoded-cwd>/` | 累加 `assistant.message.usage`（best-effort） |

- 金额目前只对 **DSH** 用 `pricing` 估算；Codex/Claude 暂只显示 token（各自价格表可后续补充）。
- Claude Code 的 cwd 目录名编码为 best-effort，未在有 Claude Code 数据的机器上验证。

## 凭据管理

插件复用 Harness 已有凭据（优先 `credentials` 服务，兜底读 `$DSH_HOME/.credentials.yaml`）。已配置的 key 无需重复填写（如 DeepSeek，DSH 自身即用它跑模型）；其他供应商在「设置 → 余额监控 → API Key 凭据」区块里填一次即可，key 只存 Host 端、不暴露给前端。

## License

MIT
