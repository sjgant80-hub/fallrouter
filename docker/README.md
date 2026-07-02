# FallRouter · Docker Stack

Self-contained · one command deploys the whole router + Ollama runtime.

## Prerequisites

- Docker Desktop or Docker Engine + Compose v2
- ~50GB disk (mostly for the model weights)
- NVIDIA container toolkit optional (for GPU acceleration · see docker-compose.yml)

## Quickstart

```bash
cd docker/
cp .env.example .env
# edit .env · set FR_MASTER_KEY to a random hex string
# (optional) add FR_ANTHROPIC_KEY / FR_OPENAI_KEY for frontier failover
docker compose up -d
docker compose logs -f ollama_bootstrap    # watch model download
```

After ~2-10 minutes (depending on download speed):

```bash
# health
curl http://localhost:4100/health

# smoke test
curl http://localhost:4100/v1/chat/completions \
  -H "Authorization: Bearer $(grep FR_MASTER_KEY .env | cut -d= -f2)" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Hello"}]}'
```

## What runs

| Container | Port (loopback) | Purpose |
|---|---|---|
| `fr_router` | 4100 | The FallRouter service |
| `fr_ollama` | 11434 | Ollama runtime · Llama models |
| `fr_ollama_bootstrap` | — | Runs once · pulls initial models |

Optional (uncomment in `docker-compose.yml`):

| Container | Port | Purpose |
|---|---|---|
| `fr_qdrant` | 6333 | Vector DB for episodic memory (Client tier) |

## Adding your fine-tuned model

If you fine-tuned Llama on your business data (e.g. via `fallenterprise/notebooks/lora-finetune.ipynb`):

```bash
# copy your GGUF file to the ollama volume
docker cp yourbiz-Q4_K_M.gguf fr_ollama:/root/.ollama/
docker exec fr_ollama sh -c "cat > /tmp/Modelfile <<'EOF'
FROM /root/.ollama/yourbiz-Q4_K_M.gguf
PARAMETER temperature 0.7
PARAMETER num_ctx 4096
EOF"
docker exec fr_ollama ollama create fe-yourbiz -f /tmp/Modelfile

# tell the router to use it
docker compose exec router sh -c "sed -i 's/FR_LOCAL_NANO=.*/FR_LOCAL_NANO=fe-yourbiz/' .env"
docker compose restart router
```

## Composition with FallEnterprise

If you're deploying alongside FallEnterprise's sovereign stack:

- FallEnterprise uses **LiteLLM** as its router by default
- FallRouter is a **drop-in upgrade** — same OpenAI-compatible endpoint, plus classifier + auto-failover + audit chain
- Point the FallEnterprise `smbaios-adapter.js` at `http://localhost:4100/v1/chat/completions` instead of the LiteLLM URL

## Uninstall

```bash
docker compose down -v         # -v also removes named volumes (model weights)
```

## Sovereignty checklist

- ✅ All ports loopback-only by default
- ✅ No telemetry
- ✅ Master key is your own random string
- ✅ Model weights local (Ollama volume)
- ✅ Audit chain local (SQLite in fallrouter_data volume)
- ✅ MIT licence · no vendor dependencies at runtime

## Backup

```bash
docker run --rm \
  -v ollama_models:/o -v fallrouter_data:/d -v $(pwd):/backup \
  alpine tar czf /backup/fallrouter-backup-$(date +%F).tar.gz -C / o d
```
