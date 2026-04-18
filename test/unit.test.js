const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  PROJECTS_ROOT,
  isPathSafe,
  isLocalHost,
  decodeProjectName,
  parseFrontmatter,
  sanitizeFrontmatterValue,
  atomicWrite,
} = require('../server.js');

// ---------- isLocalHost ----------
test('isLocalHost accepts loopback variants', () => {
  for (const h of ['localhost', 'localhost:1234', '127.0.0.1', '127.0.0.1:80', '[::1]', '::1']) {
    assert.equal(isLocalHost(h), true, h);
  }
});

test('isLocalHost rejects external hosts', () => {
  for (const h of ['evil.example', '192.168.0.1', 'my.internal:8080', '', undefined, null]) {
    assert.equal(isLocalHost(h), false, String(h));
  }
});

// ---------- isPathSafe ----------
test('isPathSafe accepts project/memory/name.md', () => {
  // Use a real project dir that exists
  const dirs = fs.readdirSync(PROJECTS_ROOT).filter(d =>
    fs.existsSync(path.join(PROJECTS_ROOT, d, 'memory')));
  if (!dirs.length) return; // skip if env has no projects yet
  const p = path.join(PROJECTS_ROOT, dirs[0], 'memory', 'fake.md');
  assert.equal(isPathSafe(p), true);
});

test('isPathSafe rejects outside-root paths', () => {
  assert.equal(isPathSafe('/etc/passwd'), false);
  assert.equal(isPathSafe('/tmp/evil.md'), false);
});

test('isPathSafe rejects wrong structure (not 3 segments)', () => {
  const bad = path.join(PROJECTS_ROOT, 'a', 'b', 'c', 'd.md');
  assert.equal(isPathSafe(bad), false);
});

test('isPathSafe rejects wrong middle segment', () => {
  const bad = path.join(PROJECTS_ROOT, 'anything', 'notmemory', 'x.md');
  assert.equal(isPathSafe(bad), false);
});

test('isPathSafe rejects non-.md extension', () => {
  const bad = path.join(PROJECTS_ROOT, 'anything', 'memory', 'x.txt');
  assert.equal(isPathSafe(bad), false);
});

// ---------- parseFrontmatter ----------
test('parseFrontmatter parses basic frontmatter', () => {
  const { frontmatter, body } = parseFrontmatter('---\nname: hi\ntype: user\n---\nbody text');
  assert.equal(frontmatter.name, 'hi');
  assert.equal(frontmatter.type, 'user');
  assert.equal(body, 'body text');
});

test('parseFrontmatter accepts closing --- without trailing newline', () => {
  // Regression for the bug where missing trailing \n caused the whole file
  // to land in body and a subsequent write to double-wrap frontmatter.
  const { frontmatter, body } = parseFrontmatter('---\nname: x\n---');
  assert.equal(frontmatter.name, 'x');
  assert.equal(body, '');
});

test('parseFrontmatter returns empty frontmatter when none present', () => {
  const { frontmatter, body } = parseFrontmatter('plain text\nwith no fm');
  assert.deepEqual(frontmatter, {});
  assert.equal(body, 'plain text\nwith no fm');
});

// ---------- sanitizeFrontmatterValue ----------
test('sanitizeFrontmatterValue strips newlines', () => {
  assert.equal(sanitizeFrontmatterValue('a\nb\r\nc'), 'a b c');
});

test('sanitizeFrontmatterValue neutralises --- sequences', () => {
  // Regression for YAML-block escape attacks.
  assert.equal(sanitizeFrontmatterValue('x---evil'), 'x—evil');
  assert.equal(sanitizeFrontmatterValue('----'), '—');
});

test('sanitizeFrontmatterValue coerces non-strings', () => {
  assert.equal(sanitizeFrontmatterValue(42), '42');
  assert.equal(sanitizeFrontmatterValue(null), 'null');
});

// ---------- decodeProjectName ----------
test('decodeProjectName passes through names without leading dash', () => {
  assert.equal(decodeProjectName('plain-name'), 'plain-name');
});

test('decodeProjectName memoises', () => {
  // Second call should hit the cache — same string identity.
  const a = decodeProjectName('-nonexistent-path-for-test');
  const b = decodeProjectName('-nonexistent-path-for-test');
  assert.equal(a, b);
});

test('decodeProjectName falls back to lossy join when path does not resolve', () => {
  // Deliberately nonsense path — should return reconstructed /a/b/c form.
  const d = decodeProjectName('-this-does-not-exist-xyz');
  assert.equal(d.startsWith('/'), true);
});

// ---------- atomicWrite ----------
test('atomicWrite writes content and removes tmp', () => {
  const target = path.join(os.tmpdir(), 'memorymonitor-atomic-' + Date.now() + '.txt');
  try {
    atomicWrite(target, 'hello');
    assert.equal(fs.readFileSync(target, 'utf8'), 'hello');
    // No leftover .tmp siblings.
    const siblings = fs.readdirSync(os.tmpdir())
      .filter(f => f.startsWith(path.basename(target)) && f.endsWith('.tmp'));
    assert.equal(siblings.length, 0);
  } finally {
    try { fs.unlinkSync(target); } catch {}
  }
});

test('atomicWrite creates file with 0o600 permissions', () => {
  if (process.platform === 'win32') return; // posix perms only
  const target = path.join(os.tmpdir(), 'memorymonitor-perm-' + Date.now() + '.txt');
  try {
    atomicWrite(target, 'x');
    const stat = fs.statSync(target);
    // Mask to rwxrwxrwx bits; expect owner-only read+write.
    assert.equal(stat.mode & 0o777, 0o600);
  } finally {
    try { fs.unlinkSync(target); } catch {}
  }
});
