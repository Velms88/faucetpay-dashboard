const fs = require('fs');
const path = require('path');
const { createClient } = require('@libsql/client');

const CONFIG_FILE = path.join(__dirname, 'faucet_config.json');
const HISTORY_FILE = path.join(__dirname, 'history.json');

function parseArgs() {
  const out = {};
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    const arg = a[i];
    if (arg.indexOf('--') !== 0) continue;
    let key = arg.slice(2);
    let value = true;
    const eq = key.indexOf('=');
    if (eq !== -1) {
      value = key.slice(eq + 1);
      key = key.slice(0, eq);
    } else {
      const next = a[i + 1];
      if (next !== undefined && next.indexOf('--') !== 0) {
        value = a[++i];
      }
    }
    out[key] = value;
  }
  return out;
}

function normalizeUrl(u) {
  return String(u || '')
    .trim()
    .toLowerCase()
    .replace(/\/+$/, '');
}

function round(value, decimals) {
  const p = Math.pow(10, decimals);
  return Math.round((value + Number.EPSILON) * p) / p;
}

function median(values) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  const nums = values.map(Number).filter((v) => !isNaN(v));
  if (nums.length === 0) return 0;
  nums.sort((a, b) => a - b);
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 === 0 ? (nums[mid - 1] + nums[mid]) / 2 : nums[mid];
}

function sum(values) {
  return values.reduce((acc, v) => acc + (Number(v) || 0), 0);
}

function dayKey(tsMs) {
  return new Date(tsMs).toISOString().slice(0, 10);
}

function walkRecords(node, callback) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.name === 'string' && typeof node.url === 'string') {
    callback(node);
    return;
  }
  for (const key of Object.keys(node)) {
    walkRecords(node[key], callback);
  }
}

function collectFreshByUrl(listData) {
  const byUrl = new Map();
  walkRecords(listData, (rec) => {
    const url = normalizeUrl(rec.url) || String(rec.name || '').trim().toLowerCase();
    if (!url) return;
    let entry = byUrl.get(url);
    if (!entry) {
      entry = {
        url: rec.url,
        is_enabled: rec.is_enabled === '1' || rec.is_enabled === 1 || rec.is_enabled === true,
        creation_date: Number(rec.creation_date) || 0,
        coins: {},
      };
      byUrl.set(url, entry);
    }
    if (rec.is_enabled === '0' || rec.is_enabled === 0 || rec.is_enabled === false) {
      entry.is_enabled = false;
    }
    const coin = String(rec.currency || '').toUpperCase();
    const balance = Number(rec.balance);
    const paidToday = Number(rec.paid_today);
    const health = rec.health !== undefined ? Number(rec.health) : null;
    const totalPaid = rec.total_users_paid !== undefined ? Number(rec.total_users_paid) : 0;
    entry.coins[coin] = {
      balance: isFinite(balance) ? balance : 0,
      paid_today: isFinite(paidToday) ? paidToday : 0,
      health: isFinite(health) ? health : null,
      total_users_paid: isFinite(totalPaid) ? totalPaid : 0,
    };
  });
  return byUrl;
}

// Build full raw hourly snapshots (ALL coins returned by the API, including
// zero-balance ones) plus the crypto rates used at snapshot time. These power
// the "Сырые данные API" tab in Real Mode admin and are stored in raw_hourly.
function buildRawSnapshots(freshByUrl, prices, nowTs) {
  const snapAt = new Date(nowTs).toISOString();
  const day = dayKey(nowTs);
  const rows = [];
  for (const [key, entry] of freshByUrl.entries()) {
    const coins = [];
    for (const sym of Object.keys(entry.coins)) {
      const c = entry.coins[sym];
      coins.push({
        symbol: sym,
        balance: c.balance,
        paid_today: c.paid_today,
        total_users_paid: c.total_users_paid,
        health: c.health,
      });
    }
    rows.push({
      url: normalizeUrl(entry.url || key),
      snapshot_at: snapAt,
      day: day,
      coins_json: JSON.stringify(coins),
      prices_json: JSON.stringify(prices || {}),
    });
  }
  return rows;
}

