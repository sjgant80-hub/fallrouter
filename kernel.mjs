// fallrouter · kernel.mjs — the sovereign routing decision, extracted from the service and gated.
// This is "our system" as a pure kernel: a prompt is CLASSIFIED into a task tier, the tier + live
// provider availability CHOOSE a leg (local first, frontier only for the hard work, auto-failover),
// and every decision lands on a tamper-evident SHA-256 audit chain. Local-first, then CC — provable.
//
// PURE and TOTAL: no fetch, no DB, no throw on garbage. The service (service/router.mjs) does the
// pinging and the calling; this kernel makes the DECISION and the AUDIT, so the live routing logic
// is the gated logic.

export const TIERS = Object.freeze(['femto', 'nano', 'milli', 'advisor']);
export const LEGS = Object.freeze(['local', 'frontier', 'fallback']);
export const POLICIES = Object.freeze(['auto', 'always-local', 'always-frontier']);
export const DEFAULT_ADVISOR_KEYWORDS = Object.freeze(['check', 'verify', 'audit', 'review', 'prove', 'double-check', 'fact-check']);

const isStr = (v) => typeof v === 'string';
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const HAS_CODE = /```|def |function |class |import |const |let /;

/**
 * Classify a prompt into a task tier (rule-based, deterministic, sovereign). A request to check /
 * verify / audit is an advisor task (the 10% that earns the frontier spend); code + length is deep
 * reasoning (milli); a very short prompt is a femto route/classify; medium is nano; long is milli.
 */
export function classify(text, advisorKeywords) {
  const s = isStr(text) ? text.trim() : '';
  const len = s.length;
  const kws = Array.isArray(advisorKeywords) ? advisorKeywords : DEFAULT_ADVISOR_KEYWORDS;
  const lower = s.toLowerCase();
  const wantsCheck = kws.some((k) => isStr(k) && k.length > 0 && lower.includes(k));
  if (wantsCheck) return { tier: 'advisor', reason: 'user requested check/verify/audit' };
  if (HAS_CODE.test(s) && len > 300) return { tier: 'milli', reason: 'code + substantial length' };
  if (len < 50) return { tier: 'femto', reason: 'short prompt · route/classify/yes-no' };
  if (len < 500) return { tier: 'nano', reason: 'medium prompt · standard generation' };
  return { tier: 'milli', reason: 'long prompt · deep reasoning' };
}

/**
 * Choose which leg serves a tier, given live provider availability and the policy. THE sovereign-first
 * rule: femto/nano default to LOCAL (frontier only if local is down); milli/advisor go to frontier for
 * the deep reasoning, falling back to local best-effort if the frontier is dark. Nothing is ever
 * dropped — an unavailable preferred leg reroutes down the cascade to 'fallback'.
 */
export function chooseLeg(tier, availability, policy) {
  const a = isObj(availability) ? availability : {};
  const local = a.local === true, anthropic = a.anthropic === true, openai = a.openai === true;
  const pol = POLICIES.includes(policy) ? policy : 'auto';
  if (pol === 'always-local') return { leg: 'local', reason: 'policy: always-local' };
  if (pol === 'always-frontier') {
    if (anthropic) return { leg: 'frontier', provider: 'anthropic', reason: 'policy: always-frontier' };
    if (openai) return { leg: 'frontier', provider: 'openai', reason: 'policy: always-frontier' };
    return { leg: 'fallback', reason: 'policy: always-frontier but none available · falling back' };
  }
  if (tier === 'femto' || tier === 'nano') {
    if (local) return { leg: 'local', reason: tier + ' → local (sovereign default)' };
    if (anthropic) return { leg: 'frontier', provider: 'anthropic', reason: 'local down · frontier fallback' };
    if (openai) return { leg: 'frontier', provider: 'openai', reason: 'local down · frontier fallback' };
    return { leg: 'fallback', reason: 'no legs available' };
  }
  if (tier === 'milli') {
    if (anthropic) return { leg: 'frontier', provider: 'anthropic', reason: 'milli → frontier for deep reasoning' };
    if (openai) return { leg: 'frontier', provider: 'openai', reason: 'milli → openai (anthropic unavailable)' };
    if (local) return { leg: 'local', reason: 'milli · frontier down · local best-effort' };
    return { leg: 'fallback', reason: 'no legs available' };
  }
  if (tier === 'advisor') {
    if (anthropic) return { leg: 'frontier', provider: 'anthropic', reason: 'advisor pattern → Claude (specialty)' };
    if (openai) return { leg: 'frontier', provider: 'openai', reason: 'advisor · anthropic down' };
    if (local) return { leg: 'local', reason: 'advisor · frontier down · local best-effort' };
    return { leg: 'fallback', reason: 'no legs available' };
  }
  return { leg: 'fallback', reason: 'unknown tier' };
}

/** The whole decision, end to end: a prompt + live availability → tier and leg. Local-first, then CC. */
export function routePlan(text, ctx) {
  const c = isObj(ctx) ? ctx : {};
  const cl = classify(text, c.advisorKeywords);
  const ch = chooseLeg(cl.tier, c.availability, c.policy);
  return { tier: cl.tier, classifyReason: cl.reason, leg: ch.leg, provider: ch.provider || null, reason: ch.reason };
}

// ── SHA-256 + canonical JSON (the estate's proven pair, verbatim) ───────────────────────────────
const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export function sha256(text) {
  if (!isStr(text)) return { ok: false, why: 'sha256 takes a string' };
  const data = new TextEncoder().encode(text);
  const len = data.length;
  const padded = new Uint8Array((((len + 8) >> 6) << 6) + 64);
  padded.set(data);
  padded[len] = 0x80;
  const dv = new DataView(padded.buffer);
  const bitLen = len * 8;
  dv.setUint32(padded.length - 8, Math.floor(bitLen / 4294967296));
  dv.setUint32(padded.length - 4, bitLen >>> 0);
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const w = new Uint32Array(64);
  for (let i = 0; i < padded.length; i += 64) {
    for (let t = 0; t < 16; t++) w[t] = dv.getUint32(i + t * 4);
    for (let t = 16; t < 64; t++) {
      const x = w[t - 15], y = w[t - 2];
      const s0 = (((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3)) >>> 0;
      const s1 = (((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10)) >>> 0;
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, hh = h7;
    for (let t = 0; t < 64; t++) {
      const S1 = (((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const t1 = (hh + S1 + ch + K256[t] + w[t]) >>> 0;
      const S0 = (((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const t2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + hh) >>> 0;
  }
  const hex = (n) => n.toString(16).padStart(8, '0');
  return { ok: true, hash: hex(h0) + hex(h1) + hex(h2) + hex(h3) + hex(h4) + hex(h5) + hex(h6) + hex(h7) };
}

export function canon(v) {
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return JSON.stringify(v);
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  return '"?"';
}

// ── the routing audit chain: every decision hash-chained, tamper-evident ────────────────────────
export function appendAudit(chain, entry) {
  if (!Array.isArray(chain)) return { ok: false, why: 'the audit chain is an array' };
  if (!isObj(entry)) return { ok: false, why: 'an audit entry is an object' };
  const prevHash = chain.length === 0 ? 'GENESIS' : chain[chain.length - 1].hash;
  const body = { tier: entry.tier, leg: entry.leg, provider: entry.provider || null, reason: entry.reason, at: isStr(entry.at) ? entry.at : null };
  const h = sha256(prevHash + '|' + canon(body));
  if (!h.ok) return { ok: false, why: h.why };
  return { ok: true, chain: [...chain, { seq: chain.length, prevHash, hash: h.hash, entry: body }] };
}

export function verifyAudit(chain) {
  if (!Array.isArray(chain)) return { ok: false, why: 'the audit chain is an array' };
  for (let i = 0; i < chain.length; i++) {
    const item = chain[i];
    if (!isObj(item) || !isStr(item.hash) || !isStr(item.prevHash) || !isObj(item.entry)) return { ok: true, valid: false, brokenAt: i };
    if (item.seq !== i) return { ok: true, valid: false, brokenAt: i };
    const expectedPrev = i === 0 ? 'GENESIS' : chain[i - 1].hash;
    if (item.prevHash !== expectedPrev) return { ok: true, valid: false, brokenAt: i };
    const h = sha256(item.prevHash + '|' + canon(item.entry));
    if (!h.ok || h.hash !== item.hash) return { ok: true, valid: false, brokenAt: i };
  }
  return { ok: true, valid: true, length: chain.length };
}

export default routePlan;
