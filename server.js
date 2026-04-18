#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const PROJECTS_ROOT = process.env.CLAUDE_PROJECTS_ROOT || path.join(os.homedir(), '.claude', 'projects');
// Walk decoded project names from this root instead of `/`. Used by the
// screenshot fixture runner so demo data can live under a scratch dir while
// still producing realistic-looking decoded paths in the UI.
const DECODE_ROOT = process.env.CLAUDE_DECODE_ROOT || '';
const PORT = parseInt(process.env.PORT || '0', 10);

const decodeCache = new Map();
function decodeProjectName(encoded) {
  if (!encoded.startsWith('-')) return encoded;
  const hit = decodeCache.get(encoded);
  if (hit !== undefined) return hit;
  const parts = encoded.slice(1).split('-');
  const startRoot = DECODE_ROOT || '/';
  function walk(i, current) {
    if (i >= parts.length) {
      try { if (fs.statSync(current).isDirectory()) return current; } catch {}
      return null;
    }
    let segment = parts[i];
    for (let j = i; j < parts.length; j++) {
      if (j > i) segment += '-' + parts[j];
      const next = current ? path.join(current, segment) : path.join(startRoot, segment);
      let exists = false;
      try { exists = fs.statSync(next).isDirectory(); } catch {}
      if (exists) {
        const result = walk(j + 1, next);
        if (result) return result;
      }
    }
    return null;
  }
  const found = walk(0, '');
  let result;
  if (found) {
    // Strip the decode-root prefix so the UI sees the "virtual" absolute path.
    result = DECODE_ROOT && found.startsWith(DECODE_ROOT)
      ? found.slice(DECODE_ROOT.length) || '/'
      : found;
  } else {
    result = '/' + parts.join('/');
  }
  decodeCache.set(encoded, result);
  return result;
}

function parseFrontmatter(text) {
  // Accept closing `---` with or without a trailing newline / EOF.
  const m = text.match(/^---\n([\s\S]*?)\n---(?:\n([\s\S]*))?$/);
  if (!m) return { frontmatter: {}, body: text };
  const fm = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].trim();
  }
  return { frontmatter: fm, body: m[2] || '' };
}

function projectShortName(decoded) {
  return decoded.split('/').filter(Boolean).slice(-1)[0] || decoded;
}

function listMemories() {
  const projects = [];
  const allFiles = [];
  let dirs;
  try { dirs = fs.readdirSync(PROJECTS_ROOT); } catch { return { projects, files: allFiles }; }
  for (const d of dirs) {
    const projectDir = path.join(PROJECTS_ROOT, d);
    let projStat;
    try { projStat = fs.statSync(projectDir); } catch { continue; }
    if (!projStat.isDirectory()) continue;
    const decoded = decodeProjectName(d);
    const shortName = projectShortName(decoded);
    const memDir = path.join(projectDir, 'memory');
    let files = [];
    try { files = fs.readdirSync(memDir); } catch {}
    const projectFiles = [];
    for (const f of files) {
      if (!f.endsWith('.md')) continue;
      const full = path.join(memDir, f);
      let stat, raw;
      try {
        stat = fs.statSync(full);
        raw = fs.readFileSync(full, 'utf8');
      } catch { continue; }
      const { frontmatter, body } = parseFrontmatter(raw);
      projectFiles.push({
        name: f,
        path: full,
        project: shortName,
        projectFull: decoded,
        isIndex: f === 'MEMORY.md',
        mtime: stat.mtimeMs,
        size: stat.size,
        frontmatter,
        body,
        raw,
      });
    }
    projects.push({ encoded: d, decoded, shortName, count: projectFiles.length });
    allFiles.push(...projectFiles);
  }
  projects.sort((a, b) => b.count - a.count || a.shortName.localeCompare(b.shortName));
  return { projects, files: allFiles };
}

let listCache = { at: 0, payload: null };
function listMemoriesCached() {
  const now = Date.now();
  if (listCache.payload && now - listCache.at < 1000) return listCache.payload;
  listCache = { at: now, payload: JSON.stringify(listMemories()) };
  return listCache.payload;
}

function isPathSafe(p) {
  const resolved = path.resolve(p);
  if (!resolved.startsWith(PROJECTS_ROOT + path.sep)) return false;
  const rel = path.relative(PROJECTS_ROOT, resolved);
  const parts = rel.split(path.sep);
  if (parts.length !== 3) return false;
  if (parts[1] !== 'memory') return false;
  if (!parts[2].endsWith('.md')) return false;
  // Defeat symlink-escape: real path of parent must also live under PROJECTS_ROOT.
  try {
    const parent = path.dirname(resolved);
    const realParent = fs.realpathSync(parent);
    if (!realParent.startsWith(PROJECTS_ROOT + path.sep)) return false;
    if (fs.existsSync(resolved)) {
      const lst = fs.lstatSync(resolved);
      if (lst.isSymbolicLink()) return false;
    }
  } catch { /* parent may not exist yet (POST creates memDir); allow */ }
  return true;
}

function ensureJson(req, res) {
  const ct = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (ct !== 'application/json') {
    send(res, 415, JSON.stringify({ error: 'application/json required' }));
    return false;
  }
  return true;
}

function sanitizeFrontmatterValue(v) {
  // Collapse newlines and neutralise `---` sequences that could break out of the YAML block.
  return String(v).replace(/\r?\n/g, ' ').replace(/---+/g, '—');
}