async function writeRawToTurso(client, rows) {
  if (!rows || !rows.length) return 0;
  // Keep only the last 8 days of raw hourly snapshots so the table never grows
  // unbounded (the 7-day calculation window always has fresh data). The cleanup
  // runs as the FIRST statement in the SAME batch as the new inserts, so it is a
  // single pipeline request to the DB and there is no extra HTTP round-trip.
  const cutoff = new Date(Date.now() - 8 * 86400e3).toISOString().slice(0, 10);
  const deleteStmt = {
    sql: `DELETE FROM raw_hourly WHERE day < ?`,
    args: [cutoff],
  };
  const insertStmts = rows.map((r) => ({
    sql: `INSERT INTO raw_hourly (url, snapshot_at, day, coins_json, prices_json) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(url, snapshot_at) DO UPDATE SET day=excluded.day, coins_json=excluded.coins_json, prices_json=excluded.prices_json`,
    args: [r.url, r.snapshot_at, r.day, r.coins_json, r.prices_json],
  }));
  await client.batch([deleteStmt, ...insertStmts], 'write');
  console.log('[INFO] Cleared history snapshots older than 8 days.');
  return insertStmts.length;
}

function ageFromCreation(creationDate, nowTs) {
  if (!creationDate || creationDate <= 0) return 0;
  const months = (nowTs - creationDate * 1000) / (30.44 * 24 * 3600 * 1000);
  return Math.max(0, Math.floor(months));
}

function createHistoryEntry(url) {
  return {
    url,
    coins: {},
    payouts: {
      hours_since_last_payout: null,
      v_3h_actual: 0,
      v_3h_expected_median: 0,
      n_3h_actual: 0,
      n_3h_expected_median: 0,
      daily_volume_usd_7d_medians: [],
    },
    daily_health_medians_7d: [],
    _tracking: { coins: {}, payouts: {}, hourly: [] },
  };
}

function derivePayouts(entry, hourly, nowTs) {
  const cur = hourly.slice(-3);
  const prev = hourly.slice(0, Math.max(0, hourly.length - 3));

  const v3h = round(sum(cur.map((x) => x.usd)), 2);
  const n3h = sum(cur.map((x) => x.n));
  const vExp = round(median(prev.map((x) => x.usd)), 2);
  const nExp = round(median(prev.map((x) => x.n)), 1);

  let lastPayoutHour = null;
  for (let i = hourly.length - 1; i >= 0; i--) {
    if (hourly[i].usd > 0 || hourly[i].n > 0) {
      lastPayoutHour = hourly[i].h;
      break;
    }
  }
  const nowHour = Math.floor(nowTs / 3600e3);
  const hoursSince = lastPayoutHour !== null ? Math.max(0, nowHour - lastPayoutHour) : null;

  const byDay = new Map();
  for (const x of hourly) {
    const d = dayKey(x.h * 3600e3);
    byDay.set(d, (byDay.get(d) || 0) + (x.usd || 0));
  }
  const days = Array.from(byDay.entries())
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .slice(-7)
    .map((e) => round(e[1], 2));

  entry.payouts = {
    hours_since_last_payout: hoursSince,
    v_3h_actual: v3h,
    v_3h_expected_median: vExp,
    n_3h_actual: n3h,
    n_3h_expected_median: nExp,
    daily_volume_usd_7d_medians: days,
  };
}

function deriveDailyHealth(entry, hourly) {
  const byDay = new Map();
  for (const x of hourly) {
    if (x.health === null || x.health === undefined) continue;
    const d = dayKey(x.h * 3600e3);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(x.health);
  }
  const days = Array.from(byDay.entries())
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .slice(-7)
    .map((e) => round(median(e[1]), 2));
  entry.daily_health_medians_7d = days;
}

