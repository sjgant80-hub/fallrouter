// FallRouter · Sovereign Model Orchestrator · Node service
// ─────────────────────────────────────────────────────────────────
// OpenAI-compatible endpoint that routes between local (Ollama) and
// frontier (Claude/OpenAI/Gemini) based on task classification,
// availability, cost policy, and advisor pattern.
//
// Single-file ESM · zero deps beyond node built-ins + better-sqlite3
// Run: node router.mjs
// Env: see .env.example
// ─────────────────────────────────────────────────────────────────
import http from 'node:http';
import crypto from 'node:crypto';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── config ──────────────────────────────────────────────────────
const cfg = {
  port: Number(process.env.FR_PORT || 4100),
  host: process.env.FR_HOST || '127.0.0.1',
  masterKey: process.env.FR_MASTER_KEY || 'sk-fallrouter-change-me',
  policy: process.env.FR_POLICY || 'auto',    // auto | always-local | always-frontier

  local: {
    url: process.env.FR_LOCAL_URL || 'http://127.0.0.1:11434',
    modelFemto: process.env.FR_LOCAL_FEMTO || 'llama3.2:3b',   // classify/route/yes-no
    modelNano:  process.env.FR_LOCAL_NANO  || 'llama3.1:8b',   // write/explain
    modelMilli: process.env.FR_LOCAL_MILLI || 'llama3.1:70b',  // deep reasoning (fallback = nano if unavailable)
  },

  frontier: {
    // Each entry: { name, url, key, model, priceIn, priceOut } · price in USD per 1M tokens
    anthropic: {
      url: 'https://api.anthropic.com/v1/messages',
      key: process.env.FR_ANTHROPIC_KEY,
      model: process.env.FR_ANTHROPIC_MODEL || 'claude-opus-4-8',
      priceIn: 15, priceOut: 75,
    },
    openai: {
      url: 'https://api.openai.com/v1/chat/completions',
      key: process.env.FR_OPENAI_KEY,
      model: process.env.FR_OPENAI_MODEL || 'gpt-4o',
      priceIn: 2.5, priceOut: 10,
    },
  },

  advisor: {
    fireOnKeywords: ['check', 'verify', 'audit', 'review'],
    fireOnLowConfidence: 0.6,       // if local worker returns <this confidence, escalate
    reservedFraction: 0.10,          // aim for 10% of tokens to hit frontier
  },

  healthCheckIntervalMs: 30000,
  requestTimeoutMs: 60000,
  dbPath: process.env.FR_DB || path.join(__dirname, 'fallrouter.db'),
};

// ─── SQLite audit chain + cost tracker ───────────────────────────
if (!existsSync(path.dirname(cfg.dbPath))) mkdirSync(path.dirname(cfg.dbPath), { recursive: true });
const db = new Database(cfg.dbPath);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    request_id TEXT NOT NULL,
    task_tier TEXT NOT NULL,
    model_selected TEXT NOT NULL,
    leg TEXT NOT NULL,               -- local | frontier | fallback
    reason TEXT,
    latency_ms INTEGER,
    tokens_in INTEGER,
    tokens_out INTEGER,
    cost_usd REAL DEFAULT 0,
    status TEXT NOT NULL,
    prev_hash TEXT,
    hash TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit(ts);
  CREATE TABLE IF NOT EXISTS availability (
    leg TEXT PRIMARY KEY,
    ok INTEGER,
    last_checked INTEGER,
    detail TEXT
  );
