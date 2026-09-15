import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TIERS, LEGS, POLICIES, DEFAULT_ADVISOR_KEYWORDS,
  classify, chooseLeg, routePlan, sha256, canon, appendAudit, verifyAudit,
} from './kernel.mjs';

test('sha256 + canon are the proven pair', () => {
  assert.equal(sha256('abc').hash, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(canon({ b: 1, a: 2 }), '{"a":2,"b":1}');
});

test('the vocabularies are frozen', () => {
  assert.deepEqual([...TIERS], ['femto', 'nano', 'milli', 'advisor']);
  assert.deepEqual([...LEGS], ['local', 'frontier', 'fallback']);
  assert.deepEqual([...POLICIES], ['auto', 'always-local', 'always-frontier']);
  assert.throws(() => { TIERS.push('x'); });
});

test('classify: length tiers at their exact boundaries', () => {
  assert.equal(classify('a'.repeat(49)).tier, 'femto');   // < 50
  assert.equal(classify('a'.repeat(50)).tier, 'nano');    // 50 is not femto
  assert.equal(classify('a'.repeat(499)).tier, 'nano');   // < 500
  assert.equal(classify('a'.repeat(500)).tier, 'milli');  // 500 is not nano
  assert.equal(classify('').tier, 'femto');               // empty → femto
});

test('classify: an advisor keyword beats every length rule', () => {
  assert.equal(classify('verify this').tier, 'advisor');
  assert.equal(classify('please audit ' + 'a'.repeat(600)).tier, 'advisor');   // long, but advisor wins
  assert.equal(classify('CHECK it').tier, 'advisor');                          // case-insensitive
});

test('classify: code + substantial length is milli; short code is not', () => {
  assert.equal(classify('function f(){}\n' + 'x'.repeat(300)).tier, 'milli');  // code && len>300
  assert.equal(classify('const x = 1').tier, 'femto');                          // code but short → length rules
});

test('classify: custom advisor keywords replace the defaults', () => {
  assert.equal(classify('verify', ['zzz']).tier, 'femto');   // 'verify' not in custom list → short → femto
  assert.equal(classify('zzz please', ['zzz']).tier, 'advisor');
  assert.ok(DEFAULT_ADVISOR_KEYWORDS.includes('verify'));
});

test('chooseLeg: femto/nano default to LOCAL when local is up (sovereign-first)', () => {
  assert.equal(chooseLeg('femto', { local: true, anthropic: true }).leg, 'local');   // local even if frontier up
  assert.equal(chooseLeg('nano', { local: true }).leg, 'local');
});

test('kill: femto falls to frontier only when local is DOWN, cascade anthropic→openai', () => {
  assert.deepEqual([chooseLeg('femto', { local: false, anthropic: true }).leg, chooseLeg('femto', { local: false, anthropic: true }).provider], ['frontier', 'anthropic']);
  assert.equal(chooseLeg('femto', { local: false, anthropic: false, openai: true }).provider, 'openai');
  assert.equal(chooseLeg('femto', {}).leg, 'fallback');
});

test('kill: milli/advisor prefer FRONTIER for deep reasoning even when local is up', () => {
  assert.equal(chooseLeg('milli', { local: true, anthropic: true }).leg, 'frontier');   // NOT local
  assert.equal(chooseLeg('milli', { local: true, anthropic: true }).provider, 'anthropic');
  assert.equal(chooseLeg('advisor', { local: true, anthropic: true }).leg, 'frontier');
  assert.equal(chooseLeg('milli', { anthropic: false, openai: false, local: true }).leg, 'local');  // frontier down → local best-effort
});

test('chooseLeg: policies override the tier', () => {
  assert.equal(chooseLeg('milli', { anthropic: true }, 'always-local').leg, 'local');
  assert.equal(chooseLeg('femto', { local: true, anthropic: true }, 'always-frontier').leg, 'frontier');
  assert.equal(chooseLeg('femto', {}, 'always-frontier').leg, 'fallback');
});

test('chooseLeg: an unknown tier is fallback, never a silent leg', () => {
  assert.equal(chooseLeg('mystery', { local: true }).leg, 'fallback');
});

test('routePlan composes classify + chooseLeg end to end', () => {
  const p = routePlan('verify this output', { availability: { anthropic: true, local: true } });
  assert.equal(p.tier, 'advisor');
  assert.equal(p.leg, 'frontier');
  assert.equal(p.provider, 'anthropic');
  const q = routePlan('hi', { availability: { local: true } });
  assert.equal(q.tier, 'femto'); assert.equal(q.leg, 'local');
});

test('classify/chooseLeg/routePlan are total on garbage', () => {
  for (const junk of [null, undefined, 42, {}, []]) {
    assert.doesNotThrow(() => { classify(junk); chooseLeg(junk, junk, junk); routePlan(junk, junk); });
  }
  assert.equal(chooseLeg('femto', null).leg, 'fallback');   // no availability → nothing up → fallback
});

test('appendAudit chains decisions; verifyAudit confirms the chain', () => {
  let chain = [];
  chain = appendAudit(chain, { tier: 'femto', leg: 'local', reason: 'sovereign default', at: '2026-09-15' }).chain;
  chain = appendAudit(chain, { tier: 'milli', leg: 'frontier', provider: 'anthropic', reason: 'deep reasoning', at: '2026-09-15' }).chain;
  assert.equal(chain.length, 2);
  assert.equal(verifyAudit(chain).valid, true);
});

test('verifyAudit: flipping a logged leg breaks the chain at that entry', () => {
  let chain = [];
  chain = appendAudit(chain, { tier: 'femto', leg: 'local', reason: 'r', at: 'x' }).chain;
  chain = appendAudit(chain, { tier: 'milli', leg: 'frontier', reason: 'r', at: 'x' }).chain;
  chain[0].entry.leg = 'frontier';   // pretend a local decision was really a frontier spend
  const v = verifyAudit(chain);
  assert.equal(v.valid, false);
  assert.equal(v.brokenAt, 0);
});

test('appendAudit refuses a non-array chain or non-object entry', () => {
  assert.equal(appendAudit('nope', {}).ok, false);
  assert.equal(appendAudit([], 42).ok, false);
});

test('kill: an empty-string advisor keyword is ignored (length > 0, not >= 0)', () => {
  assert.equal(classify('hi', ['']).tier, 'femto');   // '' must not make every prompt an advisor task
});

test('kill: code + length is milli only ABOVE 300 (len > 300, not >= 300)', () => {
  const code300 = ('function f(){} ' + 'a'.repeat(300)).slice(0, 300);
  const code301 = ('function f(){} ' + 'a'.repeat(300)).slice(0, 301);
  assert.equal(code300.length, 300); assert.equal(classify(code300).tier, 'nano');    // 300 is not > 300 → length rule → nano
  assert.equal(code301.length, 301); assert.equal(classify(code301).tier, 'milli');   // 301 > 300 → milli
});

test('kill: appendAudit preserves the provider (|| null keeps a real provider, not && null)', () => {
  const r = appendAudit([], { tier: 'milli', leg: 'frontier', provider: 'anthropic', reason: 'r', at: 'x' });
  assert.equal(r.chain[0].entry.provider, 'anthropic');   // a real frontier spend is recorded, not nulled
  const s = appendAudit([], { tier: 'femto', leg: 'local', reason: 'r', at: 'x' });
  assert.equal(s.chain[0].entry.provider, null);          // absent provider → null
});

test('kill: verifyAudit catches an ARRAY item with an honest hash (the !isObj(item) clause)', () => {
  let chain = appendAudit([], { tier: 'femto', leg: 'local', reason: 'r', at: 'x' }).chain;
  const entry = { tier: 'milli', leg: 'frontier', provider: 'anthropic', reason: 'r', at: 'x' };
  const prevHash = chain[0].hash;
  const hash = sha256(prevHash + '|' + canon(entry)).hash;                // honest hash → recompute passes
  const arrItem = Object.assign([], { seq: 1, prevHash, hash, entry });   // …but the item is an ARRAY
  const v = verifyAudit([chain[0], arrItem]);
  assert.equal(v.valid, false); assert.equal(v.brokenAt, 1);
});

test('kill: verifyAudit catches a STRING entry with an honest hash (the !isObj(item.entry) clause)', () => {
  let chain = appendAudit([], { tier: 'femto', leg: 'local', reason: 'r', at: 'x' }).chain;
  const entry = 'not-an-object';
  const prevHash = chain[0].hash;
  const hash = sha256(prevHash + '|' + canon(entry)).hash;
  const v = verifyAudit([chain[0], { seq: 1, prevHash, hash, entry }]);
  assert.equal(v.valid, false); assert.equal(v.brokenAt, 1);
});

test('fuzz: pure and total — garbage never throws', () => {
  const junk = [null, undefined, 0, '', [], {}, NaN, true, Symbol.for('x')];
  for (const a of junk) for (const b of junk) {
    assert.doesNotThrow(() => { classify(a, b); chooseLeg(a, b, a); routePlan(a, b); appendAudit(a, b); verifyAudit(a); });
  }
});