function applySnapshot(entry, fresh, prices, target, retention, nowTs) {
  const nowDay = dayKey(nowTs);
  const nowHour = Math.floor(nowTs / 3600e3);

  entry.url = fresh.url;

  if (!entry._tracking) entry._tracking = { coins: {}, payouts: {}, hourly: [] };
  const tracking = entry._tracking;
  if (!tracking.coins) tracking.coins = {};
  if (!tracking.payouts) tracking.payouts = {};
  if (!Array.isArray(tracking.hourly)) tracking.hourly = [];

  for (const coin of Object.keys(fresh.coins)) {
    const balance = fresh.coins[coin].balance;
    const c = entry.coins[coin] || (entry.coins[coin] = { daily_peaks: [], recent_balances: [] });
    const tk = tracking.coins[coin] || (tracking.coins[coin] = { day: null, peak: 0 });

    c.recent_balances.push(balance);
    if (c.recent_balances.length > 3) c.recent_balances = c.recent_balances.slice(-3);

    if (tk.day === nowDay) {
      tk.peak = Math.max(tk.peak, balance);
    } else {
      c.daily_peaks.push(balance);
      tk.day = nowDay;
      tk.peak = balance;
    }
    c.daily_peaks[c.daily_peaks.length - 1] = tk.peak;
    if (c.daily_peaks.length > retention) c.daily_peaks = c.daily_peaks.slice(-retention);
  }

  let usdTotal = 0;
  let nTotal = 0;
  const healthValues = [];
  for (const coin of Object.keys(fresh.coins)) {
    const f = fresh.coins[coin];
    const price = Number(prices[coin]) || 0;
    usdTotal += f.paid_today * price;
    nTotal += f.total_users_paid;
    if (f.health !== null) healthValues.push(f.health);
  }
  const healthNow = healthValues.length ? median(healthValues) : null;

  const pd = tracking.payouts;
  const haveBaseline = pd.last_day !== undefined && pd.last_day !== null;
  let usdDelta;
  let nDelta;
  if (haveBaseline && pd.last_day === nowDay) {
    usdDelta = Math.max(0, usdTotal - (pd.last_usd_total || 0));
    nDelta = Math.max(0, nTotal - (pd.last_n_total || 0));
  } else if (haveBaseline) {
    usdDelta = Math.max(0, usdTotal);
    nDelta = Math.max(0, nTotal - (pd.last_n_total || 0));
  } else {
    usdDelta = Math.max(0, usdTotal);
    nDelta = 0;
  }

  const last = tracking.hourly[tracking.hourly.length - 1];
  if (last && last.h === nowHour) {
    last.usd = usdDelta;
    last.n = nDelta;
    last.health = healthNow;
  } else {
    tracking.hourly.push({ h: nowHour, usd: usdDelta, n: nDelta, health: healthNow });
  }
  if (tracking.hourly.length > retention * 24) {
    tracking.hourly = tracking.hourly.slice(-(retention * 24));
  }

  pd.last_day = nowDay;
  pd.last_usd_total = usdTotal;
  pd.last_n_total = nTotal;

  derivePayouts(entry, tracking.hourly, nowTs);
  deriveDailyHealth(entry, tracking.hourly);
}

function updateHistory(freshByUrl, history, config, overridesMap, nowTs) {
  const retention = config.settings.history_retention_days || 7;
  const prices = Object.assign({}, config.crypto_prices_usd || {}, history.crypto_prices_usd || {});
  history.crypto_prices_usd = prices;
  history.retention_days = retention;
  history.updated_at = new Date(nowTs).toISOString();

  let faucets = Array.isArray(history.faucets) ? history.faucets : [];
  const existing = new Map();
  const kept = [];
  for (const f of faucets) {
    const key = normalizeUrl(f.url);
    if (key) { existing.set(key, f); kept.push(f); }
  }
  faucets = kept;

  let updated = 0;
  for (const url of freshByUrl.keys()) {
    const fresh = freshByUrl.get(url);
    if (!fresh) continue;
    let entry = existing.get(url);
    if (!entry) {
      entry = createHistoryEntry(url);
      faucets.push(entry);
    }
    const override = overridesMap ? (overridesMap.get(url) || null) : null;
    applySnapshot(entry, fresh, prices, override, retention, nowTs);
    updated++;
  }

  faucets.sort((a, b) => (a.url < b.url ? -1 : 1));
  history.faucets = faucets;
  return { updated };
}