`);
const audit = {
  latestHash() {
    const row = db.prepare('SELECT hash FROM audit ORDER BY id DESC LIMIT 1').get();
    return row?.hash || 'GENESIS';
  },
  log(entry) {
    const prev = this.latestHash();
    const payload = JSON.stringify({ ...entry, prev_hash: prev });
    const hash = crypto.createHash('sha256').update(payload).digest('hex').slice(0, 32);
    db.prepare(`INSERT INTO audit
      (ts, request_id, task_tier, model_selected, leg, reason, latency_ms, tokens_in, tokens_out, cost_usd, status, prev_hash, hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      entry.ts, entry.request_id, entry.task_tier, entry.model_selected, entry.leg,
      entry.reason, entry.latency_ms, entry.tokens_in, entry.tokens_out,
      entry.cost_usd, entry.status, prev, hash
    );
    return hash;
  },
  recent(limit = 100) {
    return db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?').all(limit);
  },
  costSummary() {
    const row = db.prepare(`SELECT
      SUM(CASE WHEN leg='frontier' THEN cost_usd ELSE 0 END) AS frontier_cost,
      SUM(tokens_in + tokens_out) AS total_tokens,
      SUM(CASE WHEN leg='local' OR leg='fallback' THEN tokens_in + tokens_out ELSE 0 END) AS local_tokens,
      SUM(CASE WHEN leg='frontier' THEN tokens_in + tokens_out ELSE 0 END) AS frontier_tokens,
      COUNT(*) AS total_requests,
      SUM(CASE WHEN leg='fallback' THEN 1 ELSE 0 END) AS fallback_reroutes
      FROM audit WHERE ts > ?`).get(Date.now() - 30 * 86400_000);
    return row;
  },
};