function atomicWrite(targetPath, content) {
  const tmp = targetPath + '.' + process.pid + '.' + Date.now() + '.tmp';
  fs.writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, targetPath);
  listCache = { at: 0, payload: null };
}

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e6) { req.destroy(); reject(new Error('body too large')); } });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Claude Memory Monitor</title>
<style>
  :root {
    --bg: #ffffff; --panel: #f7f8fa; --panel-2: #eef0f4; --border: #e1e4ea;
    --text: #1a1d24; --muted: #606878; --dim: #6b7280;
    --accent: #2563eb; --accent-text: #ffffff; --danger: #b91c1c;
    --feedback: #b4590a;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body { margin: 0; font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background: var(--bg); color: var(--text); overflow: hidden; }
  button, input, select, textarea { font: inherit; color: inherit; }

  .app { display: grid; grid-template-rows: 44px 1fr; height: 100vh; }
  header { display: flex; align-items: center; gap: 12px; padding: 0 16px;
    border-bottom: 1px solid var(--border); background: var(--bg); }
  header h1 { font-size: 13px; margin: 0; font-weight: 600; letter-spacing: 0.02em; }
  header nav { display: flex; gap: 2px; margin-left: 16px; }
  header nav a { color: var(--muted); text-decoration: none; font-size: 12px;
    padding: 4px 10px; border-radius: 4px; }
  header nav a:hover { color: var(--text); background: var(--panel-2); }
  header nav a.active { color: var(--text); background: var(--panel-2); }
  header .status { color: var(--muted); font-size: 12px; margin-left: auto;
    font-variant-numeric: tabular-nums; }

  .body { display: grid; grid-template-columns: 340px 1fr; min-height: 0; }
  aside { border-right: 1px solid var(--border); display: flex; flex-direction: column; min-height: 0;
    background: var(--panel); }
  main { min-height: 0; overflow: auto; background: var(--bg); }

  .rail-top { padding: 10px; border-bottom: 1px solid var(--border); display: flex; flex-direction: column; gap: 8px; }
  .search { position: relative; }
  .search input { width: 100%; padding: 7px 10px 7px 28px; background: var(--bg);
    border: 1px solid var(--border); border-radius: 4px; }
  .search input:focus { outline: none; border-color: var(--accent); }
  .search .kbd { position: absolute; right: 8px; top: 50%; transform: translateY(-50%);
    font-size: 11px; color: var(--dim); border: 1px solid var(--border); padding: 1px 4px;
    border-radius: 3px; font-family: ui-monospace, monospace; }
  .search::before { content: ''; position: absolute; left: 10px; top: 50%; transform: translateY(-50%);
    width: 12px; height: 12px;
    background: center/contain no-repeat url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%235a6272' stroke-width='2'><circle cx='11' cy='11' r='7'/><path d='m20 20-3.5-3.5'/></svg>"); }

  .row-controls { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; align-items: center; }
  select { padding: 5px 8px; background: var(--bg); border: 1px solid var(--border);
    border-radius: 4px; font-size: 12px; min-width: 0; width: 100%; }
  select:focus { outline: none; border-color: var(--accent); }
  .toggle { font-size: 11px; color: var(--muted); display: inline-flex; align-items: center; gap: 5px;
    cursor: pointer; user-select: none; }
  .toggle input { accent-color: var(--accent); }

  .list { flex: 1; overflow-y: auto; min-height: 0; }
  .group-label { padding: 10px 12px 4px; font-size: 10px; color: var(--dim);
    text-transform: uppercase; letter-spacing: 0.08em; position: sticky; top: 0;
    background: var(--panel); z-index: 1; }
  .item { padding: 8px 12px; border-bottom: 1px solid var(--border); cursor: pointer;
    display: grid; grid-template-columns: 1fr 44px; gap: 10px; align-items: center;
    position: relative; }
  .item:hover { background: var(--panel-2); }
  .item:hover .title { color: var(--accent); }
  .item.selected { background: var(--panel-2); box-shadow: inset 2px 0 0 var(--accent); }
  .item.selected .title { color: var(--text); font-weight: 600; }
  .item .main { min-width: 0; }
  .item .title { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .item .desc { font-size: 12px; color: var(--muted); overflow: hidden; text-overflow: ellipsis;
    white-space: nowrap; margin-top: 1px; }
  .item .time { font-size: 11px; color: var(--dim); font-variant-numeric: tabular-nums;
    white-space: nowrap; text-align: right; }
  .item.is-new::after { content: 'NEW'; position: absolute; top: 6px; right: 6px;
    background: var(--accent); color: var(--bg); font-size: 9px; font-weight: 600;
    padding: 1px 4px; border-radius: 2px; letter-spacing: 0.06em; }
  .item.is-new .meta { visibility: hidden; }
  .item.flash { animation: flash 1s ease; }
  @keyframes flash { 0% { background: rgba(37,99,235,0.12); } 100% { background: transparent; } }

  .empty-list { padding: 40px 20px; color: var(--dim); text-align: center; font-size: 12px; }

  /* Detail pane */
  .detail { max-width: 680px; margin: 0; padding: 20px 28px 60px; }
  .detail-empty { display: flex; height: 100%; align-items: center; justify-content: center;
    color: var(--dim); text-align: center; padding: 40px; }
  .detail-empty .kbd { display: inline-block; border: 1px solid var(--border); padding: 1px 5px;
    border-radius: 3px; font-family: ui-monospace, monospace; font-size: 11px; color: var(--muted); }

  .d-head { margin-bottom: 16px; }
  .d-breadcrumb { font-size: 12px; color: var(--dim);
    display: flex; gap: 6px; align-items: center; margin-bottom: 8px; }
  .d-breadcrumb .sep { color: var(--dim); }
  .d-breadcrumb .copy { cursor: pointer; color: var(--dim); background: transparent;
    border: none; padding: 0 2px; font: inherit; }
  .d-breadcrumb .copy:hover { color: var(--accent); }
  .d-breadcrumb .copy:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 2px; }
  .item:focus-visible, .row:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .d-type { display: inline-flex; align-items: center; padding: 1px 7px;
    border-radius: 3px; font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em;
    background: var(--panel-2); color: var(--muted); font-weight: 500; }
  .d-type.t-feedback { color: var(--feedback); }

  .d-title { font-size: 20px; font-weight: 600; margin: 4px 0 4px; line-height: 1.3; }
  .d-title input { font-size: 20px; font-weight: 600; width: 100%; background: transparent;
    border: 1px solid var(--border); border-radius: 4px; padding: 4px 8px; }
  .d-desc { color: var(--muted); font-size: 13px; }
  .d-desc input { width: 100%; background: transparent; border: 1px solid var(--border);
    border-radius: 4px; padding: 4px 8px; color: var(--muted); font-size: 13px; }
  .d-meta-row { display: flex; gap: 12px; align-items: center; margin-top: 10px; flex-wrap: wrap; }
  .d-meta-row select { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; }

  .pane { padding: 14px 0; }
  .pane textarea { width: 100%; min-height: 320px; background: var(--panel);
    border: 1px solid var(--border); border-radius: 4px; padding: 12px;
    font: 13px/1.6 ui-monospace, monospace; resize: vertical; }
  .pane textarea:focus { outline: none; border-color: var(--accent); }

  .md-body { font-size: 14px; line-height: 1.6; }
  .md-body p { margin: 0 0 10px; }
  .md-body code { background: var(--panel-2); padding: 1px 5px; border-radius: 3px;
    font: 12px/1.5 ui-monospace, monospace; }
  .md-body pre { background: var(--panel); padding: 12px; border-radius: 4px;
    border: 1px solid var(--border); overflow-x: auto; }
  .md-body pre code { background: transparent; padding: 0; }
  .md-body ul, .md-body ol { padding-left: 20px; margin: 0 0 10px; }
  .md-body li { margin-bottom: 2px; }
  .md-body strong { color: var(--text); font-weight: 600; }
  .md-body a { color: var(--accent); text-decoration: none; }
  .md-body a:hover { text-decoration: underline; }

  .callout { padding: 0; margin: 0 0 14px; }
  .callout .label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em;
    color: var(--dim); font-weight: 500; margin-bottom: 4px; }
  .feedback-rule { font-size: 14px; line-height: 1.5; margin-bottom: 14px; }
  .feedback-rule p:first-child { font-weight: 500; }

  .d-footer { margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--border);
    display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .d-footer .stamps { color: var(--dim); font-size: 11px; }
  .d-footer .spacer { flex: 1; }
  button { background: transparent; color: var(--text); border: 1px solid var(--border);
    padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 12px; }
  button:hover { border-color: var(--muted); }
  button:disabled { opacity: 0.4; cursor: not-allowed; }
  button.primary { background: var(--accent); color: var(--bg); border-color: var(--accent); font-weight: 500; }
  button.primary:hover { opacity: 0.9; }
  button.primary:disabled:hover { opacity: 0.4; }
  button.ghost { color: var(--muted); border-color: transparent; }
  button.ghost:hover { color: var(--danger); border-color: var(--danger); background: transparent; }

  .conflict { background: rgba(220,38,38,0.06); border: 1px solid var(--danger);
    border-radius: 4px; padding: 10px 14px; margin: 12px 0; font-size: 12px;
    display: flex; gap: 12px; align-items: center; color: var(--danger); }
  .conflict .spacer { flex: 1; }

  .toast { position: fixed; bottom: 20px; right: 20px; background: var(--panel);
    border: 1px solid var(--border); padding: 10px 14px; border-radius: 4px;
    opacity: 0; transition: opacity 0.2s, transform 0.2s; transform: translateY(8px);
    pointer-events: none; max-width: 340px; font-size: 12px; z-index: 100; }
  .toast.show { opacity: 1; transform: translateY(0); pointer-events: auto; }
  .toast.error { border-color: var(--danger); color: var(--danger); }
  .toast.link { cursor: pointer; }
  .toast.link:hover { border-color: var(--accent); }

  /* Modal */
  .modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 200;
    display: flex; align-items: center; justify-content: center; }
  .modal { background: var(--panel); border: 1px solid var(--border); border-radius: 6px;
    width: 560px; max-width: calc(100vw - 40px); max-height: calc(100vh - 80px);
    display: flex; flex-direction: column; }
  .modal-head { padding: 14px 20px; border-bottom: 1px solid var(--border);
    font-weight: 600; display: flex; align-items: center; }
  .modal-head .spacer { flex: 1; }
  .modal-body { padding: 20px; overflow-y: auto; display: flex; flex-direction: column; gap: 14px; }
  .modal-body label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--muted); }
  .modal-body input, .modal-body select, .modal-body textarea {
    background: var(--bg); border: 1px solid var(--border); border-radius: 4px;
    padding: 7px 10px; color: var(--text); font-size: 13px; }
  .modal-body input:focus, .modal-body select:focus, .modal-body textarea:focus {
    outline: none; border-color: var(--accent); }
  .modal-body textarea { min-height: 160px; font: 13px/1.6 ui-monospace, monospace; resize: vertical; }
  .modal-foot { padding: 14px 20px; border-top: 1px solid var(--border);
    display: flex; gap: 8px; justify-content: flex-end; }
  .rail-head { display: flex; align-items: center; gap: 8px; margin-bottom: 2px; }
  .rail-head .add-btn { margin-left: auto; padding: 3px 10px; font-size: 12px; }