function enrichFaucets(raw, history, config, overridesMap) {
  const prices = history.crypto_prices_usd || {};
  const overrideByUrl = overridesMap || new Map();
  const historyByUrl = new Map();
  for (const f of history.faucets || []) {
    historyByUrl.set(normalizeUrl(f.url), f);
  }

  const healthScore = require('./healthScore.js');
  const ratingCalculator = require('./ratingCalculator.js');

  const mergeModeration = (historyEntry, target) => {
    const out = Object.assign({}, historyEntry);
    if (target) {
      const fields = ['is_enabled', 'age_months', 'payout_type', 'gateways_count', 'uii', 'label'];
      for (const f of fields) {
        if (target[f] !== undefined) out[f] = target[f];
      }
    }
    return out;
  };

  let enriched = 0;
  let skipped = 0;

  const payload = raw.data && typeof raw.data === 'object' ? raw.data : raw;
  const listData = payload.list_data;

  if (listData && typeof listData === 'object') {
    walkRecords(listData, (faucet) => {
      const key = normalizeUrl(faucet.url) || String(faucet.name || '').trim().toLowerCase();
      const historyEntry = historyByUrl.get(key);

      if (!historyEntry) {
        faucet.health_score = null;
        faucet.rating = null;
        faucet.rating_grade = null;
        skipped++;
        return;
      }

      const faucetData = mergeModeration(historyEntry, overrideByUrl.get(key));
      const healthResult = healthScore.calculateHealthScore(faucetData, prices, config);
      const ratingResult = ratingCalculator.calculateRating(faucetData, healthResult, config);

      faucet.health_score = healthResult.health_score;
      faucet.health_breakdown = healthResult;
      faucet.rating = ratingResult.final_rating;
      faucet.rating_grade = ratingResult.letter_grade;
      faucet.rating_breakdown = ratingResult;
      enriched++;
    });
  }

  return { enriched, skipped };
}

const MODE_PROD = 'prod';
const MODE_SANDBOX = 'sandbox';
const PROD_FILE_NAMES = ['faucet_config.json', 'history.json', 'faucets.json'];

function resolveMode(argv) {
  let mode = String(argv.mode || MODE_PROD).toLowerCase();
  if (argv['dry-run'] !== undefined && argv['dry-run'] !== false) mode = MODE_SANDBOX;
  if (mode !== MODE_PROD && mode !== MODE_SANDBOX) {
    console.error('unknown mode: ' + mode + ' (expected "prod" or "sandbox")');
    process.exit(1);
  }
  return mode;
}

function assertNotProd(mode, files) {
  if (mode !== MODE_SANDBOX) return;
  for (const file of files) {
    if (!file) continue;
    if (PROD_FILE_NAMES.includes(path.basename(file))) {
      console.error('sandbox mode refuses to touch production file: ' + file);
      process.exit(1);
    }
  }
}

function validateEngineConfig(config) {
  const required = ['rating', 'rating_thresholds', 'targets', 'crypto_prices_usd', 'settings'];
  const missing = required.filter((k) => config[k] === undefined || config[k] === null);
  if (missing.length) {
    console.warn('[compat] WARN: config misses keys ' + missing.join(', ') + ' — engine will use its hardcoded fallbacks for these.');
  }
  const rating = config.rating || {};
  const ratingSub = ['block_weights', 'uii', 'daily_volume_usd', 'rvi', 'health_score', 'payout_activity_hours', 'rai', 'age_months', 'payout_type', 'gateways_count'];
  const ratingMissing = ratingSub.filter((k) => rating[k] === undefined || rating[k] === null);
  if (ratingMissing.length) {
    console.warn('[compat] WARN: config.rating misses keys ' + ratingMissing.join(', ') + ' — engine will use hardcoded fallbacks.');
  }
  if (missing.length === 0 && ratingMissing.length === 0) {
    console.log('[compat] config schema OK — engine will use config params (no hardcoded fallbacks).');
  }
}

// ---------------------------------------------------------------------------
// Turso (cloud DB) helpers — additive mirror of the JSON artifacts.
// The static site (GitHub Pages) reads the committed faucets.json/history.json
// directly, and the browser cannot reach Turso without exposing the auth token,
// so we KEEP writing those files. Turso is an additional cloud copy. Switching
// the site's delivery to Turso is a separate, later step.
// ---------------------------------------------------------------------------
function getTursoCredentials() {
  const url = process.env.TURSO_DATABASE_URL || process.env.TURSO_URL;
  const token = process.env.TURSO_AUTH_TOKEN || process.env.TURSO_TOKEN;
  if (url && token) return { url, authToken: token };
  const mdPath = path.join(__dirname, 'Turso_DB_Connection.md');
  if (fs.existsSync(mdPath)) {
    const md = fs.readFileSync(mdPath, 'utf8');
    const urlM = md.match(/URL:\s*(https?:\/\/\S+)/i) || md.match(/(https?:\/\/[\w.-]+\.turso\.io)/i);
    const tokenM = md.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
    if (urlM && tokenM) return { url: urlM[1], authToken: tokenM[0] };
  }
  return null;
}

