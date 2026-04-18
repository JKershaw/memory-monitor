#!/usr/bin/env node
// Spin up the server against a scratch fixture directory and capture two
// showcase screenshots. Never touches the user's real ~/.claude/projects/.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require('@playwright/test');

const ROOT = path.join(__dirname, '..');
const SCRATCH = path.join(os.tmpdir(), 'memory-monitor-showcase-' + process.pid);
const DECODE_ROOT = path.join(SCRATCH, 'fs');
const PROJECTS_ROOT = path.join(SCRATCH, 'projects');
const OUT_DIR = path.join(ROOT, 'docs', 'screenshots');
const PORT = 5587;

const DAY = 86400 * 1000;
const now = Date.now();
const ago = d => now - d * DAY;

// --- fixtures ---------------------------------------------------------------
// Project layout keyed by the virtual absolute path we want to appear in the
// UI. The encoded dir name is "-" + path.replace(/\//g, '-').slice(1).

const projects = {
  '/Users/vibe/code/orbital-dashboard': [
    {
      name: 'feedback_bundle_refactor_prs.md',
      mtime: ago(0.1),
      fm: {
        name: 'Prefer a single bundled PR for cross-cutting refactors',
        description: 'When touching more than two files across a feature area, keep it one PR',
        type: 'feedback',
      },
      body:
`When a refactor touches more than two files across a feature, ship it as one PR.

**Why:** Splitting a shared-code refactor into separate PRs creates review churn — reviewers have to reconstruct the bigger picture from fragments, and rebase conflicts multiply. We already tried this on the billing cleanup and spent more time coordinating than reviewing.

**How to apply:**
- Cross-cutting refactor (shared types, middleware, naming) → one PR.
- Genuinely independent changes that happen to live in the same branch → split.
- If the one-PR version exceeds ~500 LOC, re-evaluate; otherwise default to bundled.`,
    },
    {
      name: 'project_auth_rewrite.md',
      mtime: ago(3),
      fm: {
        name: 'Auth middleware rewrite is a compliance ticket',
        description: 'The session-token refactor is being driven by legal, not tech debt',
        type: 'project',
      },
      body:
`Auth middleware rewrite is scoped to fix how session tokens are stored, per legal review.

**Why:** Legal flagged the current storage against the updated compliance requirements in Q1. The rewrite is a compliance deliverable, not a tech-debt cleanup.

**How to apply:** Favour compliance-correct patterns over ergonomic ones when they conflict. Don't bundle unrelated niceties into this PR; keep the scope legible to the reviewer from Legal.`,
    },
    {
      name: 'reference_grafana_dashboard.md',
      mtime: ago(12),
      fm: {
        name: 'API latency dashboard is the oncall pager',
        description: 'Touch request-path code → check this before merging',
        type: 'reference',
      },
      body:
`The on-call latency dashboard lives at grafana.internal/d/api-latency. It's what the pager watches for request-handling regressions.

Check it before merging anything that touches routing, middleware, or handler hot paths.`,
    },
    {
      name: 'MEMORY.md',
      mtime: ago(18),
      isIndex: true,
      raw:
`# Orbital Dashboard

- [bundled refactors](feedback_bundle_refactor_prs.md) — one PR for cross-cutting changes
- [auth rewrite](project_auth_rewrite.md) — compliance, not tech-debt
- [latency dashboard](reference_grafana_dashboard.md) — the oncall pager
`,
    },
  ],

  '/Users/vibe/code/invoice-engine': [
    {
      name: 'feedback_no_mock_db.md',
      mtime: ago(0.5),
      fm: {
        name: 'Integration tests hit a real database, never mocks',
        description: 'Past incident: mock passed, prod migration broke',
        type: 'feedback',
      },
      body:
`Integration tests must run against a real database — never mock the DB layer.

**Why:** Q4 we shipped a migration that passed every mocked test and broke in prod because the mock didn't enforce a NOT NULL constraint. We've since standardised on a docker-compose Postgres for test runs.

**How to apply:**
- \`npm run test:integration\` spins up the container automatically.
- If a test is slow because of DB I/O, make the test smaller — do not reach for a mock.
- Unit tests for pure functions can still mock freely.`,
    },
    {
      name: 'feedback_scoped_tests.md',
      mtime: ago(2),
      fm: {
        name: 'Scope test runs to the service being changed',
        description: 'npm test full suite only when shared code is touched',
        type: 'feedback',
      },
      body:
`Run only the service's test suite before committing, not the full \`npm test\`.

**Why:** Full-suite runs take 8+ minutes and are wasteful when the change is contained. We already have a CI job for the full suite.

**How to apply:**
- Changes under \`services/invoicing/\` → \`npm run test:invoicing\`
- Changes under \`services/admin/\` → \`npm run test:admin\`
- Shared code in \`lib/\` → \`npm test\`
- Always run \`npm run check\` (tsc + eslint) regardless.`,
    },
    {
      name: 'project_gql_migration.md',
      mtime: ago(9),
      fm: {
        name: 'GraphQL migration scheduled for Q3',
        description: 'Don\'t entrench REST patterns in new work',
        type: 'project',
      },
      body:
`We're migrating the public API from REST to GraphQL in Q3. Planning happens in Linear project INV-GQL.

Don't entrench new REST patterns that will need undoing. If you're adding an endpoint, check with @mara first — she's tracking which surfaces are in-scope for the migration.`,
    },
  ],

  '/Users/vibe/code/notes-sync': [
    {
      name: 'user_concise_commits.md',
      mtime: ago(6),
      fm: {
        name: 'Prefers concise commit messages',
        description: 'One-line subject; no "why" paragraph unless truly non-obvious',
        type: 'user',
      },
      body:
`Keep commits to a single one-line subject. No body paragraph unless the change is genuinely non-obvious — the PR description is the right place for that context, not the commit.`,
    },
    {
      name: 'reference_linear_ingest.md',
      mtime: ago(20),
      fm: {
        name: 'Pipeline bugs tracked in Linear project INGEST',
        description: 'Where to look for known issues in the sync worker',
        type: 'reference',
      },
      body:
`Known pipeline bugs and in-flight work live in the Linear project \`INGEST\`. Before filing a new ticket, search there — there's a decent chance someone's already seen it.`,
    },
  ],

  '/Users/vibe/code/claude-agents': [
    {
      name: 'user_typescript_senior.md',
      mtime: ago(0.3),
      fm: {
        name: 'Senior TypeScript developer, ~8 years',
        description: 'Tailor explanations accordingly; skip JS fundamentals',
        type: 'user',
      },
      body:
`Background: ~8 years of TypeScript, previously Go. Comfortable with advanced type-system features (conditional types, template-literal types, infer). Skip explanations of JS fundamentals.

New to: Rust, async runtime internals. Frame Rust explanations via Go analogues where possible.`,
    },
    {
      name: 'feedback_flag_cicd_changes.md',
      mtime: ago(4),
      fm: {
        name: 'Flag any CI/CD config changes explicitly before merging',
        description: 'Pipeline changes have bitten us; always surface them',
        type: 'feedback',
      },
      body:
`Call out CI/CD config changes explicitly in the PR description, even small ones.

**Why:** A one-line change to the deploy workflow broke staging for a day and nobody noticed until the morning standup, because the diff was buried at the bottom of an otherwise-normal feature PR.

**How to apply:** If the PR touches \`.github/workflows/\`, \`Dockerfile\`, \`Procfile\`, or any pipeline config, put a "**CI change:**" line at the top of the description summarising what it does.`,
    },
    {
      name: 'project_v2_release.md',
      mtime: ago(45),
      fm: {
        name: 'v2 release cut targeted for end of Q2',
        description: 'Feature freeze two weeks prior; bugfixes only after',
        type: 'project',
      },
      body:
`v2 release branch cuts end of Q2. Feature freeze starts two weeks before that — bugfixes only after the freeze.

Large refactors that miss the freeze land on main and ship in v2.1.`,
    },
  ],
};

