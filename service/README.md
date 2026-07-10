# FallRouter · Service

Node.js router that sits between your client apps and any LLM (local or frontier).

## What it does

- Accepts **OpenAI-shape** requests (`POST /v1/chat/completions`)
- Classifies each request into **femto / nano / milli / advisor** based on length, code content, and keywords
- Picks the cheapest leg that can serve it (local first, frontier if needed)
- Automatically falls back to smallest local model if the primary leg fails
- Logs every routing decision with a **tamper-evident SHA-256 audit chain** (SQLite)
- Reports cost per request in USD (frontier only; local is TBA)

## Run it

```bash
cd service/
cp .env.example .env
# edit .env · set FR_MASTER_KEY (random hex) and any frontier API keys
npm install
npm start
```

Or in Docker (see `../docker/`).

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | — | Liveness + availability snapshot |
| GET | `/status` | — | Extended status + configured models |
| POST | `/v1/chat/completions` | Bearer | OpenAI-compatible chat endpoint |
| GET | `/audit?limit=100` | Bearer | Recent audit-chain entries |
| GET | `/cost` | Bearer | 30-day cost + token summary |
| POST | `/policy` `{policy: "auto\|always-local\|always-frontier"}` | Bearer | Runtime policy switch |

## OpenAI-compatible request

```bash
curl http://localhost:4100/v1/chat/completions \
  -H "Authorization: Bearer $FR_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "messages":[{"role":"user","content":"Explain the observer effect in one sentence"}],
    "max_tokens": 200
  }'
```

Response is a normal OpenAI-shape completion PLUS a `fallrouter` block:

```json
{
  "id":"...", "model":"llama3.1:8b",
  "choices":[{"message":{"role":"assistant","content":"..."}, "finish_reason":"stop"}],
  "usage":{"prompt_tokens":12,"completion_tokens":38,"total_tokens":50},
  "fallrouter": {
    "task_tier":"nano",
    "leg":"local",
    "reason":"medium prompt · standard generation | nano → local (sovereign default)",
    "latency_ms":842,
    "cost_usd":0,
    "audit_hash":"a1b2c3...",
    "status":"ok"
  }
}
```

## Classification rules (deterministic, no ML dependency)

| Input signal | Tier |
|---|---|
| Contains `check`, `verify`, `audit`, `review` | **advisor** → frontier (Anthropic first) |
| Contains code AND length > 300 chars | **milli** → frontier or local 70B |
| Length < 50 chars | **femto** → local 3B |
| Length 50–500 chars | **nano** → local 8B |
| Length > 500 chars | **milli** → frontier or local 70B |

## Auto-fallback logic

When the primary leg errors mid-request:

1. Log the failure to the audit chain
2. Retry against the smallest local model (`FR_LOCAL_FEMTO`)
3. Log the fallback (`leg: "fallback"`) so cost/reliability metrics are honest

Result: your client sees a successful response even when Anthropic + OpenAI are both dark. Slightly different model name in `response.model`, but the app keeps working. That's the pitch.

## Audit chain

Every routing decision is written to SQLite (`fallrouter.db`) with:

- Timestamp, request ID, tier, model, leg, reason, latency, tokens, cost, status
- `prev_hash` → chain link to previous entry
- `hash` → SHA-256 of `{entry, prev_hash}`

Verify:

```bash
sqlite3 fallrouter.db "SELECT ts,task_tier,leg,model_selected,cost_usd,status FROM audit ORDER BY id DESC LIMIT 10"
```

## Health checks

Every 30s the service pings:

- Ollama `/api/tags` (local leg)
- `https://api.anthropic.com/v1/models` (if key set)
- `https://api.openai.com/v1/models` (if key set)

The `availability` table + `/status` endpoint always reflect the last check.

## Zero-dep philosophy

The router has **one** dependency: `better-sqlite3` (needed for the audit chain persistence).
Everything else (HTTP, crypto, fetch) is Node built-in. No frameworks, no runtime CDN, no telemetry.

## Design goals achieved

- ✅ Sovereign by default (loopback bind, local-first policy)
- ✅ Zero downtime (auto-fallback to smallest local)
- ✅ Cost discipline (~90% local, ~10% frontier by architecture)
- ✅ Tamper-evident audit (SHA-256 chain)
- ✅ OpenAI-compatible (drop-in for existing apps)
- ✅ Deterministic classifier (no ML dep, no vendor lock-in)