let _tursoClient = null;
function getTursoClient() {
  if (_tursoClient) return _tursoClient;
  const creds = getTursoCredentials();
  if (!creds) return null;
  _tursoClient = createClient({ url: creds.url, authToken: creds.authToken });
  return _tursoClient;
}

async function ensureTursoSchema(client) {
  await client.execute(
    `CREATE TABLE IF NOT EXISTS configs (mode TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT)`
  );
  await client.execute(
    `CREATE TABLE IF NOT EXISTS faucets (id TEXT, mode TEXT DEFAULT 'prod', name TEXT, url TEXT, owner_id TEXT, owner_name TEXT, currency TEXT, timer_in_minutes TEXT, reward TEXT, is_enabled TEXT, creation_date TEXT, category TEXT, categories TEXT, paid_today TEXT, total_users_paid TEXT, active_users TEXT, balance TEXT, health TEXT, health_score TEXT, rating TEXT, rating_grade TEXT, raw_json TEXT, updated_at TEXT, PRIMARY KEY (id, mode))`
  );
  await client.execute(
    `CREATE TABLE IF NOT EXISTS history_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT NOT NULL, currency TEXT, snapshot_at TEXT, balance REAL, daily_peak REAL, meta_json TEXT, coin_json TEXT, created_at TEXT DEFAULT (datetime('now')))`,
  );
  try {
    await client.execute(`ALTER TABLE history_logs ADD COLUMN coin_json TEXT`);
  } catch (e) {
    /* column already exists */
  }
  await client.execute(`CREATE INDEX IF NOT EXISTS idx_history_url ON history_logs(url)`);
  await client.execute(`CREATE INDEX IF NOT EXISTS idx_history_url_cur ON history_logs(url, currency)`);
  await client.execute(
    `CREATE TABLE IF NOT EXISTS history_faucets (url TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT)`
  );
  await client.execute(
    `CREATE TABLE IF NOT EXISTS raw_hourly (
      url TEXT NOT NULL,
      snapshot_at TEXT NOT NULL,
      day TEXT NOT NULL,
      coins_json TEXT NOT NULL,
      prices_json TEXT NOT NULL,
      PRIMARY KEY (url, snapshot_at)
    )`
  );
  await client.execute(`CREATE INDEX IF NOT EXISTS idx_raw_url_day ON raw_hourly(url, day)`);
}

function faucetIdFromRec(rec) {
  const id = String(rec.id != null ? rec.id : '').trim();
  if (id) return id;
  return normalizeUrl(rec.url) + '|' + String(rec.currency || '').toUpperCase();
}

