#!/usr/bin/env node
'use strict';

// Local router for Claude Code. Claude Code sends every request to
// ANTHROPIC_BASE_URL. This forwards glm-* models to z.ai's Anthropic-compatible
// endpoint and everything else to Anthropic unchanged. Standard library only.

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding',
  'te', 'trailer', 'upgrade', 'host', 'content-length',
]);

function routeFor(model) {
  return typeof model === 'string' && model.startsWith('glm-') ? 'zai' : 'anthropic';
}

// Claude Code's context-window hint ("[1m]") is not part of z.ai's model ID.
function stripContextSuffix(model) {
  return model.replace(/\[1m\]$/, '');
}

function sendError(res, status, message) {
  const body = JSON.stringify({ type: 'error', error: { type: 'api_error', message: `glm-router: ${message}` } });
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function filterHeaders(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(name.toLowerCase())) out[name] = value;
  }
  return out;
}

// Claude Code is not a browser, so it sends no Origin header. Any Origin means a
// web page is talking to us; a non-local Host means DNS rebinding. Reject both.
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

function isLocalRequest(req) {
  if (req.headers.origin !== undefined) return false;
  const host = req.headers.host;
  if (typeof host !== 'string') return false;
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
  return LOCAL_HOSTS.has(name.toLowerCase());
}

function createServer({ anthropicUrl, zaiUrl, zaiKey, log = () => {} }) {
  const targets = { anthropic: new URL(anthropicUrl), zai: new URL(zaiUrl) };

  function forward(req, res, rawBody) {
    let parsed = null;
    if (rawBody.length > 0) {
      try {
        parsed = JSON.parse(rawBody.toString('utf8'));
      } catch {
        parsed = null;
      }
    }
    const model = parsed && typeof parsed.model === 'string' ? parsed.model : undefined;
    const route = routeFor(model);

    const headers = filterHeaders(req.headers);
    let body = rawBody;

    if (route === 'zai') {
      if (!zaiKey) {
        sendError(res, 401, `no z.ai key configured for ${model}; Anthropic models are unaffected`);
        log(`${req.method} ${req.url} model=${model} -> zai 401 (no key)`);
        return;
      }
      parsed.model = stripContextSuffix(model);
      body = Buffer.from(JSON.stringify(parsed));
      delete headers.authorization;
      delete headers['x-api-key'];
      delete headers['anthropic-beta'];
      headers.authorization = `Bearer ${zaiKey}`;
    }
    headers['content-length'] = String(body.length);

    const target = targets[route];
    const upstreamPath = target.pathname.replace(/\/$/, '') + req.url;
    const transport = target.protocol === 'http:' ? http : https;

    const upReq = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || undefined,
      method: req.method,
      path: upstreamPath,
      headers: { ...headers, host: target.host },
    }, (upRes) => {
      log(`${req.method} ${req.url} model=${model ?? '-'} -> ${route} ${upRes.statusCode}`);
      res.writeHead(upRes.statusCode || 502, filterHeaders(upRes.headers));
      upRes.pipe(res);
    });

    upReq.on('error', (err) => {
      log(`${req.method} ${req.url} model=${model ?? '-'} -> ${route} error: ${err.message}`);
      if (!res.headersSent) sendError(res, 502, `upstream ${route} failed: ${err.message}`);
      else res.destroy();
    });
    res.on('close', () => {
      if (!res.writableEnded) upReq.destroy();
    });
    upReq.end(body);
  }

  return http.createServer((req, res) => {
    if (!isLocalRequest(req)) {
      log(`${req.method} ${req.url} rejected: origin=${req.headers.origin ?? '-'} host=${req.headers.host ?? '-'}`);
      sendError(res, 403, 'request rejected: browser Origin or non-local Host');
      req.resume();
      return;
    }
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('error', (err) => sendError(res, 400, `request read failed: ${err.message}`));
    req.on('end', () => forward(req, res, Buffer.concat(chunks)));
  });
}

function readZaiKey() {
  if (process.env.GLM_ROUTER_ZAI_KEY) return process.env.GLM_ROUTER_ZAI_KEY.trim();
  const file = process.env.GLM_ROUTER_ZAI_KEY_FILE
    || path.join(os.homedir(), '.config', 'glm-router', 'zai.key');
  try {
    return fs.readFileSync(file, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

if (require.main === module) {
  const port = Number(process.env.GLM_ROUTER_PORT || 18787);
  const host = process.env.GLM_ROUTER_HOST || '127.0.0.1';
  const server = createServer({
    anthropicUrl: process.env.GLM_ROUTER_ANTHROPIC_URL || 'https://api.anthropic.com',
    zaiUrl: process.env.GLM_ROUTER_ZAI_URL || 'https://api.z.ai/api/anthropic',
    zaiKey: readZaiKey(),
    log: (line) => process.stderr.write(`${new Date().toISOString()} ${line}\n`),
  });
  server.listen(port, host, () => {
    process.stderr.write(`glm-router listening on ${host}:${port}\n`);
  });
}

module.exports = { createServer, routeFor, stripContextSuffix, isLocalRequest };
