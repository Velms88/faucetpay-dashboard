const fs = require('fs');
const path = require('path');

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

function updateHistory(freshByUrl, history, config, nowTs) {
  const retention = config.settings.history_retention_days || 7;
  const targets = config.targets || [];
  const prices = Object.assign({}, config.crypto_prices_usd || {}, history.crypto_prices_usd || {});
  history.crypto_prices_usd = prices;
  history.retention_days = retention;
  history.updated_at = new Date(nowTs).toISOString();

  const targetKeys = new Set(targets.map((t) => normalizeUrl(t.url)));

  let faucets = Array.isArray(history.faucets) ? history.faucets : [];
  const existing = new Map();
  const kept = [];
  for (const f of faucets) {
    const key = normalizeUrl(f.url);
    if (!key) continue;
    existing.set(key, f);
    if (targetKeys.has(key)) kept.push(f);
  }
  faucets = kept;

  let updated = 0;
  for (const t of targets) {
    const url = normalizeUrl(t.url);
    const fresh = freshByUrl.get(url);
    if (!fresh) {
      console.log('  target not found in fresh data: ' + t.url);
      continue;
    }
    let entry = existing.get(url);
    if (!entry) {
      entry = createHistoryEntry(url);
      faucets.push(entry);
    }
    applySnapshot(entry, fresh, prices, t, retention, nowTs);
    updated++;
  }

  faucets.sort((a, b) => (a.url < b.url ? -1 : 1));
  history.faucets = faucets;
  return { updated };
}

function enrichFaucets(raw, history, config) {
  const prices = history.crypto_prices_usd || {};
  const targetSet = new Set((config.targets || []).map((t) => normalizeUrl(t.url)));
  const historyByUrl = new Map();
  for (const f of history.faucets || []) {
    historyByUrl.set(normalizeUrl(f.url), f);
  }

  const healthScore = require('./healthScore.js');
  const ratingCalculator = require('./ratingCalculator.js');

  const targetByUrl = new Map();
  for (const t of config.targets || []) {
    targetByUrl.set(normalizeUrl(t.url), t);
  }

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
      const historyEntry = targetSet.has(key) ? historyByUrl.get(key) : null;

      if (!historyEntry) {
        faucet.health_score = null;
        faucet.rating = null;
        faucet.rating_grade = null;
        skipped++;
        return;
      }

      const faucetData = mergeModeration(historyEntry, targetByUrl.get(key));
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

async function main() {
  const argv = parseArgs();
  const mode = resolveMode(argv);

  const configFile =
    argv.config ||
    (mode === MODE_SANDBOX ? path.join(__dirname, 'faucet_config.sandbox.json') : CONFIG_FILE);
  if (!fs.existsSync(configFile)) {
    console.error('config file not found: ' + configFile);
    process.exit(1);
  }
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  validateEngineConfig(config);

  if (argv['fetch-prices'] || argv['fetchprices']) {
    try {
      const cp = require('./cryptoPrices.js');
      const res = await cp.fetchCryptoPrices(Object.keys(config.crypto_prices_usd || {}));
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
  if (fs.existsSync(historyFile)) {
    history = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
  } else if (mode === MODE_SANDBOX) {
    const gen = require('./generate_mock_history.js');
    history = gen.generate(config);
    fs.writeFileSync(historyFile, JSON.stringify(history, null, 2) + '\n');
    console.log('sandbox history generated: ' + historyFile);
  } else {
    history = {
      updated_at: null,
      retention_days: config.settings.history_retention_days || 7,
      crypto_prices_usd: config.crypto_prices_usd || {},
      faucets: [],
    };
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

  const updateResult = updateHistory(freshByUrl, history, config, nowTs);
  fs.writeFileSync(historyFile, JSON.stringify(history, null, 2) + '\n');

  const enrichResult = enrichFaucets(raw, history, config);
  fs.writeFileSync(output, JSON.stringify(raw, null, 2) + '\n');

  console.log('=== build_faucets.js (mode: ' + mode + ') ===');
  console.log('config:       ' + configFile);
  console.log('history:      ' + historyFile);
  console.log('history updated_at: ' + history.updated_at);
  console.log('targets updated:    ' + updateResult.updated + ' / ' + (config.targets || []).length);
  console.log('history faucets:    ' + history.faucets.length);
  console.log('input:  ' + (mode === MODE_SANDBOX ? 'mock (generated in-memory)' : input));
  console.log('output: ' + output);
  console.log('enriched (target matched): ' + enrichResult.enriched);
  console.log('skipped (non-target / no history): ' + enrichResult.skipped);
}

main().catch((e) => {
  console.error('FATAL: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
