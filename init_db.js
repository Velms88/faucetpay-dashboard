const fs = require('fs');
const path = require('path');
const { createClient } = require('@libsql/client');

// ---------------------------------------------------------------------------
// 1. Read Turso credentials from Turso_DB_Connection.md
// ---------------------------------------------------------------------------
function readCredentials() {
  const md = fs.readFileSync(path.join(__dirname, 'Turso_DB_Connection.md'), 'utf8');
  const urlM = md.match(/URL:\s*(https?:\/\/\S+)/i) || md.match(/(https?:\/\/[\w.-]+\.turso\.io)/i);
  const tokenM = md.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
  if (!urlM || !tokenM) {
    throw new Error('Could not parse TURSO_DB_URL / TURSO_AUTH_TOKEN from Turso_DB_Connection.md');
  }
  return { url: urlM[1], authToken: tokenM[0] };
}

const { url, authToken } = readCredentials();
console.log('Connecting to Turso:', url);

const client = createClient({ url, authToken });

// ---------------------------------------------------------------------------
// 2. Schema
// ---------------------------------------------------------------------------
const SCHEMA = `
CREATE TABLE IF NOT EXISTS configs (
  mode TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS faucets (
  id TEXT,
  mode TEXT DEFAULT 'prod',
  name TEXT,
  url TEXT,
  owner_id TEXT,
  owner_name TEXT,
  currency TEXT,
  timer_in_minutes TEXT,
  reward TEXT,
  is_enabled TEXT,
  creation_date TEXT,
  category TEXT,
  categories TEXT,
  paid_today TEXT,
  total_users_paid TEXT,
  active_users TEXT,
  balance TEXT,
  health TEXT,
  health_score TEXT,
  rating TEXT,
  rating_grade TEXT,
  raw_json TEXT,
  updated_at TEXT,
  PRIMARY KEY (id, mode)
);

CREATE TABLE IF NOT EXISTS history_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL,
  currency TEXT,
  snapshot_at TEXT,
  balance REAL,
  daily_peak REAL,
  meta_json TEXT,
  coin_json TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_history_url ON history_logs(url);
CREATE INDEX IF NOT EXISTS idx_history_url_cur ON history_logs(url, currency);

CREATE TABLE IF NOT EXISTS history_faucets (
  url TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at TEXT
);
`;

function extractFaucetRows(json) {
  const rows = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (typeof n.name === 'string' && typeof n.url === 'string') { rows.push(n); return; }
    for (const k of Object.keys(n)) walk(n[k]);
  };
  walk(json.data.list_data);
  return rows;
}