</style>
</head>
<body>
<div class="app">
  <header>
    <h1>Claude Memory Monitor</h1>
    <nav>
      <a href="/">Browse</a>
      <a href="/dashboard" class="active">Workspace</a>
    </nav>
    <span class="status" id="status">loading…</span>
  </header>
  <div class="body">
    <aside>
      <div class="rail-top">
        <div class="rail-head">
          <button class="add-btn primary" id="add-btn">+ New memory</button>
        </div>
        <div class="search">
          <input id="search" type="search" placeholder="Search memories…" autocomplete="off">
          <span class="kbd">/</span>
        </div>
        <div class="row-controls">
          <select id="project-filter"><option value="">All projects</option></select>
          <select id="sort">
            <option value="recent">Recent</option>
            <option value="project">Project</option>
            <option value="type">Type</option>
          </select>
        </div>
        <label class="toggle"><input type="checkbox" id="show-indexes"> Show index files</label>
      </div>
      <div class="list" id="list"></div>
    </aside>
    <main id="main">
      <div class="detail-empty">
        <div>
          Select a memory to view.<br><br>
          <span class="kbd">/</span> search &nbsp; <span class="kbd">j</span>/<span class="kbd">k</span> navigate &nbsp; <span class="kbd">e</span> edit &nbsp; <span class="kbd">Esc</span> deselect
        </div>
      </div>
    </main>
  </div>
</div>
<div class="toast" id="toast"></div>
<div id="modal-root"></div>
<script>
"use strict";

const LS_KEY = 'memory-monitor:v2';
const defaultFilters = { search: '', project: '', sort: 'recent', showIndexes: false };

const state = {
  files: [],
  projects: [],
  selected: null,          // path of selected file
  editing: false,
  dirty: { name: null, description: null, type: null, body: null },
  openedMtime: null,       // mtime when detail was last loaded
  known: null,             // Set of known paths (for NEW badge)
  newPaths: new Map(),     // path -> timestamp first seen
  filters: loadFilters(),
  lastSync: null,          // timestamp of last successful refresh
  filesSig: '',            // (path,mtime) signature of last fetch
  modalReturnFocus: null,  // element to refocus when modal closes
};

