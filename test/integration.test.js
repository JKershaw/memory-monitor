#!/usr/bin/env node
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');

const SERVER = path.join(__dirname, '..', 'server.js');
let proc;
let port;

before(async () => {
  proc = spawn('node', [SERVER], {
    env: { ...process.env, PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    let buf = '';
    const onData = d => {
      buf += d.toString();
      const m = buf.match(/http:\/\/localhost:(\d+)/);
      if (m) { port = parseInt(m[1], 10); resolve(); }
    };
    proc.stdout.on('data', onData);
    proc.on('error', reject);
    setTimeout(() => reject(new Error('server start timeout')), 3000);
  });
});

after(() => { if (proc) proc.kill('SIGTERM'); });

function req(method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const r = http.request({
      host: '127.0.0.1', port, path: urlPath, method,
      headers: {
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...headers,
      },
    }, res => {
      let out = '';
      res.on('data', c => out += c);
      res.on('end', () => resolve({ status: res.statusCode, body: out }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

test('GET / returns Browse HTML', async () => {
  const r = await req('GET', '/');
  assert.equal(r.status, 200);
  assert.match(r.body, /<title>Browse/);
});

test('GET /dashboard returns Workspace HTML', async () => {
  const r = await req('GET', '/dashboard');
  assert.equal(r.status, 200);
  assert.match(r.body, /Claude Memory Monitor/);
});

test('GET /api/memories returns JSON with files and projects', async () => {
  const r = await req('GET', '/api/memories');
  assert.equal(r.status, 200);
  const j = JSON.parse(r.body);
  assert.ok(Array.isArray(j.files));
  assert.ok(Array.isArray(j.projects));
});

test('rejects non-localhost Host header', async () => {
  const r = await req('GET', '/api/memories', null, { Host: 'evil.example' });
  assert.equal(r.status, 403);
});

test('POST without JSON content-type is 415', async () => {
  const r = await req('POST', '/api/memory', 'x', { 'Content-Type': 'text/plain' });
  assert.equal(r.status, 415);
});

test('POST rejects path-traversal projectEncoded', async () => {
  const r = await req('POST', '/api/memory', {
    projectEncoded: '../../etc',
    filename: 'a.md',
    frontmatter: { name: 'x', type: 'user' },
    body: '',
  });
  assert.equal(r.status, 400);
});

test('POST rejects case-variant of MEMORY.md', async () => {
  const r = await req('POST', '/api/memory', {
    projectEncoded: '-Users-work-development-memory-monitor',
    filename: 'memory.md',
    frontmatter: { name: 'x', type: 'user' },
    body: '',
  });
  assert.equal(r.status, 400);
});

// Regression: modal close buttons stopped working when the inner .modal had
// `onclick="event.stopPropagation()"`, because that halted bubbling before
// the document-level delegated click handler (which processes
// data-action="close-modal") could see it. Guard against that anti-pattern.
test('modal uses event delegation — no stopPropagation on container', async () => {
  const { body: dash } = await req('GET', '/dashboard');
  assert.doesNotMatch(
    dash,
    /class="modal"[^>]*onclick\s*=\s*"[^"]*stopPropagation/,
    'modal container must not swallow clicks with stopPropagation'
  );
  // Invariant the bug violated: close buttons are dispatched via data-action.
  assert.match(dash, /data-action="close-modal"/);
});

test('markdown URL allow-list is in place (XSS fix)', async () => {
  const { body: dash } = await req('GET', '/dashboard');
  const { body: browse } = await req('GET', '/');
  const guard = /\/\^\(https\?:\|mailto:\|#\|/;
  assert.match(dash, guard);
  assert.match(browse, guard);
});
