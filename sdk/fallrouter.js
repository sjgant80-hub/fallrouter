// FallRouter · SDK · drop-in OpenAI-compatible client
// ─────────────────────────────────────────────────────────────────
// Same shape as the OpenAI SDK's chat.completions.create.
// Works in browser (ESM), Node (ESM), Deno.
//
// USAGE
//   import { FallRouter } from './fallrouter.js';
//   const fr = new FallRouter({ url: 'http://localhost:4100', key: 'sk-...' });
//
//   // one-shot
//   const r = await fr.chat.completions.create({
//     messages: [{ role: 'user', content: 'Hello' }],
//     max_tokens: 200,
//   });
//   console.log(r.choices[0].message.content);
//   console.log('via', r.fallrouter.leg, r.model);
//
//   // streaming
//   for await (const chunk of fr.chat.completions.stream({ messages, max_tokens: 400 })) {
//     process.stdout.write(chunk);
//   }
//
//   // health check
//   const state = await fr.health();
//   // { local: true, anthropic: true, openai: false }
//
//   // cost summary
//   const cost = await fr.cost();
//   // { local_tokens, frontier_tokens, frontier_cost, ... }
//
// COMPATIBILITY
//   If you already use the OpenAI SDK, you can point it at FallRouter directly:
//     const client = new OpenAI({
//       baseURL: 'http://localhost:4100/v1',
//       apiKey:  'your-fallrouter-master-key'
//     });
//   ...and every completion goes through FallRouter's routing/failover.
//   The SDK class below just adds convenience: streaming, health, cost, policy.
// ─────────────────────────────────────────────────────────────────

export class FallRouter {
  constructor({ url = 'http://localhost:4100', key = '' } = {}) {
    this.url = url.replace(/\/$/, '');
    this.key = key;
    this.chat = { completions: {
      create: (opts) => this._create(opts),
      stream: (opts) => this._stream(opts),
    }};
  }

  _headers() {
    const h = { 'Content-Type': 'application/json' };
    if (this.key) h['Authorization'] = `Bearer ${this.key}`;
    return h;
  }

  async _create({ messages, max_tokens = 1024, temperature = 0.7 }) {
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new Error('FallRouter: messages array required');
    }
    const resp = await fetch(this.url + '/v1/chat/completions', {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify({ messages, max_tokens, temperature }),
    });
    if (!resp.ok) {
      const err = await resp.text().catch(() => resp.statusText);
      throw new Error(`FallRouter [${resp.status}]: ${err.slice(0, 200)}`);
    }
    return resp.json();
  }

  async *_stream({ messages, max_tokens = 1024, temperature = 0.7 }) {
    // Router service currently returns non-streamed responses.
    // We simulate a stream by buffering the response and emitting content
    // in chunks so callers can use the same async-iterator pattern.
    const r = await this._create({ messages, max_tokens, temperature });
    const text = r.choices?.[0]?.message?.content || '';
    // Emit in ~64-char chunks with the same shape as before, but strings only.
    const CHUNK = 64;
    for (let i = 0; i < text.length; i += CHUNK) {
      yield text.slice(i, i + CHUNK);
    }
    // Yield a final metadata marker (an object) so callers can retrieve routing info if desired.
    return r.fallrouter;
  }

  async health() {
    const resp = await fetch(this.url + '/health');
    if (!resp.ok) throw new Error(`FallRouter health [${resp.status}]`);
    const j = await resp.json();
    return j.availability;
  }

  async status() {
    const resp = await fetch(this.url + '/status');
    if (!resp.ok) throw new Error(`FallRouter status [${resp.status}]`);
    return resp.json();
  }

  async cost() {
    const resp = await fetch(this.url + '/cost', { headers: this._headers() });
    if (!resp.ok) throw new Error(`FallRouter cost [${resp.status}]`);
    return resp.json();
  }

  async audit({ limit = 100 } = {}) {
    const resp = await fetch(`${this.url}/audit?limit=${limit}`, { headers: this._headers() });
    if (!resp.ok) throw new Error(`FallRouter audit [${resp.status}]`);
    const j = await resp.json();
    return j.entries;
  }

  async setPolicy(policy) {
    if (!['auto', 'always-local', 'always-frontier'].includes(policy)) {
      throw new Error(`invalid policy: ${policy}`);
    }
    const resp = await fetch(this.url + '/policy', {
      method: 'POST', headers: this._headers(),
      body: JSON.stringify({ policy }),
    });
    if (!resp.ok) throw new Error(`FallRouter policy [${resp.status}]`);
    return (await resp.json()).policy;
  }
}

// ─── legacy claude()-style function (drop-in for smbaios) ──────────
// If you have code that uses a `claude(messages, system, maxTokens)` helper,
// import this and re-export it — everything downstream continues to work,
// requests are now routed sovereignly.
export function makeClaudeCompatible({ url = 'http://localhost:4100', key = '' } = {}) {
  const fr = new FallRouter({ url, key });
  return async function claude(messages, system, maxTokens = 700) {
    const msgs = system ? [{ role: 'system', content: system }, ...messages] : messages;
    const r = await fr.chat.completions.create({ messages: msgs, max_tokens: maxTokens });
    return r.choices?.[0]?.message?.content || '';
  };
}

export default FallRouter;
