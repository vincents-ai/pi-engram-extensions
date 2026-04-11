# Provider Types Reference

A quick reference on how each pi provider authenticates and what it costs.

## Auth methods

| Method | How it works | How to set up |
|---|---|---|
| **OAuth** | Token stored in `~/.pi/agent/auth.json` by pi itself | Run `/login` inside pi and follow the prompts |
| **API key (env var)** | Secret key in an environment variable | Add `export VAR=...` to your shell profile |
| **Free tier / no key** | Some providers work without a key (rate-limited) | Nothing to configure |

## Provider classifications

### Pre-paid subscriptions (flat monthly fee, no per-request cost)

| Provider | Auth method | Env var / mechanism | Notes |
|---|---|---|---|
| **z.ai** | API key | `ZAI_API_KEY` | Subscription — all models included |
| **GitHub Copilot** | OAuth | `~/.pi/agent/auth.json` | Pro ($10), Pro+ ($39), Business, Enterprise. Run `/login` in pi. |
| **Anthropic (Claude Pro/Max)** | OAuth | `ANTHROPIC_OAUTH_TOKEN` | Subscription; distinct from pay-per-use API key |

### Pay-per-use API keys (you pay per token)

| Provider | Env var |
|---|---|
| `openai` | `OPENAI_API_KEY` |
| `anthropic` (API) | `ANTHROPIC_API_KEY` |
| `mistral` | `MISTRAL_API_KEY` |
| `xai` | `XAI_API_KEY` |
| `cerebras` | `CEREBRAS_API_KEY` |
| `minimax` | `MINIMAX_API_KEY` |
| `kimi-coding` | `KIMI_API_KEY` |
| `openrouter` | `OPENROUTER_API_KEY` |
| `vercel-ai-gateway` | `AI_GATEWAY_API_KEY` |

### Free tier available (API key required but free quota exists)

| Provider | Env var | Free quota notes |
|---|---|---|
| `google` (Gemini) | `GEMINI_API_KEY` | Free tier: 15 RPM on Flash, 2 RPM on Pro |
| `groq` | `GROQ_API_KEY` | Free tier: generous rate limits on LLaMA/Gemma models |
| `huggingface` | `HF_TOKEN` | Free inference API (rate-limited) |

### GitHub Copilot model cost tiers (Pro+ $39/month, 1500 premium req/month)

| Multiplier | Models | Effective quota |
|---|---|---|
| 0× (free) | `gpt-4.1`, `gpt-4o`, `gpt-5-mini` | Unlimited |
| 0.25× | `grok-code-fast-1` | ~6 000 req/month |
| 0.33× | `claude-haiku-4.5`, `gemini-3-flash-preview`, `gpt-5.4-mini` | ~4 500 req/month |
| 1× | `claude-sonnet-4.6`, `gpt-5.4`, `gemini-2.5-pro`, `gpt-5.2-codex` | 1 500 req/month |
| 3× | `claude-opus-4.6`, `claude-opus-4.5` | ~500 req/month |

## Questions to ask the user

When running the setup skill, ask the user:

1. **z.ai** — do you still have an active z.ai subscription? Is `ZAI_API_KEY` set in your environment?
2. **GitHub Copilot** — what plan are you on (Free / Pro / Pro+ / Business / Enterprise)? This determines which models are available and what the premium request allowance is.
3. Any **new** subscriptions or API keys since the config was last set up?
4. Any **cancelled** subscriptions that should be removed from the failover list?