async function writeFaucetsToTurso(client, mode, raw) {
  const payload = raw.data && typeof raw.data === 'object' ? raw.data : raw;
  const now = new Date().toISOString();
  const seen = new Set();
  const stmts = [];
  walkRecords(payload.list_data, (r) => {
    const id = faucetIdFromRec(r);
    const key = id + '|' + mode;
    if (seen.has(key)) return;
    seen.add(key);
    stmts.push({
      sql: `INSERT INTO faucets (id, mode, name, url, owner_id, owner_name, currency, timer_in_minutes, reward, is_enabled, creation_date, category, categories, paid_today, total_users_paid, active_users, balance, health, health_score, rating, rating_grade, raw_json, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id, mode) DO UPDATE SET
              name=excluded.name, url=excluded.url, owner_id=excluded.owner_id, owner_name=excluded.owner_name,
              currency=excluded.currency, timer_in_minutes=excluded.timer_in_minutes, reward=excluded.reward,
              is_enabled=excluded.is_enabled, creation_date=excluded.creation_date, category=excluded.category,
              categories=excluded.categories, paid_today=excluded.paid_today, total_users_paid=excluded.total_users_paid,
              active_users=excluded.active_users, balance=excluded.balance, health=excluded.health,
              health_score=excluded.health_score, rating=excluded.rating, rating_grade=excluded.rating_grade,
              raw_json=excluded.raw_json, updated_at=excluded.updated_at`,
      args: [
        id, mode, String(r.name ?? ''), String(r.url ?? ''), String(r.owner_id ?? ''), String(r.owner_name ?? ''),
        String(r.currency ?? ''), String(r.timer_in_minutes ?? ''), String(r.reward ?? ''),
        r.is_enabled === '1' || r.is_enabled === 1 || r.is_enabled === true ? 1 : 0,
        String(r.creation_date ?? ''), String(r.category ?? ''), JSON.stringify(r.categories ?? null),
        String(r.paid_today ?? ''), String(r.total_users_paid ?? ''), String(r.active_users ?? ''),
        String(r.balance ?? ''), String(r.health ?? ''),
        r.health_score != null ? Number(r.health_score) : null,
        r.rating != null ? Number(r.rating) : null,
        String(r.rating_grade ?? ''), JSON.stringify(r), now,
      ],
    });
  });
  await client.batch(stmts, 'write');
  return stmts.length;
}

async function writeHistoryToTurso(client, mode, history) {
  const now = new Date().toISOString();
  const stmts = [];
  for (const f of history.faucets || []) {
    stmts.push({
      sql: `INSERT INTO history_faucets (url, data, updated_at) VALUES (?, ?, ?)
            ON CONFLICT(url) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at`,
      args: [String(f.url ?? ''), JSON.stringify(f), now],
    });
  }
  await client.batch(stmts, 'write');
  return stmts.length;
}

async function writeConfigToTurso(client, mode, config) {
  await client.execute({
    sql: `INSERT OR REPLACE INTO configs (mode, data, updated_at) VALUES (?, ?, ?)`,
    args: [mode, JSON.stringify(config), new Date().toISOString()],
  });
  return 1;
}

async function mirrorToTurso(mode, raw, history, config, rawRows) {
  const client = getTursoClient();
  if (!client) {
    if (mode === MODE_PROD) {
      throw new Error('[turso] PROD mirror requires Turso credentials — set GitHub Secrets TURSO_URL and TURSO_TOKEN (full-access / rw token). None found; skipping would leave the DB stale, so aborting.');
    }
    console.log('[turso] no credentials found — skipping cloud mirror (sandbox dry-run).');
    return;
  }
  try {
    await ensureTursoSchema(client);
    const nCfg = await writeConfigToTurso(client, mode, config);
    const nF = await writeFaucetsToTurso(client, mode, raw);
    let nH = 0;
    let nRaw = 0;
    if (mode !== MODE_SANDBOX) {
      nH = await writeHistoryToTurso(client, mode, history);
      nRaw = await writeRawToTurso(client, rawRows || []);
    } else {
      console.log('[turso] sandbox history skipped (dry-run, shared history_faucets untouched).');
    }
    console.log(`[turso] mirrored -> configs(${nCfg}) faucets(${nF}) history_faucets(+${nH}) raw_hourly(+${nRaw})`);
  } catch (e) {
    if (mode === MODE_PROD) {
      throw new Error('[turso] PROD mirror FAILED (check TURSO_URL / TURSO_TOKEN are correct and the token has write/rw access): ' + (e && e.message ? e.message : e));
    }
    console.error('[turso] mirror FAILED (non-fatal): ' + (e && e.message ? e.message : e));
  } finally {
    try {
      await client.close();
    } catch (_) {
      /* ignore */
    }
    _tursoClient = null;
  }
}

async function loadHistoryFromTurso(config) {
  const client = getTursoClient();
  if (!client) return null;
  try {
    const res = await client.execute('SELECT url, data FROM history_faucets');
    const faucets = (res.rows || []).map((r) => JSON.parse(r.data));
    return {
      updated_at: new Date().toISOString(),
      retention_days: (config && config.settings && config.settings.history_retention_days) || 7,
      crypto_prices_usd: (config && config.crypto_prices_usd) || {},
      faucets,
    };
  } catch (e) {
    console.warn('[turso] history load failed, falling back to disk: ' + e.message);
    return null;
  } finally {
    try {
      await client.close();
    } catch (_) {
      /* ignore */
    }
    _tursoClient = null;
  }
}

