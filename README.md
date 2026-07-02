# FallRouter · Sovereign Model Orchestrator

**Your AI keeps working when the API goes dark.**

Live: **https://sjgant80-hub.github.io/fallrouter/**

FallRouter is a sovereign kernel that sits between your apps and any LLM (local Ollama or frontier Claude/OpenAI/Gemini). Every request is classified into a tier, routed to the cheapest leg that can serve it, and audited with a tamper-evident SHA-256 chain. When a frontier provider hits rate limits, gets export-controlled, disappears, or has a three-week outage — the local leg picks up automatically. Zero downtime. Zero vendor lock-in.

---

## What's in the repo

```
fallrouter/
├── index.html              ← landing page (marketing surface)
├── ai.html                 ← AI agent dossier (for LLM crawlers)
├── llms.txt                ← llms.txt manifest
├── robots.txt · sitemap.xml
├── service/                ← Node router service (OpenAI-compatible endpoint)
│   ├── router.mjs          ← the whole router in one file
│   ├── package.json
│   ├── .env.example
│   └── README.md
├── dashboard/              ← single-HTML sovereign dashboard
│   └── index.html
├── sdk/                    ← drop-in OpenAI-compatible client
│   ├── fallrouter.js       ← ESM · browser + Node + Deno
│   └── README.md
└── docker/                 ← one-command self-hosted deployment
    ├── docker-compose.yml
    ├── Dockerfile.router
    ├── .env.example
    └── README.md
```

## Quickstart

### Sovereign tier · free · ~5 minutes

**Prerequisites:** Node 20+ · Ollama installed with at least `llama3.2:3b` pulled.

```bash
git clone https://github.com/sjgant80-hub/fallrouter.git
cd fallrouter

# Ollama models
ollama pull llama3.2:3b
ollama pull llama3.1:8b

# router service
cd service
cp .env.example .env
# edit .env · set FR_MASTER_KEY to a random hex string
npm install
npm start
# → FallRouter · listening on http://127.0.0.1:4100

# use the hosted dashboard (points at your local router)
open https://sjgant80-hub.github.io/fallrouter/dashboard/
# ...or run it locally:
# cd ../dashboard && python -m http.server 8080

# smoke test
curl http://localhost:4100/v1/chat/completions \
  -H "Authorization: Bearer $FR_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Hello"}]}'
```

### Docker · full stack · ~10 minutes

```bash
cd docker/
cp .env.example .env
# edit .env · set FR_MASTER_KEY (optionally set frontier API keys)
docker compose up -d
```

See [docker/README.md](docker/README.md) for details.

## How the routing works

Every request is classified in <1ms by a deterministic sieve (length, code content, keywords) into one of four tiers:

| Tier | When | Default leg |
|---|---|---|
| **femto** | <50 chars · route/classify/yes-no | Local 3B model |
| **nano** | 50-500 chars · write/explain | Local 8B model |
| **milli** | >500 chars OR code+substantial · deep reasoning | Frontier (Claude Opus first) → fallback local 70B |
| **advisor** | Contains `check`/`verify`/`audit`/`review` | Frontier (advisor pattern · high-stakes) |

The router pings every provider every 30s. When a preferred leg is unavailable at request time, it routes to the next available. When the primary leg **errors mid-request**, it retries once against the smallest local model — the "ALWAYS WORKS" fallback.

Every routing decision writes to a SQLite audit chain with SHA-256 prev-hash links. Verify the chain from the dashboard's Audit tab or via `sqlite3 fallrouter.db`.

## Pricing tiers

| | |
|---|---|
| **Sovereign** · Free forever | Everything in this repo · MIT · runs on your hardware |
| **Hybrid** · £29/month | + managed frontier failover pool, reroute alerts, cost anomaly detection, email support |
| **Client** · £199/month | + persistent memory (vector DB), multi-model orchestration, white-label dashboard, priority support |

Sovereign is genuinely free forever · the paid tiers add convenience layers, not the core.

## OpenAI compatibility

The router exposes an OpenAI-compatible `/v1/chat/completions` endpoint. You can point the official OpenAI SDK straight at it:

```javascript
import OpenAI from 'openai';
const client = new OpenAI({
  baseURL: 'http://localhost:4100/v1',
  apiKey:  process.env.FR_MASTER_KEY,
});
const r = await client.chat.completions.create({
  model: 'auto',
  messages: [{ role: 'user', content: 'Hello' }],
});
console.log(r.choices[0].message.content);
console.log('routed via', r.fallrouter.leg, '→', r.model);
```

Or use the tiny bundled SDK (`sdk/fallrouter.js`) for streaming, health checks, cost summary, and policy switching. See [sdk/README.md](sdk/README.md).

## Composition with FallEnterprise

- [FallEnterprise](https://sjgant80-hub.github.io/fallenterprise/) is the productised transformation service (£20k-£200k engagements)
- FallRouter is the runtime kernel clients keep using after the engagement ends
- FallEnterprise's Sovereign tier includes FallRouter as its routing layer
- FallRouter is also standalone for anyone who just needs the router

## Design philosophy

Three principles from the [ai-nativesolutions.com](https://www.ai-nativesolutions.com/) estate:

1. **Sovereignty is structural, not marketing** — MIT + on-box + install-forever, not "£0/month"
2. **Single practitioner delivery** — every line of code written by Simon Gant, personally
3. **Every layer is optional but coherent** — dashboard, SDK, Docker, service — use one, all, or fork any

## License

MIT · © 2026 AI Native Solutions · Simon Gant

**◊·κ=1**
