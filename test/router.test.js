'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createServer, routeFor, stripContextSuffix, isLocalRequest } = require('../router.js');

function fakeUpstream(handler) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const rec = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
      seen.push(rec);
      handler(rec, res);
    });
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      resolve({ srv, seen, url: `http://127.0.0.1:${srv.address().port}` });
    });
  });
}

function jsonReply(req, res) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

async function setup({ zaiKey = 'zai-test-key', anthropicReply = jsonReply, anthropicUrl } = {}) {
  const anthropic = await fakeUpstream(anthropicReply);
  const zai = await fakeUpstream(jsonReply);
  const router = createServer({
    anthropicUrl: anthropicUrl ?? anthropic.url,
    zaiUrl: `${zai.url}/api/anthropic`,
    zaiKey,
  });
  const base = await listen(router);
  const close = () => Promise.all([
    new Promise((r) => router.close(r)),
    new Promise((r) => anthropic.srv.close(r)),
    new Promise((r) => zai.srv.close(r)),
  ]);
  return { base, anthropic, zai, close };
}

function post(base, urlPath, headers, payload) {
  return fetch(`${base}${urlPath}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });
}

test('routeFor sends glm-* to z.ai and everything else to Anthropic', () => {
  assert.equal(routeFor('glm-5.3'), 'zai');
  assert.equal(routeFor('glm-5.3-flash'), 'zai');
  assert.equal(routeFor('claude-haiku-5-5'), 'anthropic');
  assert.equal(routeFor('opus'), 'anthropic');
  assert.equal(routeFor(undefined), 'anthropic');
});

test('stripContextSuffix removes only the trailing [1m] hint', () => {
  assert.equal(stripContextSuffix('glm-5.3[1m]'), 'glm-5.3');
  assert.equal(stripContextSuffix('glm-5.3'), 'glm-5.3');
});

test('Claude models go to Anthropic with the caller headers untouched', async () => {
  const t = await setup();
  try {
    const res = await post(t.base, '/v1/messages?beta=true', {
      'x-api-key': 'sk-ant-test',
      authorization: 'Bearer oauth-test',
      'anthropic-beta': 'oauth-2025-04-20',
    }, { model: 'claude-haiku-5-5', messages: [] });
    assert.equal(res.status, 200);
    assert.equal(t.anthropic.seen.length, 1);
    assert.equal(t.zai.seen.length, 0);
    const up = t.anthropic.seen[0];
    assert.equal(up.url, '/v1/messages?beta=true');
    assert.equal(up.headers['x-api-key'], 'sk-ant-test');
    assert.equal(up.headers.authorization, 'Bearer oauth-test');
    assert.equal(up.headers['anthropic-beta'], 'oauth-2025-04-20');
    assert.equal(JSON.parse(up.body).model, 'claude-haiku-5-5');
  } finally {
    await t.close();
  }
});

test('GLM models go to z.ai with the z.ai key and no Anthropic credentials', async () => {
  const t = await setup();
  try {
    for (const model of ['glm-5.3[1m]', 'glm-5.3-flash']) {
      await post(t.base, '/v1/messages?beta=true', {
        'x-api-key': 'sk-ant-test',
        authorization: 'Bearer oauth-test',
        'anthropic-beta': 'oauth-2025-04-20',
      }, { model, messages: [] });
    }
    assert.equal(t.anthropic.seen.length, 0);
    assert.equal(t.zai.seen.length, 2);
    const first = t.zai.seen[0];
    assert.equal(first.url, '/api/anthropic/v1/messages?beta=true');
    assert.equal(first.headers.authorization, 'Bearer zai-test-key');
    assert.equal(first.headers['x-api-key'], undefined);
    assert.equal(first.headers['anthropic-beta'], undefined);
    assert.equal(JSON.parse(first.body).model, 'glm-5.3');
    assert.equal(JSON.parse(t.zai.seen[1].body).model, 'glm-5.3-flash');
  } finally {
    await t.close();
  }
});

test('streamed responses from Anthropic reach the client intact', async () => {
  const events = ['event: message_start\ndata: {"a":1}\n\n', 'event: content_block_delta\ndata: {"b":2}\n\n', 'event: message_stop\ndata: {}\n\n'];
  const t = await setup({
    anthropicReply: (req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      let i = 0;
      const timer = setInterval(() => {
        if (i < events.length) res.write(events[i++]);
        else { clearInterval(timer); res.end(); }
      }, 20);
    },
  });
  try {
    const res = await post(t.base, '/v1/messages', { 'x-api-key': 'sk-ant-test' }, { model: 'claude-sonnet-5-5', stream: true });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    assert.equal(await res.text(), events.join(''));
  } finally {
    await t.close();
  }
});

test('an unreachable Anthropic upstream returns a 502 JSON error', async () => {
  const t = await setup({ anthropicUrl: 'http://127.0.0.1:1' });
  try {
    const res = await post(t.base, '/v1/messages', {}, { model: 'claude-haiku-5-5' });
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.type, 'error');
    assert.match(body.error.message, /upstream anthropic failed/);
  } finally {
    await t.close();
  }
});

test('GLM requests fail with 401 when no z.ai key is set, and Claude models still work', async () => {
  const t = await setup({ zaiKey: null });
  try {
    const glm = await post(t.base, '/v1/messages', {}, { model: 'glm-5.3' });
    assert.equal(glm.status, 401);
    assert.equal(t.zai.seen.length, 0);
    const claude = await post(t.base, '/v1/messages', { 'x-api-key': 'sk-ant-test' }, { model: 'claude-haiku-5-5' });
    assert.equal(claude.status, 200);
    assert.equal(t.anthropic.seen.length, 1);
  } finally {
    await t.close();
  }
});

test('a non-JSON body is passed to Anthropic unchanged', async () => {
  const t = await setup();
  try {
    await post(t.base, '/v1/messages/count_tokens', {}, 'not json at all');
    assert.equal(t.anthropic.seen.length, 1);
    assert.equal(t.anthropic.seen[0].body, 'not json at all');
    assert.equal(t.zai.seen.length, 0);
  } finally {
    await t.close();
  }
});

test('healthz answers ok without contacting any upstream', async () => {
  const t = await setup();
  try {
    const res = await fetch(`${t.base}/healthz`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'ok');
    assert.equal(t.anthropic.seen.length + t.zai.seen.length, 0);
  } finally {
    await t.close();
  }
});

function rawRequest(base, headers, payload = '{"model":"glm-5.3"}') {
  const { port } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path: '/v1/messages',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

test('a request with an Origin header is rejected with 403 and reaches no upstream', async () => {
  const t = await setup();
  try {
    const res = await rawRequest(t.base, { origin: 'https://evil.example' });
    assert.equal(res.status, 403);
    assert.match(JSON.parse(res.body).error.message, /rejected/);
    assert.equal(t.anthropic.seen.length + t.zai.seen.length, 0);
  } finally {
    await t.close();
  }
});

test('a request with a non-local Host header is rejected with 403 and reaches no upstream', async () => {
  const t = await setup();
  try {
    const res = await rawRequest(t.base, { host: 'evil.example:18787' });
    assert.equal(res.status, 403);
    assert.equal(t.anthropic.seen.length + t.zai.seen.length, 0);
  } finally {
    await t.close();
  }
});

test('localhost and 127.0.0.1 Host headers are accepted, with and without a port', async () => {
  const t = await setup();
  try {
    const { port } = new URL(t.base);
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, 'localhost']) {
      const res = await rawRequest(t.base, { host }, '{"model":"claude-haiku-5-5"}');
      assert.equal(res.status, 200, host);
    }
    assert.equal(t.anthropic.seen.length, 3);
  } finally {
    await t.close();
  }
});

test('isLocalRequest handles bracketed IPv6 and a missing Host', () => {
  assert.equal(isLocalRequest({ headers: { host: '[::1]:18787' } }), true);
  assert.equal(isLocalRequest({ headers: { host: '[::2]:18787' } }), false);
  assert.equal(isLocalRequest({ headers: {} }), false);
  assert.equal(isLocalRequest({ headers: { host: '127.0.0.1', origin: 'null' } }), false);
});