async function loadSandboxConfigFromTurso() {
  const client = getTursoClient();
  if (!client) return null;
  try {
    const res = await client.execute("SELECT data FROM configs WHERE mode='sandbox'");
    if (res.rows && res.rows.length) return JSON.parse(res.rows[0].data);
  } catch (e) {
    console.warn('[turso] sandbox config load failed:', e.message);
  } finally {
    try {
      await client.close();
    } catch (_) {
      /* ignore */
    }
    _tursoClient = null;
  }
  return null;
}

async function loadConfigFromTurso(mode) {
  const client = getTursoClient();
  if (!client) return null;
  try {
    const res = await client.execute("SELECT data FROM configs WHERE mode='" + String(mode) + "'");
    if (res.rows && res.rows.length) return JSON.parse(res.rows[0].data);
  } catch (e) {
    console.warn('[turso] config(' + mode + ') load failed:', e.message);
  } finally {
    try { await client.close(); } catch (_) {}
    _tursoClient = null;
  }
  return null;
}

async function loadTargetOverridesFromTurso() {
  const client = getTursoClient();
  if (!client) return new Map();
  try {
    const res = await client.execute('SELECT url, data FROM faucet_target_overrides');
    const m = new Map();
    for (const r of (res.rows || [])) {
      try { m.set(normalizeUrl(r.url), JSON.parse(r.data)); } catch (e) {}
    }
    return m;
  } catch (e) {
    console.warn('[turso] target overrides load failed:', e.message);
    return new Map();
  } finally {
    try { await client.close(); } catch (_) {}
    _tursoClient = null;
  }
}

function defaultEngineConfig() {
  return {
    rating: {},
    rating_thresholds: {},
    targets: [],
    crypto_prices_usd: {},
    settings: {
      history_retention_days: 7,
      history_file: 'history.json',
      data_file: 'faucets.json',
      group_by: 'category',
    },
  };
}