// ─── task classifier (rule-based · sovereign · fast · deterministic) ──
function classify(messages) {
  const last = messages.at(-1)?.content || '';
  const text = String(last).trim();
  const len = text.length;
  const hasCode = /```|def |function |class |import |const |let /.test(text);
  const wantsCheck = cfg.advisor.fireOnKeywords.some(k => text.toLowerCase().includes(k));

  if (wantsCheck) return { tier: 'advisor', reason: 'user requested check/verify/audit' };
  if (hasCode && len > 300) return { tier: 'milli', reason: 'code + substantial length' };
  if (len < 50) return { tier: 'femto', reason: 'short prompt · route/classify/yes-no' };
  if (len < 500) return { tier: 'nano', reason: 'medium prompt · standard generation' };
  return { tier: 'milli', reason: 'long prompt · deep reasoning' };
}

// ─── availability polling ────────────────────────────────────────
const availability = { local: true, anthropic: false, openai: false };

async function ping(url, key = null, timeoutMs = 3000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers = { 'accept': 'application/json' };
    if (key) headers['authorization'] = `Bearer ${key}`;
    const resp = await fetch(url, { method: 'HEAD', signal: ctrl.signal, headers });
    return { ok: resp.ok || resp.status === 405, status: resp.status };
  } catch (e) {
    return { ok: false, status: 0, detail: e.message.slice(0, 80) };
  } finally { clearTimeout(t); }
}

async function refreshAvailability() {
  const ollama = await ping(cfg.local.url + '/api/tags');
  availability.local = ollama.ok;
  db.prepare('INSERT OR REPLACE INTO availability (leg,ok,last_checked,detail) VALUES (?,?,?,?)')
    .run('local', ollama.ok ? 1 : 0, Date.now(), JSON.stringify(ollama));

  if (cfg.frontier.anthropic.key) {
    // Anthropic /v1/messages doesn't accept HEAD; we ping models endpoint which is cheap
    const p = await ping('https://api.anthropic.com/v1/models', cfg.frontier.anthropic.key);
    availability.anthropic = p.ok || p.status === 200;
    db.prepare('INSERT OR REPLACE INTO availability (leg,ok,last_checked,detail) VALUES (?,?,?,?)')
      .run('anthropic', availability.anthropic ? 1 : 0, Date.now(), JSON.stringify(p));
  }
  if (cfg.frontier.openai.key) {
    const p = await ping('https://api.openai.com/v1/models', cfg.frontier.openai.key);
    availability.openai = p.ok || p.status === 200;
    db.prepare('INSERT OR REPLACE INTO availability (leg,ok,last_checked,detail) VALUES (?,?,?,?)')
      .run('openai', availability.openai ? 1 : 0, Date.now(), JSON.stringify(p));
  }
}
setInterval(refreshAvailability, cfg.healthCheckIntervalMs).unref();
refreshAvailability();

// ─── routing decision ────────────────────────────────────────────
function chooseLeg(tier) {
  // Policy override
  if (cfg.policy === 'always-local') return { leg: 'local', reason: 'policy: always-local' };
  if (cfg.policy === 'always-frontier') {
    if (availability.anthropic) return { leg: 'frontier', provider: 'anthropic', reason: 'policy: always-frontier' };
    if (availability.openai)    return { leg: 'frontier', provider: 'openai',    reason: 'policy: always-frontier' };
    return { leg: 'fallback', reason: 'policy: always-frontier but none available · falling back' };
  }
  // Auto
  if (tier === 'femto' || tier === 'nano') {
    if (availability.local) return { leg: 'local', reason: `${tier} → local (sovereign default)` };
    if (availability.anthropic) return { leg: 'frontier', provider: 'anthropic', reason: 'local down · frontier fallback' };
    if (availability.openai) return { leg: 'frontier', provider: 'openai', reason: 'local down · frontier fallback' };
    return { leg: 'fallback', reason: 'no legs available' };
  }
  if (tier === 'milli') {
    if (availability.anthropic) return { leg: 'frontier', provider: 'anthropic', reason: 'milli → frontier for deep reasoning' };
    if (availability.openai) return { leg: 'frontier', provider: 'openai', reason: 'milli → openai (anthropic unavailable)' };
    if (availability.local) return { leg: 'local', reason: 'milli · frontier down · local best-effort' };
    return { leg: 'fallback', reason: 'no legs available' };
  }
  if (tier === 'advisor') {
    if (availability.anthropic) return { leg: 'frontier', provider: 'anthropic', reason: 'advisor pattern → Claude (specialty)' };
    if (availability.openai) return { leg: 'frontier', provider: 'openai', reason: 'advisor · anthropic down' };
    if (availability.local) return { leg: 'local', reason: 'advisor · frontier down · local best-effort' };
    return { leg: 'fallback', reason: 'no legs available' };
  }
  return { leg: 'fallback', reason: 'unknown tier' };
}

// ─── call: local (Ollama /api/chat) ──────────────────────────────
async function callLocal(model, messages, opts = {}) {
  const body = { model, messages, stream: false, options: { temperature: opts.temperature ?? 0.7 } };
  const resp = await fetch(cfg.local.url + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(cfg.requestTimeoutMs),
  });
  if (!resp.ok) throw new Error(`local ${resp.status}: ${await resp.text().catch(()=>resp.statusText)}`);
  const j = await resp.json();
  return {
    text: j.message?.content || '',
    tokens_in: j.prompt_eval_count || 0,
    tokens_out: j.eval_count || 0,
  };
}

// ─── call: Anthropic ─────────────────────────────────────────────
async function callAnthropic(model, messages, opts = {}) {
  const system = messages.find(m => m.role === 'system')?.content;
  const rest = messages.filter(m => m.role !== 'system');
  const resp = await fetch(cfg.frontier.anthropic.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': cfg.frontier.anthropic.key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model, max_tokens: opts.max_tokens || 1024,
      messages: rest, ...(system ? { system } : {}),
    }),
    signal: AbortSignal.timeout(cfg.requestTimeoutMs),
  });
  if (!resp.ok) throw new Error(`anthropic ${resp.status}: ${await resp.text().catch(()=>resp.statusText)}`);
  const j = await resp.json();
  return {
    text: j.content?.map(c => c.text || '').join('') || '',
    tokens_in: j.usage?.input_tokens || 0,
    tokens_out: j.usage?.output_tokens || 0,
  };
}

// ─── call: OpenAI ────────────────────────────────────────────────
async function callOpenAI(model, messages, opts = {}) {
  const resp = await fetch(cfg.frontier.openai.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${cfg.frontier.openai.key}`,
    },
    body: JSON.stringify({
      model, messages, max_tokens: opts.max_tokens || 1024,
      temperature: opts.temperature ?? 0.7,
    }),
    signal: AbortSignal.timeout(cfg.requestTimeoutMs),
  });
  if (!resp.ok) throw new Error(`openai ${resp.status}: ${await resp.text().catch(()=>resp.statusText)}`);
  const j = await resp.json();
  return {
    text: j.choices?.[0]?.message?.content || '',
    tokens_in: j.usage?.prompt_tokens || 0,
    tokens_out: j.usage?.completion_tokens || 0,
  };
}