function loadFilters() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    return {
      search: raw.search || '',
      project: raw.project || '',
      sort: raw.sort || 'recent',
      showIndexes: !!raw.showIndexes,
    };
  } catch { return { ...defaultFilters }; }
}
function saveFilters() {
  localStorage.setItem(LS_KEY, JSON.stringify({
    search: state.filters.search,
    project: state.filters.project,
    sort: state.filters.sort,
    showIndexes: state.filters.showIndexes,
  }));
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function typeOf(file) {
  if (file.isIndex) return 'index';
  const t = (file.frontmatter && file.frontmatter.type) || '';
  return ['user','feedback','project','reference'].includes(t) ? t : 'unknown';
}

function displayName(file) {
  if (file.isIndex) return file.projectFull.split('/').slice(-1)[0] + ' index';
  return file.frontmatter.name || file.name.replace(/\\.md$/, '');
}

function fmtRelative(ms) {
  const diff = (Date.now() - ms) / 1000;
  if (diff < 10) return 'just now';
  if (diff < 60) return Math.floor(diff) + 's';
  if (diff < 3600) return Math.floor(diff / 60) + 'm';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h';
  if (diff < 604800) return Math.floor(diff / 86400) + 'd';
  return Math.floor(diff / 604800) + 'w';
}
function fmtAbsolute(ms) { return new Date(ms).toLocaleString(); }

function recencyBucket(ms) {
  const diff = (Date.now() - ms) / 1000;
  if (diff < 86400) return 'Today';
  if (diff < 86400 * 7) return 'This week';
  if (diff < 86400 * 30) return 'This month';
  return 'Older';
}

function filtered() {
  const q = state.filters.search.trim().toLowerCase();
  return state.files.filter(f => {
    if (!state.filters.showIndexes && f.isIndex) return false;
    if (state.filters.project && f.projectFull !== state.filters.project) return false;
    if (q && !(f._hay || '').includes(q)) return false;
    return true;
  });
}

function sorted(items) {
  const s = state.filters.sort;
  const copy = items.slice();
  if (s === 'recent') copy.sort((a, b) => b.mtime - a.mtime);
  else if (s === 'project') copy.sort((a, b) => a.project.localeCompare(b.project) || b.mtime - a.mtime);
  else if (s === 'type') copy.sort((a, b) => typeOf(a).localeCompare(typeOf(b)) || b.mtime - a.mtime);
  return copy;
}

function renderProjectFilter() {
  const sel = document.getElementById('project-filter');
  const current = state.filters.project;
  sel.innerHTML = '<option value="">All projects</option>' +
    state.projects.map(p => \`<option value="\${esc(p.decoded)}">\${esc(p.shortName)} (\${p.count})</option>\`).join('');
  sel.value = current;
}

function renderList() {
  const items = sorted(filtered());
  const list = document.getElementById('list');
  const savedScroll = list.scrollTop;

  if (!items.length) {
    list.innerHTML = '<div class="empty-list">No memories match.</div>';
    list.scrollTop = savedScroll;
    return;
  }

  const useGroups = state.filters.sort === 'recent';
  let html = '';
  let lastGroup = null;
  for (const f of items) {
    if (useGroups) {
      const g = recencyBucket(f.mtime);
      if (g !== lastGroup) {
        html += \`<div class="group-label">\${g}</div>\`;
        lastGroup = g;
      }
    }
    const t = typeOf(f);
    const isNew = state.newPaths.has(f.path);
    const selected = state.selected === f.path;
    const title = displayName(f);
    const desc = f.frontmatter.description || (f.isIndex ? 'Project memory index' : '');
    html += \`
      <div class="item t-\${t} \${selected ? 'selected' : ''} \${isNew ? 'is-new' : ''}"
           data-path="\${esc(f.path)}" role="button" tabindex="0"
           aria-selected="\${selected ? 'true' : 'false'}"
           title="\${esc(f.project)} · \${esc(fmtAbsolute(f.mtime))}">
        <div class="main">
          <div class="title">\${esc(title)}</div>
          <div class="desc">\${esc(desc)}</div>
        </div>
        <div class="time">\${fmtRelative(f.mtime)}</div>
      </div>\`;
  }
  list.innerHTML = html;
  list.scrollTop = savedScroll;
}

function selectPath(p, opts = {}) {
  if (state.editing && state.selected !== p && !opts.force) {
    if (hasUnsavedChanges()) {
      if (!confirm('Discard unsaved changes?')) return;
    }
  }
  state.selected = p;
  state.editing = false;
  state.dirty = { name: null, description: null, type: null, body: null };
  const f = state.files.find(x => x.path === p);
  state.openedMtime = f ? f.mtime : null;
  // Clear NEW marker once viewed
  state.newPaths.delete(p);
  renderList();
  renderDetail();
  // Ensure selected row visible
  const row = document.querySelector('.item.selected');
  if (row) row.scrollIntoView({ block: 'nearest' });
}

function hasUnsavedChanges() {
  return Object.values(state.dirty).some(v => v !== null);
}

function currentFieldValue(file, key) {
  if (state.dirty[key] !== null) return state.dirty[key];
  if (key === 'body') return file.body;
  return file.frontmatter[key] || '';
}

function renderDetail() {
  const main = document.getElementById('main');
  if (!state.selected) {
    main.innerHTML = \`
      <div class="detail-empty">
        <div>
          Select a memory to view.<br><br>
          <span class="kbd">/</span> search &nbsp; <span class="kbd">j</span>/<span class="kbd">k</span> navigate &nbsp; <span class="kbd">e</span> edit &nbsp; <span class="kbd">Esc</span> deselect
        </div>
      </div>\`;
    return;
  }
  const f = state.files.find(x => x.path === state.selected);
  if (!f) {
    main.innerHTML = '<div class="detail-empty">Memory no longer exists. It may have been deleted.</div>';
    return;
  }
  const t = typeOf(f);
  const editing = state.editing;
  const fileMtimeChanged = f.mtime !== state.openedMtime;

  const nameVal = currentFieldValue(f, 'name');
  const descVal = currentFieldValue(f, 'description');
  const typeVal = currentFieldValue(f, 'type') || (f.isIndex ? '' : t);
  const bodyVal = currentFieldValue(f, 'body');

  const title = editing
    ? \`<div class="d-title"><input id="fld-name" value="\${esc(nameVal)}" placeholder="Memory name"></div>\`
    : \`<div class="d-title">\${esc(displayName(f))}</div>\`;
  const desc = editing
    ? \`<div class="d-desc"><input id="fld-desc" value="\${esc(descVal)}" placeholder="One-line description"></div>\`
    : '';

  const typeSelector = editing && !f.isIndex
    ? \`<select id="fld-type">\${['user','feedback','project','reference'].map(tt =>
        \`<option value="\${tt}" \${tt === typeVal ? 'selected' : ''}>\${tt}</option>\`).join('')}</select>\`
    : \`<span class="d-type t-\${t}">\${t}</span>\`;

  const bodyEl = editing
    ? \`<textarea id="fld-body" spellcheck="false">\${esc(bodyVal)}</textarea>\`
    : renderBody(f, t);

  const conflict = fileMtimeChanged && editing
    ? \`<div class="conflict">
         <strong>This memory changed on disk</strong>
         <span>while you were editing.</span>
         <span class="spacer"></span>
         <button data-action="reload-disk">Discard & Reload</button>
       </div>\`
    : '';

  const saveDisabled = !editing || !hasUnsavedChanges();

  main.innerHTML = \`
    <div class="detail">
      <div class="d-head">
        <div class="d-breadcrumb">
          <span>\${esc(f.projectFull)}</span>
          <span class="sep">›</span>
          <span>\${esc(f.name)}</span>
          <button class="copy" data-action="copy-path" aria-label="Copy full path" title="Copy full path">⧉</button>
        </div>
        <div class="d-meta-row">\${typeSelector}</div>
        \${title}
        \${desc}
      </div>
      \${conflict}
      <div class="pane">\${bodyEl}</div>
      <div class="d-footer">
        <span class="stamps" title="\${esc(fmtAbsolute(f.mtime))}">
          Modified \${fmtRelative(f.mtime)} ago\${f.frontmatter.originSessionId ? ' · session ' + esc(f.frontmatter.originSessionId.slice(0, 8)) : ''}
        </span>
        <span class="spacer"></span>
        \${editing
          ? \`<button data-action="cancel">Cancel</button>
             <button class="primary" data-action="save" \${saveDisabled ? 'disabled' : ''}>Save</button>\`
          : \`<button class="ghost" data-action="delete">Delete</button>
             <button data-action="edit">Edit</button>\`}
      </div>
    </div>\`;

  // Wire up field listeners
  if (editing) {
    const nameIn = document.getElementById('fld-name');
    const descIn = document.getElementById('fld-desc');
    const typeIn = document.getElementById('fld-type');
    const bodyIn = document.getElementById('fld-body');
    nameIn && nameIn.addEventListener('input', () => {
      state.dirty.name = nameIn.value;
      updateSaveButton();
    });
    descIn && descIn.addEventListener('input', () => {
      state.dirty.description = descIn.value;
      updateSaveButton();
    });
    typeIn && typeIn.addEventListener('change', () => {
      state.dirty.type = typeIn.value;
      updateSaveButton();
    });
    bodyIn && bodyIn.addEventListener('input', () => {
      state.dirty.body = bodyIn.value;
      updateSaveButton();
    });
  }
}

function updateSaveButton() {
  const btn = document.querySelector('[data-action="save"]');
  if (btn) btn.disabled = !hasUnsavedChanges();
}

// Minimal markdown-ish rendering. Handles paragraphs, **bold**, \`code\`,
// bullet lists, and links. Good enough for memory bodies.
function renderMarkdown(text) {
  const escaped = esc(text);
  const lines = escaped.split('\\n');
  const out = [];
  let listBuf = [];
  const flushList = () => {
    if (listBuf.length) {
      out.push('<ul>' + listBuf.map(l => '<li>' + inline(l) + '</li>').join('') + '</ul>');
      listBuf = [];
    }
  };
  const inline = s => s
    .replace(/\`([^\`]+)\`/g, '<code>$1</code>')
    .replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>')
    .replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, (_, label, url) => {
      const safe = /^(https?:|mailto:|#|\\/)/i.test(url);
      return safe ? '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + label + '</a>' : label;
    });
  let para = [];
  const flushPara = () => {
    if (para.length) { out.push('<p>' + inline(para.join(' ')) + '</p>'); para = []; }
  };
  for (const line of lines) {
    const m = line.match(/^\\s*[-*]\\s+(.*)$/);
    if (m) { flushPara(); listBuf.push(m[1]); continue; }
    if (line.trim() === '') { flushPara(); flushList(); continue; }
    para.push(line);
  }
  flushPara(); flushList();
  return out.join('');
}

function renderBody(file, type) {
  if (type === 'feedback') return renderFeedbackBody(file.body);
  return '<div class="md-body">' + renderMarkdown(file.body) + '</div>';
}

function renderFeedbackBody(body) {
  // Feedback memories: rule, then **Why:** ... **How to apply:** ...
  const whyIdx = body.search(/\\*\\*Why:\\*\\*/);
  const howIdx = body.search(/\\*\\*How to apply:\\*\\*/);
  if (whyIdx < 0 && howIdx < 0) {
    return '<div class="md-body">' + renderMarkdown(body) + '</div>';
  }
  const rule = body.slice(0, Math.min(...[whyIdx, howIdx].filter(i => i >= 0))).trim();
  let why = '', how = '';
  if (whyIdx >= 0) {
    const end = howIdx > whyIdx ? howIdx : body.length;
    why = body.slice(whyIdx, end).replace(/^\\*\\*Why:\\*\\*/, '').trim();
  }
  if (howIdx >= 0) {
    how = body.slice(howIdx).replace(/^\\*\\*How to apply:\\*\\*/, '').trim();
  }
  let html = '';
  if (rule) html += '<div class="feedback-rule">' + renderMarkdown(rule) + '</div>';
  if (why) html += '<div class="callout"><div class="label">Why</div><div class="md-body">' + renderMarkdown(why) + '</div></div>';
  if (how) html += '<div class="callout"><div class="label">How to apply</div><div class="md-body">' + renderMarkdown(how) + '</div></div>';
  return html;
}

function buildFileContent(file) {
  const fm = { ...file.frontmatter };
  if (state.dirty.name !== null) fm.name = state.dirty.name;
  if (state.dirty.description !== null) fm.description = state.dirty.description;
  if (state.dirty.type !== null) fm.type = state.dirty.type;
  const body = state.dirty.body !== null ? state.dirty.body : file.body;

  // Only write frontmatter if the file originally had any, or we have structured fields now
  const hasFrontmatter = Object.keys(fm).length > 0 || /^---\\n/.test(file.raw);
  if (!hasFrontmatter) return body;

  const order = ['name', 'description', 'type', 'originSessionId'];
  const keys = order.filter(k => fm[k] != null && fm[k] !== '')
    .concat(Object.keys(fm).filter(k => !order.includes(k) && fm[k] != null && fm[k] !== ''));
  const lines = keys.map(k => \`\${k}: \${fm[k]}\`);
  return '---\\n' + lines.join('\\n') + '\\n---\\n' + body;
}

async function save() {
  const f = state.files.find(x => x.path === state.selected);
  if (!f) return;
  const content = buildFileContent(f);
  try {
    const r = await fetch('/api/memory', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: f.path, content, expectedMtime: state.openedMtime }),
    });
    const data = await r.json();
    if (r.status === 409) {
      if (confirm('File changed on disk while editing. Overwrite?')) {
        await fetch('/api/memory', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: f.path, content }),
        });
      } else return;
    } else if (!r.ok) throw new Error(data.error || r.statusText);
    state.editing = false;
    state.dirty = { name: null, description: null, type: null, body: null };
    toast('Saved');
    await refresh();
  } catch (e) {
    toast('Save failed: ' + e.message, 'error');
  }
}

async function deleteMemory() {
  const f = state.files.find(x => x.path === state.selected);
  if (!f) return;
  const msg = state.editing && hasUnsavedChanges()
    ? \`Delete "\${displayName(f)}" and discard unsaved changes? This cannot be undone.\`
    : \`Delete "\${displayName(f)}"? This cannot be undone.\`;
  if (!confirm(msg)) return;
  try {
    const r = await fetch('/api/memory?path=' + encodeURIComponent(f.path), { method: 'DELETE' });
    if (!r.ok) throw new Error((await r.json()).error || r.statusText);
    state.selected = null;
    toast('Deleted');
    await refresh();
  } catch (e) {
    toast('Delete failed: ' + e.message, 'error');
  }
}

function slugify(s) {
  return String(s || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'untitled';
}

function openAddModal() {
  const root = document.getElementById('modal-root');
  state.modalReturnFocus = document.activeElement;
  const defaultProject = state.filters.project || (state.projects[0] && state.projects[0].decoded) || '';
  root.innerHTML = \`
    <div class="modal-overlay" data-action="overlay-close">
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <div class="modal-head" id="modal-title">New memory<span class="spacer"></span>
          <button data-action="close-modal" aria-label="Close">✕</button>
        </div>
        <div class="modal-body">
          <label>Project
            <select id="add-project">\${state.projects.map(p =>
              \`<option value="\${esc(p.decoded)}" \${p.decoded === defaultProject ? 'selected' : ''}>\${esc(p.shortName)} — \${esc(p.decoded)}</option>\`
            ).join('')}</select>
          </label>
          <label>Type
            <select id="add-type">
              <option value="user">user — facts about you</option>
              <option value="feedback" selected>feedback — rules from corrections/confirmations</option>
              <option value="project">project — initiatives, deadlines</option>
              <option value="reference">reference — pointers to external systems</option>
            </select>
          </label>
          <label>Name
            <input id="add-name" placeholder="Short title shown in the list" autofocus>
          </label>
          <label>Description
            <input id="add-description" placeholder="One-line description (used for relevance scoring)">
          </label>
          <label>Body
            <textarea id="add-body" spellcheck="false" placeholder="Main content. For feedback, structure as:
rule

**Why:** …

**How to apply:** …"></textarea>
          </label>
          <label style="flex-direction: row; align-items: center; gap: 8px; color: var(--muted);">
            <input type="checkbox" id="add-index-update" checked>
            Also add a pointer line to this project's MEMORY.md index
          </label>
        </div>
        <div class="modal-foot">
          <button data-action="close-modal">Cancel</button>
          <button class="primary" data-action="create-memory">Create</button>
        </div>
      </div>
    </div>\`;
  setTimeout(() => document.getElementById('add-name') ?.focus(), 0);
}

function closeModal() {
  document.getElementById('modal-root').innerHTML = '';
  const ret = state.modalReturnFocus;
  state.modalReturnFocus = null;
  if (ret && typeof ret.focus === 'function') setTimeout(() => ret.focus(), 0);
}
function modalIsOpen() {
  return !!document.querySelector('.modal-overlay');
}
function focusableInModal() {
  const m = document.querySelector('.modal');
  if (!m) return [];
  return [...m.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
    .filter(el => !el.disabled && el.offsetParent !== null);
}

async function createMemory() {
  const projectDecoded = document.getElementById('add-project').value;
  const type = document.getElementById('add-type').value;
  const name = document.getElementById('add-name').value.trim();
  const description = document.getElementById('add-description').value.trim();
  const body = document.getElementById('add-body').value;
  const updateIndex = document.getElementById('add-index-update').checked;

  if (!name) { toast('Name required', 'error'); return; }

  const project = state.projects.find(p => p.decoded === projectDecoded);
  if (!project) { toast('Invalid project', 'error'); return; }

  const filename = \`\${type}_\${slugify(name)}.md\`;

  try {
    const r = await fetch('/api/memory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectEncoded: project.encoded,
        filename,
        frontmatter: { name, description, type },
        body,
        updateIndex,
      }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || r.statusText);
    closeModal();
    toast('Created');
    await refresh();
    selectPath(data.path);
  } catch (e) {
    toast('Create failed: ' + e.message, 'error');
  }
}

document.getElementById('add-btn').addEventListener('click', openAddModal);

// Keyboard activation on rows (Enter / Space)
document.addEventListener('keydown', e => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const item = e.target.closest('.item');
  if (!item) return;
  e.preventDefault();
  selectPath(item.dataset.path);
});

// Event delegation
document.addEventListener('click', e => {
  const item = e.target.closest('.item');
  if (item) { selectPath(item.dataset.path); return; }
  const act = e.target.closest('[data-action]');
  if (!act) return;
  const action = act.dataset.action;
  if (action === 'edit') { state.editing = true; renderDetail(); setTimeout(() => document.getElementById('fld-body') ?.focus(), 0); }
  else if (action === 'cancel') {
    if (hasUnsavedChanges() && !confirm('Discard unsaved changes?')) return;
    state.editing = false;
    state.dirty = { name: null, description: null, type: null, body: null };
    renderDetail();
  }
  else if (action === 'save') save();
  else if (action === 'delete') deleteMemory();
  else if (action === 'copy-path') {
    navigator.clipboard.writeText(state.selected).then(() => toast('Path copied'));
  }
  else if (action === 'reload-disk') {
    const f = state.files.find(x => x.path === state.selected);
    if (!f) return;
    state.openedMtime = f.mtime;
    state.dirty = { name: null, description: null, type: null, body: null };
    state.editing = false;
    renderDetail();
  }
  else if (action === 'close-modal') closeModal();
  else if (action === 'overlay-close') { if (e.target === act) closeModal(); }
  else if (action === 'create-memory') createMemory();
});

// Search input
document.getElementById('search').addEventListener('input', e => {
  state.filters.search = e.target.value;
  saveFilters();
  renderList();
  renderStatus();
});
document.getElementById('search').value = state.filters.search;

// Project filter
document.getElementById('project-filter').addEventListener('change', e => {
  state.filters.project = e.target.value;
  saveFilters();
  renderList();
  renderStatus();
});
// Sort
document.getElementById('sort').addEventListener('change', e => {
  state.filters.sort = e.target.value;
  saveFilters();
  renderList();
});
document.getElementById('sort').value = state.filters.sort;
// Show indexes
const idxToggle = document.getElementById('show-indexes');
idxToggle.checked = state.filters.showIndexes;
idxToggle.addEventListener('change', () => {
  state.filters.showIndexes = idxToggle.checked;
  saveFilters();
  renderList();
  renderStatus();
});

// Keyboard shortcuts
document.addEventListener('keydown', e => {
  if (modalIsOpen()) {
    if (e.key === 'Escape') { e.preventDefault(); closeModal(); return; }
    if (e.key === 'Tab') {
      const f = focusableInModal();
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    return;
  }
  const tag = document.activeElement && document.activeElement.tagName || '';
  const inField = /INPUT|TEXTAREA|SELECT/.test(tag);
  if (e.key === '/' && !inField) {
    e.preventDefault();
    document.getElementById('search').focus();
    document.getElementById('search').select();
    return;
  }
  if ((e.key === 'k' && e.metaKey) || (e.key === 'k' && e.ctrlKey)) {
    e.preventDefault();
    document.getElementById('search').focus();
    document.getElementById('search').select();
    return;
  }
  if (e.key === 'Escape') {
    if (inField && document.activeElement.id === 'search') {
      document.activeElement.blur();
    } else if (state.editing) {
      if (hasUnsavedChanges() && !confirm('Discard unsaved changes?')) return;
      state.editing = false;
      state.dirty = { name: null, description: null, type: null, body: null };
      renderDetail();
    } else if (state.selected) {
      state.selected = null;
      renderList();
      renderDetail();
    }
    return;
  }
  if (inField) return;
  if (e.key === 'j' || e.key === 'k') {
    const items = sorted(filtered());
    if (!items.length) return;
    const idx = items.findIndex(f => f.path === state.selected);
    let next;
    if (e.key === 'j') next = idx < 0 ? 0 : Math.min(items.length - 1, idx + 1);
    else next = idx < 0 ? items.length - 1 : Math.max(0, idx - 1);
    selectPath(items[next].path);
    e.preventDefault();
  } else if (e.key === 'e' && state.selected && !state.editing) {
    state.editing = true;
    renderDetail();
    setTimeout(() => document.getElementById('fld-body') ?.focus(), 0);
    e.preventDefault();
  } else if (e.key === 's' && (e.metaKey || e.ctrlKey) && state.editing) {
    e.preventDefault();
    save();
  }
});

let toastTimer;
function toast(msg, variant, onClick) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show' + (variant === 'error' ? ' error' : '') + (onClick ? ' link' : '');
  t.onclick = onClick || null;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), onClick ? 6000 : 2200);
}

function fmtSynced(ms) {
  if (ms == null) return '';
  const diff = (Date.now() - ms) / 1000;
  if (diff < 120) return '';
  if (diff < 3600) return 'synced ' + Math.floor(diff / 60) + 'm ago';
  return 'synced ' + Math.floor(diff / 3600) + 'h ago';
}
function filterActive() {
  return state.filters.search.trim() !== ''
      || state.filters.project !== '';
}
function renderStatus() {
  const el = document.getElementById('status');
  if (!el) return;
  if (state.lastSync == null) { el.textContent = 'loading…'; return; }
  const parts = [\`\${state.files.length} memories\`, \`\${state.projects.length} projects\`];
  if (filterActive()) {
    const shown = filtered().length;
    if (shown !== state.files.length) parts.push(\`\${shown} shown\`);
  }
  const synced = fmtSynced(state.lastSync);
  if (synced) parts.push(synced);
  el.textContent = parts.join(' · ');
}

function filesSignature(files) {
  // Cheap hash of (path,mtime) pairs to decide whether the list needs re-render.
  let s = '';
  for (const f of files) s += f.path + ':' + f.mtime + '|';
  return s;
}

async function refresh() {
  try {
    const r = await fetch('/api/memories');
    const data = await r.json();
    const prevKnown = state.known;
    const nextKnown = new Set(data.files.map(f => f.path));

    if (prevKnown) {
      for (const p of nextKnown) if (!prevKnown.has(p)) state.newPaths.set(p, Date.now());
      for (const [p, ts] of state.newPaths) if (Date.now() - ts > 60000) state.newPaths.delete(p);
      const newlyAdded = [...nextKnown].filter(p => !prevKnown.has(p));
      if (newlyAdded.length === 1) {
        const f = data.files.find(x => x.path === newlyAdded[0]);
        if (f) toast(\`New memory: \${displayName(f)}\`, 'link', () => selectPath(f.path));
      } else if (newlyAdded.length > 1) {
        toast(\`\${newlyAdded.length} new memories\`);
      }
    }

    const nextSig = filesSignature(data.files);
    const sameData = nextSig === state.filesSig;

    // Precompute search haystack once per fetch.
    for (const f of data.files) {
      f._hay = [f.frontmatter.name, f.frontmatter.description, f.name, f.body, f.project]
        .filter(Boolean).join(' ').toLowerCase();
    }

    state.files = data.files;
    state.projects = data.projects;
    state.known = nextKnown;
    state.lastSync = Date.now();
    state.filesSig = nextSig;

    renderStatus();
    if (!sameData) {
      renderProjectFilter();
      renderList();
      // Never tear down the textarea while the user is typing.
      if (state.selected && !state.editing) renderDetail();
    }
  } catch (e) {
    const el = document.getElementById('status');
    if (el) el.textContent = 'refresh failed';
  }
}

function selectFromHash() {
  const m = location.hash.match(/path=([^&]+)/);
  if (!m) return;
  const target = decodeURIComponent(m[1]);
  if (state.files.find(f => f.path === target)) selectPath(target, { force: true });
}

(async () => {
  await refresh();
  selectFromHash();
  const tick = () => { if (!document.hidden) refresh(); };
  setInterval(tick, 5000);
  setInterval(renderStatus, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  window.addEventListener('hashchange', selectFromHash);
})();
</script>
</body>
</html>`;

const OVERVIEW_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Browse — Claude Memory Monitor</title>
<style>
  :root {
    --bg: #ffffff; --panel: #f7f8fa; --panel-2: #eef0f4; --border: #e1e4ea;
    --text: #1a1d24; --muted: #606878; --dim: #6b7280;
    --accent: #2563eb; --feedback: #b4590a;
  }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background: var(--bg); color: var(--text); }
  header { display: flex; align-items: center; gap: 12px; padding: 0 16px; height: 44px;
    border-bottom: 1px solid var(--border); position: sticky; top: 0; background: var(--bg); z-index: 10; }
  header h1 { font-size: 13px; margin: 0; font-weight: 600; letter-spacing: 0.02em; }
  header nav { display: flex; gap: 2px; margin-left: 16px; }
  header nav a { color: var(--muted); text-decoration: none; font-size: 12px;
    padding: 4px 10px; border-radius: 4px; }
  header nav a:hover { color: var(--text); background: var(--panel-2); }
  header nav a.active { color: var(--text); background: var(--panel-2); }
  header .status { color: var(--muted); font-size: 12px; margin-left: auto;
    font-variant-numeric: tabular-nums; }

  .wrap { max-width: 900px; margin: 0; padding: 24px 56px 80px; }
  .project { margin-top: 28px; }
  .project:first-child { margin-top: 8px; }
  .project-head { display: grid;
    grid-template-columns: auto 1fr 40px;
    align-items: baseline; gap: 10px;
    padding-bottom: 4px; margin-bottom: 6px; border-bottom: 1px solid var(--border); }
  .project-head .name { font-size: 13px; font-weight: 500; }
  .project-head .path { font-size: 11px; color: var(--dim); }
  .project-head .count { font-size: 11px; color: var(--dim);
    font-variant-numeric: tabular-nums; text-align: right; }

  .items { padding-left: 24px; }
  .row { display: grid; grid-template-columns: 1fr 90px 220px;
    align-items: center; gap: 12px;
    height: 28px; padding: 0 8px; margin: 0 -8px;
    color: var(--text); cursor: pointer;
    border-radius: 3px; }
  .row:hover { background: var(--panel); }
  .row .title { font-size: 13px; font-weight: 500;
    min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row:hover .title { color: var(--accent); }
  .row.expanded { background: var(--panel); }
  .row.expanded .title { color: var(--text); }
  .row .tag { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em;
    color: var(--dim); }
  .row.t-feedback .tag { color: var(--feedback); }
  .row .file { font-size: 11px; color: var(--dim); font-weight: 400;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .drawer { display: grid; grid-template-rows: 0fr;
    transition: grid-template-rows 200ms ease; margin: 0 -8px; }
  .drawer.open { grid-template-rows: 1fr; }
  .drawer-inner { overflow: hidden; }
  .drawer-content { padding: 6px 8px 16px 32px; }
  .drawer .d-desc { color: var(--muted); font-size: 13px; line-height: 1.55; margin-bottom: 10px; }
  .drawer .d-body { font-size: 13px; line-height: 1.6; color: var(--text); }
  .drawer .d-body p { margin: 0 0 10px; }
  .drawer .d-body p:last-child { margin-bottom: 0; }
  .drawer .d-body ul, .drawer .d-body ol { padding-left: 20px; margin: 0 0 10px; }
  .drawer .d-body li { margin-bottom: 2px; }
  .drawer .d-body code { background: var(--panel-2); padding: 1px 5px; border-radius: 3px;
    font: 12px/1.5 ui-monospace, monospace; }
  .drawer .d-body strong { color: var(--text); font-weight: 600; }
  .drawer .d-body a { color: var(--accent); text-decoration: none; }
  .drawer .d-body a:hover { text-decoration: underline; }
  .drawer .callout { margin: 0 0 12px; }
  .drawer .callout .label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em;
    color: var(--dim); font-weight: 500; margin-bottom: 4px; }
  .drawer .rule { font-weight: 500; margin-bottom: 12px; }
  .drawer .d-footer { margin-top: 10px; font-size: 12px; }
  .drawer .d-open { color: var(--accent); text-decoration: none; }
  .drawer .d-open:hover { text-decoration: underline; }
  @media (prefers-reduced-motion: reduce) { .drawer { transition: none; } }
  .row:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }

  .empty { padding: 80px 0; color: var(--dim); }

  .controls { display: flex; gap: 12px; margin-bottom: 16px; align-items: center; flex-wrap: wrap;
    max-width: 900px; }
  .controls input[type="search"] { flex: 1; min-width: 200px; padding: 6px 10px;
    border: 1px solid var(--border); border-radius: 4px;
    background: var(--bg); color: var(--text); font: inherit; }
  .controls input:focus { outline: none; border-color: var(--accent); }
  .controls label { font-size: 12px; color: var(--muted); display: inline-flex; align-items: center; gap: 5px; }
</style>
</head>
<body>
<header>
  <h1>Claude Memory Monitor</h1>
  <nav>
    <a href="/" class="active">Browse</a>
    <a href="/dashboard">Workspace</a>
  </nav>
</header>
<div class="wrap">
  <div class="controls">
    <input id="search" type="search" placeholder="Filter memories or projects…" autocomplete="off">
    <label><input type="checkbox" id="show-indexes"> Show index files</label>
  </div>
  <div id="root"></div>
</div>
<script>
"use strict";
const LS_KEY = 'memory-monitor:overview';
const state = { files: [], projects: [], filters: load(), expanded: new Set(), filesSig: '' };
function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    return { search: raw.search || '', showIndexes: !!raw.showIndexes };
  } catch { return { search: '', showIndexes: false }; }
}
function save() { localStorage.setItem(LS_KEY, JSON.stringify(state.filters)); }
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function typeOf(f) {
  if (f.isIndex) return 'index';
  const t = (f.frontmatter && f.frontmatter.type) || '';
  return ['user','feedback','project','reference'].includes(t) ? t : 'unknown';
}
function displayName(f) {
  if (f.isIndex) return f.projectFull.split('/').slice(-1)[0] + ' index';
  return f.frontmatter.name || f.name.replace(/\\.md$/, '');
}
function renderMarkdown(text) {
  const escaped = esc(text);
  const lines = escaped.split('\\n');
  const out = [];
  let listBuf = [];
  const inline = s => s
    .replace(/\`([^\`]+)\`/g, '<code>$1</code>')
    .replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>')
    .replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, (_, label, url) => {
      const safe = /^(https?:|mailto:|#|\\/)/i.test(url);
      return safe ? '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + label + '</a>' : label;
    });
  const flushList = () => {
    if (listBuf.length) { out.push('<ul>' + listBuf.map(l => '<li>' + inline(l) + '</li>').join('') + '</ul>'); listBuf = []; }
  };
  let para = [];
  const flushPara = () => { if (para.length) { out.push('<p>' + inline(para.join(' ')) + '</p>'); para = []; } };
  for (const line of lines) {
    const m = line.match(/^\\s*[-*]\\s+(.*)$/);
    if (m) { flushPara(); listBuf.push(m[1]); continue; }
    if (line.trim() === '') { flushPara(); flushList(); continue; }
    para.push(line);
  }
  flushPara(); flushList();
  return out.join('');
}
function renderBody(f, type) {
  const body = f.body || '';
  if (type !== 'feedback') return '<div class="d-body">' + renderMarkdown(body) + '</div>';
  const whyIdx = body.search(/\\*\\*Why:\\*\\*/);
  const howIdx = body.search(/\\*\\*How to apply:\\*\\*/);
  if (whyIdx < 0 && howIdx < 0) return '<div class="d-body">' + renderMarkdown(body) + '</div>';
  const rule = body.slice(0, Math.min(...[whyIdx, howIdx].filter(i => i >= 0))).trim();
  let why = '', how = '';
  if (whyIdx >= 0) {
    const end = howIdx > whyIdx ? howIdx : body.length;
    why = body.slice(whyIdx, end).replace(/^\\*\\*Why:\\*\\*/, '').trim();
  }
  if (howIdx >= 0) how = body.slice(howIdx).replace(/^\\*\\*How to apply:\\*\\*/, '').trim();
  let html = '<div class="d-body">';
  if (rule) html += '<div class="rule">' + renderMarkdown(rule) + '</div>';
  if (why) html += '<div class="callout"><div class="label">Why</div>' + renderMarkdown(why) + '</div>';
  if (how) html += '<div class="callout"><div class="label">How to apply</div>' + renderMarkdown(how) + '</div>';
  html += '</div>';
  return html;
}
function render() {
  const q = state.filters.search.trim().toLowerCase();
  const byProject = new Map();
  for (const f of state.files) {
    if (!state.filters.showIndexes && f.isIndex) continue;
    if (q) {
      const hay = [f.frontmatter.name, f.frontmatter.description, f.name, f.body, f.projectFull]
        .filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(q)) continue;
    }
    if (!byProject.has(f.projectFull)) byProject.set(f.projectFull, []);
    byProject.get(f.projectFull).push(f);
  }
  const root = document.getElementById('root');
  if (!byProject.size) {
    root.innerHTML = '<div class="empty">No memories match.</div>';
    return;
  }
  const ordered = [...byProject.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const allParents = ordered.map(([p]) => p.split('/').filter(Boolean).slice(0, -1));
  const commonPrefix = commonTail(allParents);
  root.innerHTML = ordered.map(([projectFull, files]) => {
    const segs = projectFull.split('/').filter(Boolean);
    const shortName = segs[segs.length - 1];
    const parentSegs = segs.slice(0, -1);
    const divergent = parentSegs.slice(commonPrefix.length).join('/');
    files.sort((a, b) => (a.isIndex ? -1 : 1) - (b.isIndex ? -1 : 1) || b.mtime - a.mtime);
    const rows = files.map(f => {
      const t = typeOf(f);
      const title = displayName(f);
      const deepLink = '/dashboard#path=' + encodeURIComponent(f.path);
      const fileName = f.name.replace(/\\.md$/, '');
      const isOpen = state.expanded.has(f.path);
      const desc = f.frontmatter.description || '';
      const body = (f.body || '').trim();
      const drawerId = 'd-' + btoa(f.path).replace(/[^a-z0-9]/gi, '');
      return \`
        <div class="row t-\${t} \${isOpen ? 'expanded' : ''}" data-path="\${esc(f.path)}" title="\${esc(f.path)}"
             role="button" tabindex="0" aria-expanded="\${isOpen ? 'true' : 'false'}" aria-controls="\${drawerId}">
          <span class="title">\${esc(title)}</span>
          <span class="tag">\${t === 'index' || t === 'unknown' ? '' : t}</span>
          <span class="file">\${esc(fileName)}</span>
        </div>
        <div class="drawer \${isOpen ? 'open' : ''}" id="\${drawerId}" data-for="\${esc(f.path)}" role="region" aria-label="\${esc(title)} details">
          <div class="drawer-inner">
            <div class="drawer-content">
              \${desc ? \`<div class="d-desc">\${esc(desc)}</div>\` : ''}
              \${body ? renderBody(f, t) : ''}
              <div class="d-footer"><a href="\${esc(deepLink)}" class="d-open">Open in workspace →</a></div>
            </div>
          </div>
        </div>\`;
    }).join('');
    return \`
      <div class="project">
        <div class="project-head" title="\${esc(projectFull)}">
          <span class="name">\${esc(shortName)}</span>
          <span class="path">\${divergent ? esc(divergent) : ''}</span>
          <span class="count">\${files.length}</span>
        </div>
        <div class="items">\${rows}</div>
      </div>\`;
  }).join('');
}
function commonTail(listOfSegArrays) {
  if (listOfSegArrays.length < 2) return listOfSegArrays[0] || [];
  const min = Math.min(...listOfSegArrays.map(a => a.length));
  const out = [];
  for (let i = 0; i < min; i++) {
    const seg = listOfSegArrays[0][i];
    if (listOfSegArrays.every(a => a[i] === seg)) out.push(seg);
    else break;
  }
  return out;
}
function filesSignature(files) {
  let s = '';
  for (const f of files) s += f.path + ':' + f.mtime + '|';
  return s;
}
async function refresh() {
  try {
    const r = await fetch('/api/memories');
    const data = await r.json();
    const nextSig = filesSignature(data.files);
    if (nextSig === state.filesSig) { state.files = data.files; state.projects = data.projects; return; }
    state.files = data.files;
    state.projects = data.projects;
    state.filesSig = nextSig;
    render();
  } catch {}
}
function toggleRow(row) {
  const p = row.dataset.path;
  const drawer = document.querySelector(\`.drawer[data-for="\${CSS.escape(p)}"]\`);
  if (!drawer) return;
  const opening = !state.expanded.has(p);
  if (opening) state.expanded.add(p); else state.expanded.delete(p);
  row.classList.toggle('expanded', opening);
  row.setAttribute('aria-expanded', opening ? 'true' : 'false');
  drawer.classList.toggle('open', opening);
}
document.addEventListener('click', e => {
  if (e.target.closest('a')) return;
  const row = e.target.closest('.row');
  if (row) toggleRow(row);
});
document.addEventListener('keydown', e => {
  const row = e.target.closest && e.target.closest('.row');
  if (row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggleRow(row); return; }

  const tag = document.activeElement && document.activeElement.tagName || '';
  const inField = /INPUT|TEXTAREA|SELECT/.test(tag);
  const rows = [...document.querySelectorAll('.row')];
  const focused = document.activeElement && document.activeElement.classList.contains('row')
    ? document.activeElement : null;

  if (e.key === '/' && !inField) {
    e.preventDefault();
    const s = document.getElementById('search');
    s.focus(); s.select();
    return;
  }
  if (e.key === 'Escape') {
    if (inField && document.activeElement.id === 'search') { document.activeElement.blur(); return; }
    if (focused && state.expanded.has(focused.dataset.path)) { toggleRow(focused); return; }
    return;
  }
  if (inField) return;
  if (e.key === 'j' || e.key === 'k') {
    if (!rows.length) return;
    const idx = focused ? rows.indexOf(focused) : -1;
    const next = e.key === 'j'
      ? (idx < 0 ? 0 : Math.min(rows.length - 1, idx + 1))
      : (idx < 0 ? rows.length - 1 : Math.max(0, idx - 1));
    rows[next].focus();
    rows[next].scrollIntoView({ block: 'nearest' });
    e.preventDefault();
  } else if (e.key === 'o' && focused) {
    // "o" opens selected row in Workspace
    const a = focused.nextElementSibling && focused.nextElementSibling.querySelector('.d-open');
    if (a) { e.preventDefault(); window.location.href = a.href; }
  }
});

const searchEl = document.getElementById('search');
searchEl.value = state.filters.search;
searchEl.addEventListener('input', () => { state.filters.search = searchEl.value; save(); render(); });
const idxEl = document.getElementById('show-indexes');
idxEl.checked = state.filters.showIndexes;
idxEl.addEventListener('change', () => { state.filters.showIndexes = idxEl.checked; save(); render(); });
refresh();
setInterval(() => { if (!document.hidden) refresh(); }, 5000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
</script>
</body>
</html>`;

function isLocalHost(h) {
  if (!h) return false;
  const s = String(h).toLowerCase().trim();
  // Bracketed IPv6: [::1] or [::1]:port
  if (s.startsWith('[')) {
    const end = s.indexOf(']');
    if (end < 0) return false;
    return s.slice(1, end) === '::1';
  }
  // Unbracketed IPv6 without port
  if (s === '::1') return true;
  // name or ipv4 (optionally with :port)
  const host = s.split(':')[0];
  return host === 'localhost' || host === '127.0.0.1';
}

const server = http.createServer(async (req, res) => {
  try {
    if (!isLocalHost(req.headers.host)) {
      return send(res, 403, JSON.stringify({ error: 'host not allowed' }));
    }
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname === '/') {
      return send(res, 200, OVERVIEW_HTML, 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname === '/dashboard') {
      return send(res, 200, HTML, 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname === '/overview') {
      res.writeHead(301, { Location: '/' });
      return res.end();
    }
    if (req.method === 'GET' && url.pathname === '/api/memories') {
      return send(res, 200, listMemoriesCached());
    }
    if (req.method === 'POST' && url.pathname === '/api/memory') {
      if (!ensureJson(req, res)) return;
      const body = await readBody(req);
      let parsed;
      try { parsed = JSON.parse(body); } catch { return send(res, 400, JSON.stringify({ error: 'invalid json' })); }
      const { projectEncoded, filename, frontmatter, body: memBody, updateIndex } = parsed;
      if (!projectEncoded || !filename || !frontmatter || typeof memBody !== 'string') {
        return send(res, 400, JSON.stringify({ error: 'projectEncoded, filename, frontmatter, body required' }));
      }
      if (!/^[A-Za-z0-9_\-]+\.md$/.test(filename) || filename.toLowerCase() === 'memory.md') {
        return send(res, 400, JSON.stringify({ error: 'invalid filename' }));
      }
      if (!/^[A-Za-z0-9_\-]+$/.test(projectEncoded)) {
        return send(res, 400, JSON.stringify({ error: 'invalid projectEncoded' }));
      }
      const projectDir = path.join(PROJECTS_ROOT, projectEncoded);
      const memDir = path.join(projectDir, 'memory');
      const target = path.join(memDir, filename);
      if (!fs.existsSync(projectDir)) return send(res, 404, JSON.stringify({ error: 'project not found' }));
      // Structural check before any mkdir: target must sit directly in an allowed memory dir.
      const relParts = path.relative(PROJECTS_ROOT, path.resolve(target)).split(path.sep);
      if (relParts.length !== 3 || relParts[1] !== 'memory' || !relParts[2].endsWith('.md')) {
        return send(res, 403, JSON.stringify({ error: 'path not allowed' }));
      }
      if (!fs.existsSync(memDir)) fs.mkdirSync(memDir, { recursive: true, mode: 0o700 });
      if (!isPathSafe(target)) return send(res, 403, JSON.stringify({ error: 'path not allowed' }));
      if (fs.existsSync(target)) return send(res, 409, JSON.stringify({ error: 'a memory with this name already exists' }));

      const order = ['name', 'description', 'type', 'originSessionId'];
      const validKey = k => /^[A-Za-z0-9_]+$/.test(k);
      const keys = order.filter(k => frontmatter[k] != null && frontmatter[k] !== '')
        .concat(Object.keys(frontmatter).filter(k => !order.includes(k) && validKey(k) && frontmatter[k] != null && frontmatter[k] !== ''));
      const fmLines = keys.map(k => `${k}: ${sanitizeFrontmatterValue(frontmatter[k])}`);
      const content = '---\n' + fmLines.join('\n') + '\n---\n' + (memBody.endsWith('\n') ? memBody : memBody + '\n');
      atomicWrite(target, content);

      if (updateIndex) {
        const indexPath = path.join(memDir, 'MEMORY.md');
        const title = sanitizeFrontmatterValue(frontmatter.name || filename.replace(/\.md$/, ''));
        const hook = frontmatter.description ? ` — ${sanitizeFrontmatterValue(frontmatter.description)}` : '';
        const line = `- [${title}](${filename})${hook}\n`;
        const decoded = decodeProjectName(projectEncoded);
        try {
          if (fs.existsSync(indexPath)) {
            const existing = fs.readFileSync(indexPath, 'utf8');
            atomicWrite(indexPath, existing + (existing.endsWith('\n') ? '' : '\n') + line);
          } else {
            atomicWrite(indexPath, `# ${decoded} Memory\n\n${line}`);
          }
        } catch {}
      }
      return send(res, 200, JSON.stringify({ ok: true, path: target }));
    }
    if (req.method === 'PUT' && url.pathname === '/api/memory') {
      if (!ensureJson(req, res)) return;
      const body = await readBody(req);
      let parsed;
      try { parsed = JSON.parse(body); } catch { return send(res, 400, JSON.stringify({ error: 'invalid json' })); }
      const { path: p, content, expectedMtime } = parsed;
      if (typeof p !== 'string' || typeof content !== 'string') {
        return send(res, 400, JSON.stringify({ error: 'path and content required' }));
      }
      if (!isPathSafe(p)) return send(res, 403, JSON.stringify({ error: 'path not allowed' }));
      let current;
      try { current = fs.statSync(p); }
      catch { return send(res, 404, JSON.stringify({ error: 'not found' })); }
      if (typeof expectedMtime === 'number' && Math.abs(current.mtimeMs - expectedMtime) > 1) {
        return send(res, 409, JSON.stringify({ error: 'file changed on disk', currentMtime: current.mtimeMs }));
      }
      atomicWrite(p, content);
      return send(res, 200, JSON.stringify({ ok: true }));
    }
    if (req.method === 'DELETE' && url.pathname === '/api/memory') {
      const p = url.searchParams.get('path');
      if (!p) return send(res, 400, JSON.stringify({ error: 'path required' }));
      if (!isPathSafe(p)) return send(res, 403, JSON.stringify({ error: 'path not allowed' }));
      try { fs.unlinkSync(p); listCache = { at: 0, payload: null }; }
      catch (e) { return send(res, 404, JSON.stringify({ error: e.message })); }
      return send(res, 200, JSON.stringify({ ok: true }));
    }
    send(res, 404, JSON.stringify({ error: 'not found' }));
  } catch (e) {
    send(res, 500, JSON.stringify({ error: e.message }));
  }
});

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start'
    : 'xdg-open';
  const args = process.platform === 'win32' ? ['', url] : [url];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore', shell: process.platform === 'win32' }).unref();
  } catch (e) {
    console.error(`Could not open browser: ${e.message}`);
  }
}

if (require.main === module) {
  server.listen(PORT, '127.0.0.1', () => {
    const addr = server.address();
    const port = typeof addr === 'object' ? addr.port : PORT;
    const url = `http://localhost:${port}`;
    console.log(`Claude Memory Monitor listening on ${url}`);
    console.log(`Scanning ${PROJECTS_ROOT}`);

    if (process.stdin.isTTY) {
      process.stdout.write('\nPress Enter to open in your browser (Ctrl+C to quit)…');
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', chunk => {
        if (chunk.includes('\n')) {
          openBrowser(url);
          process.stdout.write('Opened. Press Enter again to reopen.\n');
        }
      });
    }
  });
}

module.exports = {
  server,
  PROJECTS_ROOT,
  isPathSafe,
  isLocalHost,
  decodeProjectName,
  parseFrontmatter,
  sanitizeFrontmatterValue,
  atomicWrite,
  listMemories,
  listMemoriesCached,
};
