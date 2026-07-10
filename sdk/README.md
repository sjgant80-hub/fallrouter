# FallRouter · SDK

Tiny ESM client for the FallRouter service. Zero dependencies.

## Install

Copy `fallrouter.js` into your project (or ship it via CDN — no build step required).

```javascript
import { FallRouter } from './fallrouter.js';
```

## Basic use

```javascript
const fr = new FallRouter({
  url: 'http://localhost:4100',
  key: 'sk-your-router-master-key'});

const r = await fr.chat.completions.create({
  messages: [
    { role: 'system', content: 'You are a concise assistant.' },
    { role: 'user', content: 'Explain the observer effect.' }],
  max_tokens: 200});

console.log(r.choices[0].message.content);
console.log('routed via', r.fallrouter.leg, '→', r.model);
```

## Streaming (buffered · yields text chunks)

```javascript
for await (const chunk of fr.chat.completions.stream({ messages })) {
  process.stdout.write(chunk);
}
```

## Observability

```javascript
await fr.health();     // { local: true, anthropic: true, openai: false }
await fr.status();     // full config + availability
await fr.cost();       // 30-day cost + token totals
await fr.audit({ limit: 100 });  // recent routing entries
```

## Policy switch

```javascript
await fr.setPolicy('always-local');       // sovereign mode
await fr.setPolicy('auto');               // let router decide (default)
await fr.setPolicy('always-frontier');    // force frontier when available
```

## Drop-in for smbaios (or any `claude(messages, system, maxTokens)` code)

```javascript
import { makeClaudeCompatible } from './fallrouter.js';

const claude = makeClaudeCompatible({
  url: 'http://localhost:4100',
  key: 'sk-your-router-master-key'});

// existing smbaios / buildBotPrompt / etc. code works unchanged
const answer = await claude(messages, systemPrompt, 700);
```

## Use with the official OpenAI SDK

FallRouter is OpenAI-compatible on `/v1/chat/completions`. You can point the OpenAI SDK straight at it:

```javascript
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'http://localhost:4100/v1',
  apiKey:  'your-fallrouter-master-key'});

const r = await client.chat.completions.create({
  model: 'auto',                  // router picks — this is ignored
  messages: [{ role: 'user', content: 'Hello' }]});
```

The extra `fallrouter` block is present in `r.fallrouter` (leg, tier, latency, cost, audit hash).