// --- helpers ----------------------------------------------------------------

function encodeProjectPath(virtualPath) {
  return '-' + virtualPath.replace(/^\//, '').replace(/\//g, '-');
}

function writeFixtures() {
  for (const [virtualPath, memories] of Object.entries(projects)) {
    // The decoded project dir must exist under DECODE_ROOT so decodeProjectName
    // walks it successfully.
    fs.mkdirSync(path.join(DECODE_ROOT, virtualPath), { recursive: true });

    const encoded = encodeProjectPath(virtualPath);
    const memDir = path.join(PROJECTS_ROOT, encoded, 'memory');
    fs.mkdirSync(memDir, { recursive: true });

    for (const m of memories) {
      const filePath = path.join(memDir, m.name);
      let content;
      if (m.raw) {
        content = m.raw;
      } else {
        const order = ['name', 'description', 'type'];
        const lines = order.filter(k => m.fm[k]).map(k => `${k}: ${m.fm[k]}`);
        content = '---\n' + lines.join('\n') + '\n---\n' + m.body + '\n';
      }
      fs.writeFileSync(filePath, content, 'utf8');
      // Stable mtime keeps the Recent sort deterministic.
      fs.utimesSync(filePath, m.mtime / 1000, m.mtime / 1000);
    }
  }
}

function cleanup() {
  try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch {}
}

async function startServer() {
  const proc = spawn('node', [path.join(ROOT, 'server.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      CLAUDE_PROJECTS_ROOT: PROJECTS_ROOT,
      CLAUDE_DECODE_ROOT: DECODE_ROOT,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    let buf = '';
    const t = setTimeout(() => reject(new Error('server start timeout')), 5000);
    proc.stdout.on('data', d => {
      buf += d.toString();
      if (/listening on/.test(buf)) { clearTimeout(t); resolve(); }
    });
    proc.on('error', reject);
  });
  return proc;
}

// --- run --------------------------------------------------------------------

(async () => {
  cleanup();
  writeFixtures();
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const serverProc = await startServer();
  const browser = await chromium.launch();
  let failed = false;

  try {
    // ---------- Browse ---------------------------------------------------
    // Content column is 1012px wide (56 padding + 900 max + 56 padding).
    // Viewport of 1020 trims the right-hand whitespace tight to the content.
    const browseContext = await browser.newContext({
      viewport: { width: 1020, height: 800 },
      deviceScaleFactor: 2,
    });
    const browse = await browseContext.newPage();
    await browse.goto(`http://localhost:${PORT}/`);
    await browse.locator('.row').first().waitFor({ timeout: 8000 });

    const showcase = browse.locator('.row', { hasText: 'Prefer a single bundled PR' });
    await showcase.click();
    await browse.locator('.drawer.open').first().waitFor();
    await browse.waitForTimeout(400);

    await browse.screenshot({
      path: path.join(OUT_DIR, 'browse.png'),
      fullPage: true,
    });
    await browseContext.close();
    console.log('wrote browse.png');

    // ---------- Workspace ------------------------------------------------
    // Sidebar 340 + detail (28 pad + 680 max + 28 pad) = 1076. Viewport 1080.
    const wsContext = await browser.newContext({
      viewport: { width: 1080, height: 740 },
      deviceScaleFactor: 2,
    });
    const ws = await wsContext.newPage();
    await ws.goto(`http://localhost:${PORT}/dashboard`);
    await ws.locator('.item').first().waitFor({ timeout: 8000 });

    await ws.locator('.item', { hasText: 'Integration tests hit a real database' }).click();
    await ws.locator('.d-title').waitFor();
    await ws.waitForTimeout(200);

    await ws.screenshot({
      path: path.join(OUT_DIR, 'workspace.png'),
      fullPage: false,
    });
    await wsContext.close();
    console.log('wrote workspace.png');
  } catch (e) {
    failed = true;
    console.error('screenshot run failed:', e.message);
  } finally {
    await browser.close();
    serverProc.kill('SIGTERM');
    cleanup();
  }

  process.exit(failed ? 1 : 0);
})();