// ─── the main routing function ───────────────────────────────────
async function route(messages, opts = {}) {
  const requestId = crypto.randomUUID();
  const ts = Date.now();
  const start = performance.now();

  const c = classify(messages);
  const decision = chooseLeg(c.tier);

  // pick concrete model
  let modelSelected, callFn;
  if (decision.leg === 'local') {
    modelSelected = c.tier === 'femto' ? cfg.local.modelFemto
                  : c.tier === 'nano'  ? cfg.local.modelNano
                  : cfg.local.modelMilli;
    callFn = () => callLocal(modelSelected, messages, opts);
  } else if (decision.leg === 'frontier') {
    if (decision.provider === 'anthropic') {
      modelSelected = cfg.frontier.anthropic.model;
      callFn = () => callAnthropic(modelSelected, messages, opts);
    } else {
      modelSelected = cfg.frontier.openai.model;
      callFn = () => callOpenAI(modelSelected, messages, opts);
    }
  } else {
    // fallback: try smallest local model always
    modelSelected = cfg.local.modelFemto;
    callFn = () => callLocal(modelSelected, messages, opts);
  }

  let result, status = 'ok', errMsg;
  try {
    result = await callFn();
  } catch (e) {
    status = 'error';
    errMsg = e.message.slice(0, 200);
    // reroute attempt to smallest local (the "ALWAYS WORKS" fallback)
    if (decision.leg !== 'local' && availability.local) {
      audit.log({
        ts, request_id: requestId, task_tier: c.tier,
        model_selected: modelSelected, leg: decision.leg,
        reason: `${decision.reason} · FAILED: ${errMsg}`,
        latency_ms: Math.round(performance.now() - start),
        tokens_in: 0, tokens_out: 0, cost_usd: 0, status: 'error',
      });
      modelSelected = cfg.local.modelFemto;
      try {
        result = await callLocal(modelSelected, messages, opts);
        status = 'fallback';
        decision.leg = 'fallback';
        decision.reason = 'auto-fallback to smallest local after primary failed';
      } catch (e2) {
        status = 'error';
        errMsg = `both legs failed. primary: ${errMsg}. fallback: ${e2.message.slice(0,100)}`;
      }
    }
  }

  // cost calc for frontier
  let cost = 0;
  if (decision.leg === 'frontier' && result) {
    const prov = decision.provider === 'anthropic' ? cfg.frontier.anthropic : cfg.frontier.openai;
    cost = (result.tokens_in / 1e6) * prov.priceIn + (result.tokens_out / 1e6) * prov.priceOut;
  }

  const latency = Math.round(performance.now() - start);
  const hash = audit.log({
    ts, request_id: requestId, task_tier: c.tier,
    model_selected: modelSelected, leg: decision.leg,
    reason: c.reason + ' | ' + decision.reason,
    latency_ms: latency,
    tokens_in: result?.tokens_in || 0,
    tokens_out: result?.tokens_out || 0,
    cost_usd: cost, status,
  });

  return {
    request_id: requestId,
    task_tier: c.tier,
    leg: decision.leg,
    model: modelSelected,
    reason: c.reason + ' | ' + decision.reason,
    latency_ms: latency,
    tokens_in: result?.tokens_in || 0,
    tokens_out: result?.tokens_out || 0,
    cost_usd: cost,
    audit_hash: hash,
    status,
    error: errMsg,
    text: result?.text || '',
  };
}