async function main() {
  // Create schema (run each statement separately)
  for (const stmt of SCHEMA.split(';').map((s) => s.trim()).filter(Boolean)) {
    await client.execute(stmt);
  }
  try {
    await client.execute('ALTER TABLE history_logs ADD COLUMN coin_json TEXT');
  } catch (e) {
    /* column already exists */
  }
  console.log('[schema] tables created (configs, faucets, history_logs)');

  const now = new Date().toISOString();

  // ---- 3a. Configs (prod + sandbox) ----
  const cfgProd = JSON.parse(fs.readFileSync(path.join(__dirname, 'faucet_config.json'), 'utf8'));
  const cfgSandbox = JSON.parse(fs.readFileSync(path.join(__dirname, 'faucet_config.sandbox.json'), 'utf8'));
  await client.batch([
    { sql: 'INSERT OR REPLACE INTO configs (mode, data, updated_at) VALUES (?, ?, ?)', args: ['prod', JSON.stringify(cfgProd), now] },
    { sql: 'INSERT OR REPLACE INTO configs (mode, data, updated_at) VALUES (?, ?, ?)', args: ['sandbox', JSON.stringify(cfgSandbox), now] },
  ], 'write');
  console.log('[migrate] configs: prod + sandbox inserted (2)');

  // ---- 3b. Faucets from faucets.json ----
  const fj = JSON.parse(fs.readFileSync(path.join(__dirname, 'faucets.json'), 'utf8'));
  const faucets = extractFaucetRows(fj);
  const faucetStmts = faucets.map((r) => ({
    sql: `INSERT OR REPLACE INTO faucets
      (id, mode, name, url, owner_id, owner_name, currency, timer_in_minutes, reward,
       is_enabled, creation_date, category, categories, paid_today, total_users_paid,
       active_users, balance, health, health_score, rating, rating_grade, raw_json, updated_at)
      VALUES (?, 'prod', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      String(r.id ?? ''), r.name ?? '', r.url ?? '', r.owner_id ?? '', r.owner_name ?? '',
      r.currency ?? '', r.timer_in_minutes ?? '', r.reward ?? '', r.is_enabled ?? '',
      r.creation_date ?? '', r.category ?? '', JSON.stringify(r.categories ?? null),
      r.paid_today ?? '', r.total_users_paid ?? '', r.active_users ?? '', r.balance ?? '',
      r.health ?? '', r.health_score ?? null, r.rating ?? null, r.rating_grade ?? '',
      JSON.stringify(r), now,
    ],
  }));
  await client.batch(faucetStmts, 'write');
  console.log(`[migrate] faucets: inserted ${faucetStmts.length}`);

  // ---- 3c. History logs from history.json ----
  const hj = JSON.parse(fs.readFileSync(path.join(__dirname, 'history.json'), 'utf8'));
  const snapAt = hj.updated_at || now;
  // Clear previous rows so re-running the migration is idempotent (no append dupes).
  await client.execute('DELETE FROM history_logs');
  const histStmts = [];
  for (const f of (hj.faucets || [])) {
    const meta = {
      is_enabled: f.is_enabled, age_months: f.age_months, payout_type: f.payout_type,
      gateways_count: f.gateways_count, uii: f.uii,
      payouts: f.payouts, daily_health_medians_7d: f.daily_health_medians_7d, _tracking: f._tracking,
    };
    const coins = f.coins || {};
    for (const cur of Object.keys(coins)) {
      const c = coins[cur];
      const peaks = (c.daily_peaks || []).filter((x) => x != null);
      const recents = (c.recent_balances || []).filter((x) => x != null);
      const balance = recents.length ? Number(recents[recents.length - 1]) : null;
      const dailyPeak = peaks.length ? Number(peaks[peaks.length - 1]) : null;
      histStmts.push({
        sql: `INSERT INTO history_logs (url, currency, snapshot_at, balance, daily_peak, meta_json, coin_json)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [f.url ?? '', cur, snapAt, balance, dailyPeak, JSON.stringify(meta), JSON.stringify(c)],
      });
    }
  }
  await client.batch(histStmts, 'write');
  console.log(`[migrate] history_logs: inserted ${histStmts.length} (from ${(hj.faucets || []).length} faucets)`);

  // ---- 3d. Per-faucet full history objects (for the frontend to read via SELECT) ----
  const hfStmts = [];
  for (const f of (hj.faucets || [])) {
    hfStmts.push({
      sql: `INSERT OR REPLACE INTO history_faucets (url, data, updated_at) VALUES (?, ?, ?)`,
      args: [String(f.url ?? ''), JSON.stringify(f), snapAt],
    });
  }
  await client.batch(hfStmts, 'write');
  console.log(`[migrate] history_faucets: inserted ${hfStmts.length} (from ${(hj.faucets || []).length} faucets)`);

  // ---- Report ----
  const count = async (t) => Number((await client.execute(`SELECT COUNT(*) AS c FROM ${t}`)).rows[0].c);
  const sampleFaucet = await client.execute("SELECT id, name, currency, balance FROM faucets WHERE id = '199'");
  const sampleHist = await client.execute('SELECT url, currency, balance, daily_peak FROM history_logs LIMIT 1');

  console.log('\n==================== MIGRATION REPORT ====================');
  console.log('configs        :', await count('configs'), 'rows (prod, sandbox)');
  console.log('faucets        :', await count('faucets'), 'rows');
  console.log('history_logs   :', await count('history_logs'), 'rows');
  console.log('----------------------------------------------------------');
  if (sampleFaucet.rows[0]) {
    const s = sampleFaucet.rows[0];
    console.log('sample faucet  :', s.id, s.name, '(' + s.currency + ')', 'balance=', s.balance);
  }
  if (sampleHist.rows[0]) {
    const s = sampleHist.rows[0];
    console.log('sample history :', s.url, s.currency, 'balance=', s.balance, 'peak=', s.daily_peak);
  }
  console.log('==========================================================');

  await client.close();
}

main().catch((e) => {
  console.error('MIGRATION FAILED:', e);
  process.exit(1);
});