async function main() {
  const argv = parseArgs();
  const mode = resolveMode(argv);

  const configFile =
    argv.config ||
    (mode === MODE_SANDBOX ? path.join(__dirname, 'faucet_config.sandbox.json') : CONFIG_FILE);

  let config = null;
  config = await loadConfigFromTurso(mode);
  if (config) {
    console.log('[config] loaded from Turso (' + mode + ')');
  } else if (fs.existsSync(configFile)) {
    config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    console.log('[config] loaded from disk fallback: ' + configFile);
  } else if (mode === MODE_SANDBOX) {
    config = await loadConfigFromTurso(MODE_PROD);
    if (config) console.log('[config] sandbox fell back to prod config from Turso');
  }
  if (!config) {
    console.warn('[config] using engine default config');
    config = defaultEngineConfig();
  }
  validateEngineConfig(config);

  if (argv['fetch-prices'] || argv['fetchprices'] || argv['prices-only']) {
    // For --prices-only, operate strictly on the real per-mode config so we
    // never accidentally copy the prod config into the sandbox slot when the
    // sandbox config does not yet exist in Turso.
    if (argv['prices-only'] && mode === MODE_SANDBOX) {
      const sb = await loadConfigFromTurso(MODE_SANDBOX);
      if (!sb) {
        console.log('[prices] no sandbox config in Turso — nothing added in the Sandbox admin to refresh.');
        return;
      }
      config = sb;
    }
    const symbols = Object.keys(config.crypto_prices_usd || {});
    if (symbols.length === 0) {
      console.log('[prices] no currencies added in config (' + mode + ') — nothing to fetch.');
    } else {
      try {
        const cp = require('./cryptoPrices.js');
        const res = await cp.fetchCryptoPrices(symbols);
        let updated = 0;
        for (const k of Object.keys(res.prices)) {
          config.crypto_prices_usd[k] = res.prices[k];
          updated++;
        }
        console.log('[prices] fetched from API: ' + updated + ' coins updated (binance=' + res.sources.binance + ', coincap=' + res.sources.coincap + ', coingecko=' + res.sources.coingecko + ')');
      } catch (e) {
        console.warn('[prices] API fetch failed (' + e.message + ') — using config values');
      }
    }
    if (argv['prices-only']) {
      // Persist ONLY the (refreshed) config.crypto_prices_usd back to Turso.
      try {
        const client = getTursoClient();
        if (!client) throw new Error('Turso credentials not found (set TURSO_URL / TURSO_TOKEN)');
        await ensureTursoSchema(client);
        await writeConfigToTurso(client, mode, config);
        await client.close();
        _tursoClient = null;
        console.log('[prices] config with refreshed rates saved to Turso (' + mode + ').');
      } catch (e) {
        if (mode === MODE_PROD) throw e;
        console.warn('[prices] config save failed: ' + e.message);
      }
      console.log('[prices] --prices-only: done.');
      return;
    }
  }

  let input = null;
  let output = null;
  let historyFile = null;

  if (mode === MODE_SANDBOX) {
    historyFile = argv.history || path.join(__dirname, 'history.sandbox.json');
    input = null;
    output = argv.output || path.join(__dirname, 'faucets.sandbox.json');
  } else {
    historyFile = argv.history || config.settings.history_file || HISTORY_FILE;
    input = argv.input || config.settings.data_file || 'faucets.json';
    output = argv.output || input;
  }

  assertNotProd(mode, [configFile, historyFile, output]);

  let history = null;
  if (mode === MODE_SANDBOX) {
    const gen = require('./generate_mock_history.js');
    history = gen.generate(config);
    console.log('[sandbox] history generated in-memory');
  } else {
    // PROD: history is canonical in Turso. If empty, seed a fresh structure
    // so updateHistory can populate every faucet from the current snapshot.
    history = await loadHistoryFromTurso(config);
    if (!history || !history.faucets || history.faucets.length === 0) {
      history = {
        updated_at: null,
        retention_days: config.settings.history_retention_days || 7,
        crypto_prices_usd: config.crypto_prices_usd || {},
        faucets: [],
      };
    }
  }

  let raw = null;
  if (mode === MODE_SANDBOX) {
    const mockFaucets = require('./generate_mock_faucets.js');
    const built = mockFaucets.buildFaucetPayData(config, history, Date.now());
    raw = { fetched_at: new Date().toISOString(), data: built.data };
  } else {
    if (!fs.existsSync(input)) {
      console.error('input file not found: ' + input);
      process.exit(1);
    }
    raw = JSON.parse(fs.readFileSync(input, 'utf8'));
  }

  const fetchedAt = raw.fetched_at ? new Date(raw.fetched_at).getTime() : Date.now();
  const nowTs = isNaN(fetchedAt) ? Date.now() : fetchedAt;

  const payload = raw.data && typeof raw.data === 'object' ? raw.data : raw;
  const freshByUrl = collectFreshByUrl(payload.list_data);

  const overridesMap = await loadTargetOverridesFromTurso();
  const updateResult = updateHistory(freshByUrl, history, config, overridesMap, nowTs);

  const enrichResult = enrichFaucets(raw, history, config, overridesMap);

  // Build full raw hourly snapshots (all coins, including zero balances) for the
  // "Сырые данные API" Real Mode tab. Only populated for PROD (sandbox uses mocks).
  let rawRows = [];
  if (mode !== MODE_SANDBOX) {
    rawRows = buildRawSnapshots(freshByUrl, config.crypto_prices_usd, nowTs);
  }

  // Mirror enriched data to Turso (configs, faucets, history_faucets, raw_hourly).
  // No local .json artifacts are produced — the static site reads Turso directly;
  // the raw faucets.json API array stays in the repo root as the API input source.
  await mirrorToTurso(mode, raw, history, config, rawRows);

  console.log('=== build_faucets.js (mode: ' + mode + ') ===');
  console.log('config:       ' + (configFile && fs.existsSync(configFile) ? configFile : 'Turso/' + mode));
  console.log('history updated_at: ' + history.updated_at);
  console.log('history faucets:    ' + history.faucets.length);
  console.log('input:  ' + (mode === MODE_SANDBOX ? 'mock (generated in-memory)' : input));
  console.log('enriched faucets:   ' + enrichResult.enriched);
  console.log('skipped (no history): ' + enrichResult.skipped);
}

main().catch((e) => {
  console.error('FATAL: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