// ─── HTTP server ─────────────────────────────────────────────────
function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function authOk(req) {
  const h = req.headers['authorization'] || '';
  return h === `Bearer ${cfg.masterKey}`;
}

const server = http.createServer(async (req, res) => {
  // CORS preflight (dashboard is browser-side, needs to reach the router)
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    return res.end();
  }

  try {
    // Public endpoints
    if (req.url === '/health' && req.method === 'GET') {
      return json(res, 200, {
        status: 'ok', version: '0.1.0',
        availability, policy: cfg.policy,
        db: cfg.dbPath, ts: Date.now(),
      });
    }
    if (req.url === '/status' && req.method === 'GET') {
      return json(res, 200, {
        availability,
        policy: cfg.policy,
        models: {
          local: { femto: cfg.local.modelFemto, nano: cfg.local.modelNano, milli: cfg.local.modelMilli },
          frontier: {
            anthropic: cfg.frontier.anthropic.key ? cfg.frontier.anthropic.model : null,
            openai:    cfg.frontier.openai.key    ? cfg.frontier.openai.model    : null,
          },
        },
      });
    }

    // Authenticated endpoints below
    if (!authOk(req)) return json(res, 401, { error: 'unauthorized' });

    // OpenAI-compatible chat completions
    if (req.url === '/v1/chat/completions' && req.method === 'POST') {
      const body = await readBody(req);
      const messages = body.messages || [];
      if (!Array.isArray(messages) || messages.length === 0) {
        return json(res, 400, { error: 'messages required' });
      }
      const r = await route(messages, {
        max_tokens: body.max_tokens,
        temperature: body.temperature,
      });
      // OpenAI-shape response
      return json(res, 200, {
        id: r.request_id,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: r.model,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: r.text },
          finish_reason: r.status === 'ok' || r.status === 'fallback' ? 'stop' : 'error',
        }],
        usage: {
          prompt_tokens: r.tokens_in,
          completion_tokens: r.tokens_out,
          total_tokens: r.tokens_in + r.tokens_out,
        },
        fallrouter: {
          task_tier: r.task_tier,
          leg: r.leg,
          reason: r.reason,
          latency_ms: r.latency_ms,
          cost_usd: r.cost_usd,
          audit_hash: r.audit_hash,
          status: r.status,
          error: r.error,
        },
      });
    }

    // Audit log
    if (req.url?.startsWith('/audit') && req.method === 'GET') {
      const url = new URL(req.url, `http://localhost`);
      const limit = Math.min(1000, Number(url.searchParams.get('limit') || 100));
      return json(res, 200, { entries: audit.recent(limit) });
    }

    // Cost summary
    if (req.url === '/cost' && req.method === 'GET') {
      return json(res, 200, audit.costSummary());
    }

    // Policy switch
    if (req.url === '/policy' && req.method === 'POST') {
      const body = await readBody(req);
      const p = body.policy;
      if (!['auto', 'always-local', 'always-frontier'].includes(p)) {
        return json(res, 400, { error: 'invalid policy' });
      }
      cfg.policy = p;
      return json(res, 200, { policy: cfg.policy });
    }

    return json(res, 404, { error: 'not found' });
  } catch (e) {
    console.error('[fallrouter]', e);
    return json(res, 500, { error: e.message });
  }
});

server.listen(cfg.port, cfg.host, () => {
  console.log(`FallRouter · listening on http://${cfg.host}:${cfg.port}`);
  console.log(`  policy: ${cfg.policy}`);
  console.log(`  local:  ${cfg.local.url}`);
  console.log(`  frontier keys: ${[cfg.frontier.anthropic.key && 'anthropic', cfg.frontier.openai.key && 'openai'].filter(Boolean).join(', ') || '(none)'}`);
  console.log(`  audit db: ${cfg.dbPath}`);
});
