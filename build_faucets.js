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

// Map<ключ, значение> -> обычный объект для сериализации в data.json (ключи — нормализованные URL).
function mapToObj(map) {
  const o = {};
  if (map && typeof map.forEach === 'function') map.forEach((v, k) => { o[k] = v; });
  return o;
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

// Извлечь плоский массив записей кранов из разных форм обёртки API/CI:
//   { data: { list_data: [...] } }                       — канон
//   { data: { status, data: { list_data: [...] } } }      — обёртка воркфлоу поверх API
//   { list_data: [...] } / сам массив
function extractFaucetList(raw) {
  if (!raw) return [];
  if (raw.data && Array.isArray(raw.data.list_data)) return raw.data.list_data;
  if (raw.data && raw.data.data && Array.isArray(raw.data.data.list_data)) return raw.data.data.list_data;
  if (Array.isArray(raw.list_data)) return raw.list_data;
  if (Array.isArray(raw)) return raw;
  // Список может быть вложен произвольно (напр. { list_data: { normal: { BTC: {0: rec, ...}, ... } } }).
  // walkRecords рекурсивно находит все узлы с name+url — это ровно то, что делает
  // и остальной пайплайн (writeFaucetsToTurso и т.п.), поэтому результат идентичен.
  const out = [];
  walkRecords(raw, (r) => out.push(r));
  return out;
}

// Схлопнуть сырые записи «кран × валюта» до уникальных кранов. Ключ такой же,
// как PRIMARY KEY таблицы faucets (faucetIdFromRec), поэтому результат совпадает
// с тем, что живёт в БД (≈300–330 строк вместо ~3500 пер-валютных записей).
// Last-wins повторяет поведение UPSERT: при совпадении ключа остаётся последняя
// по порядку запись (та, что перезаписала бы строку в БД).
function dedupeFaucetList(records) {
  const byKey = new Map();
  if (Array.isArray(records)) {
    for (const r of records) {
      if (!r || typeof r !== 'object') continue;
      byKey.set(faucetIdFromRec(r), r);
    }
  }
  return Array.from(byKey.values());
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

function median(arr) {
  if (!arr || !arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// NEW parallel Health Score for the raw-data tab. Computed EXCLUSIVELY from
// raw_hourly snapshots (each coin's `balance`), independent of the existing
// history_faucets / recomputeDailyHealth paths. Mirrors the browser implementation.
// --- Raw Data "Сырые данные": SIMPLIFIED Health Score ---
// TOTAL_BALANCE (USD) for a snapshot = sum over coins of (balance × rate-at-snapshot).
function snapshotTotalUsd(coins, prices) {
  let total = 0;
  const pr = prices || {};
  for (const c of (coins || [])) {
    const bal = Number(c.balance) || 0;
    const p = Number(pr[c.symbol]) || 0;
    total += bal * p;
  }
  return total;
}

// SIMPLIFIED Health Score (CURRENT_HEALTH) with the additional business rules layered
// on top of the base formula.
//   base = round(min(100, (totalUsd / peakUsd) * 100)) when peakUsd > 0, else 0
// where peakUsd = абсолютный пик общего баланса (всегда >= totalUsd; это "max Баланс 7D" /
// ЭТАЛОН).
// Правила:
//   1) peakUsd < 0.01 И totalUsd < 0.01            -> HS = 0 всегда
//   2) нет снимков (нет данных)                     -> null (прочерк; обрабатывается вызывающим)
//   3) 0.01 <= peakUsd < 1                          -> base * peakUsd (итоговый HS масштабируется пиком)
//   4) peakUsd >= 1                                 -> base (базовая логика)
// Возвращает целое число HS, либо null когда снимка нет/считать не из чего.
function computeSimplifiedHealthScore(totalUsd, peakUsd) {
  const t = Number(totalUsd) || 0;
  const peak = Number(peakUsd) || 0;
  const base = peak > 0 ? Math.round(Math.min(100, (t / peak) * 100)) : 0;
  if (peak < 0.01 && t < 0.01) return 0;       // правило 1
  if (peak >= 1) return base;                   // правило 4
  if (peak >= 0.01) return Math.round(base * peak); // правило 3 (0.01..1)
  return 0;
}

async function writeRawToTurso(client, rows) {
  if (!rows || !rows.length) return 0;
  // The batch may span MANY faucets (every URL is written in a single call). Group
  // by URL so each faucet's ЭТАЛОН (absolute peak) is computed from ITS OWN history.
  const byUrl = new Map();
  for (const r of rows) {
    const u = r.url;
    if (!byUrl.has(u)) byUrl.set(u, []);
    byUrl.get(u).push(r);
  }
  const insertStmts = [];
  for (const [url, urlRows] of byUrl) {
    // Load the FULL existing history for this faucet so the ЭТАЛОН (absolute peak of
    // total USD balance) spans the ENTIRE history period, not a sliding window.
    let existing = [];
    try {
      const res = await client.execute({
        sql: 'SELECT snapshot_at, coins_json, prices_json FROM raw_hourly WHERE url = ? ORDER BY snapshot_at ASC',
        args: [url],
      });
      existing = ((res && res.rows) || []).map((r) => ({
        snapshot_at: r.snapshot_at,
        coins: JSON.parse(r.coins_json || '[]'),
        prices: JSON.parse(r.prices_json || '{}'),
      }));
    } catch (e) {
      existing = [];
    }
    // Ignore any existing row that is being re-inserted in this batch.
    const incomingAts = new Set(urlRows.map((r) => r.snapshot_at));
    const prior = existing.filter((e) => !incomingAts.has(e.snapshot_at));
    let runningMax = 0;
    for (const p of prior) {
      const t = snapshotTotalUsd(p.coins, p.prices);
      if (t > runningMax) runningMax = t;
    }
    // New rows in chronological order; ЭТАЛОН = running max INCLUDING the current row.
    const newRows = urlRows.slice().sort((a, b) =>
      a.snapshot_at < b.snapshot_at ? -1 : a.snapshot_at > b.snapshot_at ? 1 : 0);
    for (const r of newRows) {
      const coins = JSON.parse(r.coins_json || '[]');
      const prices = JSON.parse(r.prices_json || '{}');
      const t = snapshotTotalUsd(coins, prices);
      if (t > runningMax) runningMax = t;
      const ref = runningMax > 0 ? runningMax : t;
      r.health_score = computeSimplifiedHealthScore(t, runningMax);
    }
    for (const r of newRows) {
      insertStmts.push({
        sql: `INSERT INTO raw_hourly (url, snapshot_at, day, coins_json, prices_json, health_score) VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(url, snapshot_at) DO UPDATE SET day=excluded.day, coins_json=excluded.coins_json, prices_json=excluded.prices_json, health_score=excluded.health_score`,
        args: [r.url, r.snapshot_at, r.day, r.coins_json, r.prices_json, r.health_score],
      });
    }
  }
  await client.batch(insertStmts, 'write');
  return insertStmts.length;
}

function ageFromCreation(creationDate, nowTs) {
  if (!creationDate || creationDate <= 0) return 0;
  const months = (nowTs - creationDate * 1000) / (30.44 * 24 * 3600 * 1000);
  return Math.max(0, Math.floor(months));
}

// Collect every currency symbol that actually appears in the FaucetPay source
// data. This guarantees that any coin FaucetPay reports (e.g. DOGE, PEPE, POL)
// gets a rate fetched for it, even if it was never manually added to
// config.crypto_prices_usd — so its rate column shows up in "Сырые данные API".
function gatherInputCurrencySymbols(inputPath) {
  const set = new Set();
  if (!inputPath || !fs.existsSync(inputPath)) return set;
  try {
    const raw = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
    const listData = extractFaucetList(raw);
    walkRecords(listData, (rec) => {
      const cur = String(rec.currency || '').toUpperCase();
      if (cur) set.add(cur);
    });
  } catch (e) {
    /* ignore unreadable input */
  }
  return set;
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

// Блок 1, подблок «Суточный объём выплат»: эталон = медиана посуточных пиковых
// значений PAID_TODAY (USD) из raw_hourly (последний снимок каждых суток). Та же
// логика, что и на клиенте (app.js computeRawDailyVolumeReference).
function computeRawDailyVolumeReference(snaps) {
  // Блок 1 (daily_volume): максимум paid_today за каждые ЗАВЕРШЁННЫЕ сутки,
  // затем среднее арифметическое по завершённым суткам. Текущие сутки исключены.
  const byDay = new Map();
  for (const s of (snaps || [])) {
    const day = (s.day || (s.snapshot_at || '').slice(0, 10));
    if (!day) continue;
    const coins = s.coins || [];
    const paid = coins.length ? (Number(coins[0].paid_today) || 0) : 0;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(paid);
  }
  if (!byDay.size) return null;
  const curDay = Array.from(byDay.keys()).sort().pop();
  const peaks = [];
  for (const [d, arr] of byDay) {
    if (d === curDay) continue;
    peaks.push(Math.max.apply(null, arr));
  }
  if (!peaks.length) return Math.max.apply(null, byDay.get(curDay));
  const sum = peaks.reduce((a, b) => a + b, 0);
  return sum / peaks.length;
}

async function computeDailyVolumeByUrl(client, mode) {
  const out = new Map();
  try {
    const res = await client.execute('SELECT url, snapshot_at, day, coins_json FROM raw_hourly ORDER BY url, snapshot_at ASC');
    const byUrl = new Map();
    for (const r of (res.rows || [])) {
      const u = normalizeUrl(r.url);
      if (!byUrl.has(u)) byUrl.set(u, []);
      byUrl.get(u).push({ snapshot_at: r.snapshot_at, day: r.day, coins: JSON.parse(r.coins_json || '[]') });
    }
    for (const [u, snaps] of byUrl) out.set(u, computeRawDailyVolumeReference(snaps));
  } catch (e) {
    console.warn('[turso] daily volume load failed: ' + (e && e.message ? e.message : e));
  }
  return out;
}

function medianOf(arr) {
  const vals = (arr || []).filter((v) => v != null).slice().sort((a, b) => a - b);
  if (!vals.length) return null;
  const n = vals.length;
  const med = (n % 2 === 1) ? vals[(n - 1) / 2] : (vals[n / 2 - 1] + vals[n / 2]) / 2;
  return Math.round(med);
}
function computeRawHealthSeries(history) {
  const sorted = (history || []).slice().sort((a, b) => a.snapshot_at < b.snapshot_at ? -1 : a.snapshot_at > b.snapshot_at ? 1 : 0);
  const totalByAt = {};
  const healthByAt = {};
  let runningMax = 0;
  for (const h of sorted) {
    const t = snapshotTotalUsd(h.coins, h.prices);
    if (t > runningMax) runningMax = t;
    totalByAt[h.snapshot_at] = t;
    healthByAt[h.snapshot_at] = computeSimplifiedHealthScore(t, runningMax);
  }
  return { totalByAt, healthByAt, peakValue: runningMax };
}
function computePerSnapshotMedianHs(snaps, history, series) {
  const dailyPeak = {};
  const daySet = new Set();
  for (const h of (history || [])) {
    const day = (h.snapshot_at || '').slice(0, 10);
    if (!day) continue;
    daySet.add(day);
    const hs = series.healthByAt[h.snapshot_at];
    if (hs == null) continue;
    if (dailyPeak[day] == null || hs > dailyPeak[day]) dailyPeak[day] = hs;
  }
  const allDays = Array.from(daySet).sort();
  const prevPeaksByDay = {};
  for (let i = 0; i < allDays.length; i++) {
    prevPeaksByDay[allDays[i]] = allDays.slice(0, i).map((d) => dailyPeak[d]);
  }
  const out = [];
  let runningPeak = null;
  for (let i = 0; i < (snaps || []).length; i++) {
    const s = snaps[i];
    const hs = series.healthByAt[s.snapshot_at];
    const day = (s.snapshot_at || '').slice(0, 10);
    if (hs != null && (runningPeak == null || hs > runningPeak)) runningPeak = hs;
    const peaks = (prevPeaksByDay[day] || []).slice();
    peaks.push(runningPeak != null ? runningPeak : 0);
    out.push(medianOf(peaks));
  }
  return out;
}
async function computeMedianHsByUrl(client, mode) {
  const out = new Map();
  try {
    const res = await client.execute('SELECT url, snapshot_at, day, coins_json, prices_json FROM raw_hourly ORDER BY url, snapshot_at ASC');
    const byUrl = new Map();
    for (const r of (res.rows || [])) {
      const u = normalizeUrl(r.url);
      if (!byUrl.has(u)) byUrl.set(u, []);
      byUrl.get(u).push({ snapshot_at: r.snapshot_at, day: r.day, coins: JSON.parse(r.coins_json || '[]'), prices: JSON.parse(r.prices_json || '{}') });
    }
    for (const [u, history] of byUrl) {
      if (!history.length) continue;
      const series = computeRawHealthSeries(history);
      // «Медиана HS» последнего (текущего) снимка = колонка таблицы «Сырые данные»
      // для текущего дня: snaps — ТОЛЬКО снимки текущего (последнего) дня, history — вся история.
      const latest = history.reduce((a, b) => (a.snapshot_at > b.snapshot_at ? a : b));
      const curDay = latest.day || latest.snapshot_at.slice(0, 10);
      const daySnaps = history.filter((s) => (s.day || s.snapshot_at.slice(0, 10)) === curDay);
      const medianArr = computePerSnapshotMedianHs(daySnaps, history, series);
      const last = medianArr.length ? medianArr[medianArr.length - 1] : null;
      out.set(u, last);
    }
  } catch (e) {
    console.warn('[turso] median HS load failed: ' + (e && e.message ? e.message : e));
  }
  return out;
}

// Блок 1, подблок «Пауза в выплатах» (payout_activity_hours). Эталон — кол-во итераций
// (≈ часов) с последней выплаты, вычисленное из TOTAL_USERS_PAID (coins[0].total_users_paid)
// таблицы «Сырые данные». Логика полностью идентична клиентской computePayoutPause.
function computePayoutPause(snaps, retentionDays) {
  if (!snaps || snaps.length === 0) return 0;
  const MAX = (retentionDays || 7) * 24 + 1;
  const current = snaps[snaps.length - 1];
  const curVal = Number(current.total_users_paid) || 0;
  if (curVal === 0) return MAX;
  const byDay = new Map();
  for (const s of snaps) {
    const d = s.day || (s.snapshot_at || '').slice(0, 10);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(s);
  }
  const dayKeys = Array.from(byDay.keys()).sort();
  let totalIters = 0;
  for (let di = dayKeys.length - 1; di >= 0; di--) {
    const daySnaps = byDay.get(dayKeys[di]);
    const refVal = Number(daySnaps[daySnaps.length - 1].total_users_paid) || 0;
    let found = false;
    for (let i = daySnaps.length - 2; i >= 0; i--) {
      totalIters++;
      if (refVal > Number(daySnaps[i].total_users_paid)) { found = true; break; }
      if (totalIters >= MAX) return MAX;
    }
    if (found) return totalIters;
  }
  return Math.min(totalIters, MAX);
}

async function computePayoutPauseByUrl(client, retentionDays) {
  const out = new Map();
  try {
    const res = await client.execute('SELECT url, snapshot_at, day, coins_json FROM raw_hourly ORDER BY url, snapshot_at ASC');
    const byUrl = new Map();
    for (const r of (res.rows || [])) {
      const u = normalizeUrl(r.url);
      if (!byUrl.has(u)) byUrl.set(u, []);
      let paid = 0;
      try {
        const coins = JSON.parse(r.coins_json || '[]');
        if (coins.length) paid = Number(coins[0].total_users_paid) || 0;
      } catch (_) {}
      byUrl.get(u).push({ snapshot_at: r.snapshot_at, day: r.day, total_users_paid: paid });
    }
    for (const [u, snaps] of byUrl) {
      if (!snaps.length) continue;
      out.set(u, computePayoutPause(snaps, retentionDays));
    }
  } catch (e) {
    console.warn('[turso] payout pause load failed: ' + (e && e.message ? e.message : e));
  }
  return out;
}

// «Пик баланса» (USD) по каждому URL — максимум snapshotTotalUsd по всем снимкам raw_hourly.
// Порт loadPeakRawBalanceByUrl() из app.js, чтобы браузер брал эти эталоны прямо из data.json
// (без обращения к Turso).
async function computePeakRawBalanceByUrl(client, mode) {
  const out = new Map();
  try {
    const res = await client.execute('SELECT url, coins_json, prices_json FROM raw_hourly');
    for (const r of (res.rows || [])) {
      const u = normalizeUrl(r.url);
      const coins = JSON.parse(r.coins_json || '[]');
      const prices = JSON.parse(r.prices_json || '{}');
      const tb = snapshotTotalUsd(coins, prices);
      const cur = out.get(u);
      if (cur === undefined || tb > cur) out.set(u, tb);
    }
  } catch (e) {
    console.warn('[turso] peak balance load failed: ' + (e && e.message ? e.message : e));
  }
  return out;
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

function enrichFaucets(raw, history, config, overridesMap, dailyVolByUrl, medianHsByUrl, payoutPauseByUrl) {
  const prices = history.crypto_prices_usd || {};
  const overrideByUrl = overridesMap || new Map();
  const historyByUrl = new Map();
  for (const f of history.faucets || []) {
    historyByUrl.set(normalizeUrl(f.url), f);
  }

  const ratingCalculator = require('./ratingCalculator.js');

  const mergeModeration = (historyEntry, target) => {
    const out = Object.assign({}, historyEntry);
    if (target) {
      const fields = ['is_enabled', 'age_months', 'payout_type', 'gateways_count', 'uii', 'bonus_points', 'label'];
      for (const f of fields) {
        if (target[f] !== undefined) out[f] = target[f];
      }
    }
    return out;
  };

  let enriched = 0;
  let skipped = 0;

  const listData = extractFaucetList(raw);

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
      // Блок 1 daily_volume: эталон из raw_hourly (последний снимок суток -> PAID_TODAY
      // USD -> медиана), как и на клиенте.
      if (dailyVolByUrl && dailyVolByUrl.has(key) && faucetData.payouts) {
        faucetData.payouts.daily_volume_reference = dailyVolByUrl.get(key);
      }
      // Блок 1 health: «Медиана HS» последнего снимка из raw_hourly.
      if (medianHsByUrl && medianHsByUrl.has(key) && faucetData.payouts) {
        faucetData.payouts.health_reference = medianHsByUrl.get(key);
      }
      // Блок 1 payout_activity: эталон (кол-во итераций с последней выплаты) из
      // TOTAL_USERS_PAID таблицы «Сырые данные» (raw_hourly).
      if (payoutPauseByUrl && payoutPauseByUrl.has(key) && faucetData.payouts) {
        faucetData.payouts.payout_activity_hours = payoutPauseByUrl.get(key);
      }
      // The Health Score column is now sourced from the latest raw_hourly snapshot
      // (CURRENT_HEALTH) — see mirrorToTurso below. No separate Health Score
      // computation runs here anymore; only the rating is still derived (and the
      // rating does NOT depend on healthScore.calculateHealthScore's output).
      const ratingResult = ratingCalculator.calculateRating(faucetData, undefined, config);

      faucet.health_score = null; // filled from latest raw_hourly in mirrorToTurso
      faucet.health_breakdown = null;
      faucet.rating = ratingResult.final_rating;
      faucet.rating_grade = ratingResult.letter_grade;
      faucet.rating_breakdown = ratingResult;
      enriched++;
    });
  }

  return { enriched, skipped };
}

const MODE_PROD = 'prod';

function resolveMode() {
  return MODE_PROD;
}

function validateEngineConfig(config) {
  const required = ['rating', 'rating_thresholds', 'targets', 'crypto_prices_usd', 'settings'];
  const missing = required.filter((k) => config[k] === undefined || config[k] === null);
  if (missing.length) {
    console.warn('[compat] WARN: config misses keys ' + missing.join(', ') + ' — engine will use its hardcoded fallbacks for these.');
  }
  const rating = config.rating || {};
  const ratingSub = ['block_weights', 'daily_volume_usd', 'health_score', 'payout_activity_hours', 'age_months', 'payout_type', 'gateways_count'];
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
      health_score REAL,
      PRIMARY KEY (url, snapshot_at)
    )`
  );
  await client.execute(`CREATE INDEX IF NOT EXISTS idx_raw_url_day ON raw_hourly(url, day)`);
  await client.execute(
    `CREATE TABLE IF NOT EXISTS change_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      faucet_id TEXT NOT NULL,
      field_name TEXT NOT NULL,
      new_value TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`
  );
  await client.execute(`CREATE INDEX IF NOT EXISTS idx_change_logs_created ON change_logs(created_at)`);
}

function faucetIdFromRec(rec) {
  const id = String(rec.id != null ? rec.id : '').trim();
  if (id) return id;
  return normalizeUrl(rec.url) + '|' + String(rec.currency || '').toUpperCase();
}

async function writeFaucetsToTurso(client, mode, raw) {
  const now = new Date().toISOString();
  const seen = new Set();
  const stmts = [];
  walkRecords(extractFaucetList(raw), (r) => {
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
    throw new Error('[turso] mirror requires Turso credentials — set GitHub Secrets TURSO_URL and TURSO_TOKEN (full-access / rw token). None found; skipping would leave the DB stale, so aborting.');
  }
  try {
    await ensureTursoSchema(client);
    const nCfg = await writeConfigToTurso(client, mode, config);
    let nH = 0;
    let nRaw = 0;
    nH = await writeHistoryToTurso(client, mode, history);
    // Write raw_hourly FIRST so each snapshot's health_score (CURRENT_HEALTH) is
    // computed on rawRows; then propagate the LATEST per-faucet value into the
    // faucet record's health_score column (the "Health Score" column in the main
    // table now equals the latest raw_hourly CURRENT_HEALTH).
    nRaw = await writeRawToTurso(client, rawRows || []);
    const latestHealthByUrl = new Map();
    for (const r of (rawRows || [])) {
      const u = normalizeUrl(r.url);
      const cur = latestHealthByUrl.get(u);
      if (!cur || new Date(r.snapshot_at) >= new Date(cur.snapshot_at)) {
        // Текущий капитал и TOTAL_USERS_PAID берём из ПОСЛЕДНЕГО снимка raw_hourly
        // (как loadLatestRawHealthByUrl в app.js), чтобы data.json нёс те же значения,
        // что и живой Turso-путь — иначе колонка «Капитал» была бы прочерком.
        const coins = JSON.parse(r.coins_json || '[]');
        const prices = JSON.parse(r.prices_json || '{}');
        let bal = 0;
        for (const c of coins) bal += (Number(c.balance) || 0) * (Number(prices[c.symbol]) || 0);
        const paid = coins.length ? (Number(coins[0].total_users_paid) || 0) : 0;
        latestHealthByUrl.set(u, {
          snapshot_at: r.snapshot_at,
          health_score: r.health_score,
          current_capital: bal,
          total_users_paid: Math.round(paid),
        });
      }
    }
    const listData = extractFaucetList(raw);
    if (listData && typeof listData === 'object') {
      walkRecords(listData, (rec) => {
        const u = normalizeUrl(rec.url);
        const f = latestHealthByUrl.get(u);
        // Берём ТОЛЬКО формульные значения из raw_hourly (БД). Сырые показатели
        // FaucetPay из faucets.json категорически не используем: при отсутствии
        // свежего снимка ставим null, чтобы браузер пересчитал по формуле.
        rec.health_score = f ? f.health_score : null;
        rec.current_capital = f ? round(f.current_capital, 2) : null;
        rec.total_users_paid = f ? f.total_users_paid : null;
      });
    }
    const nF = await writeFaucetsToTurso(client, mode, raw);
    console.log(`[turso] mirrored -> configs(${nCfg}) faucets(${nF}) history_faucets(+${nH}) raw_hourly(+${nRaw})`);
  } catch (e) {
    throw new Error('[turso] mirror FAILED (check TURSO_URL / TURSO_TOKEN are correct and the token has write/rw access): ' + (e && e.message ? e.message : e));
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
  // COMPLETE default — mirror of app.js defaultFormulaConfig(). If the Turso
  // config is ever missing/empty, mergeConfigWithDefaults fills these in so the
  // build never emits a zero-rating data.json (that was the root cause of the
  // "all ratings zero" regression: an empty Turso config propagated to data.json).
  return {
    rating: {
      block_weights: { block_1_solvency: 0.58, block_2_reliability: 0.20, block_3_uii: 0.20, block_4_bonus: 0.02 },
      block_1_max_points: 100.0,
      block_2_max_points: 100.0,
      final_rating_max: 100.0,
      daily_volume_usd: {
        thresholds: [
          { max: 0, points: 0 },
          { min: 0, max: 5, points: 5 },
          { min: 5, max: 25, points: 12 },
          { min: 25, max: 100, points: 20 },
          { min: 100, max: 300, points: 30 },
          { min: 300, max: 1000, points: 40 },
          { min: 1000, points: 50 },
        ],
      },
      health_score: {
        thresholds: [
          { max: 0, points: 0 },
          { min: 0, max: 20, points: 3 },
          { min: 20, max: 40, points: 6 },
          { min: 40, max: 60, points: 9 },
          { min: 60, max: 80, points: 12 },
          { min: 80, points: 15 },
        ],
      },
      payout_activity_hours: {
        thresholds: [
          { max: 0, points: 0 },
          { min: 0, max: 6, points: 15 },
          { min: 6, max: 24, points: 10 },
          { min: 24, max: 72, points: 5 },
          { min: 72, points: 2 },
        ],
      },
      age_months: {
        thresholds: [
          { max: 6, points: 0 },
          { min: 6, max: 12, points: 3 },
          { min: 12, max: 24, points: 6 },
          { min: 24, max: 48, points: 9 },
          { min: 48, points: 10 },
        ],
      },
      payout_type: { manual: 5, instant: 10, auto: 8, faucetpay: 10, expresscrypto: 8, direct: 10, fcn: 5, other: 5 },
      gateways_count: {
        thresholds: [
          { max: 1, points: 0 },
          { min: 1, max: 2, points: 3 },
          { min: 2, max: 3, points: 5 },
          { min: 3, max: 5, points: 8 },
          { min: 5, points: 10 },
        ],
      },
    },
    rating_thresholds: { A: 80, B: 60, C: 40, D: 20, F: 0 },
    targets: [
      { week: 1, min_daily_volume_usd: 50, min_health: 50 },
      { week: 2, min_daily_volume_usd: 100, min_health: 55 },
      { week: 3, min_daily_volume_usd: 150, min_health: 60 },
      { week: 4, min_daily_volume_usd: 200, min_health: 65 },
      { week: 5, min_daily_volume_usd: 250, min_health: 70 },
      { week: 6, min_daily_volume_usd: 300, min_health: 72 },
      { week: 7, min_daily_volume_usd: 350, min_health: 74 },
      { week: 8, min_daily_volume_usd: 400, min_health: 76 },
      { week: 9, min_daily_volume_usd: 450, min_health: 78 },
      { week: 10, min_daily_volume_usd: 500, min_health: 80 },
      { week: 11, min_daily_volume_usd: 550, min_health: 82 },
      { week: 12, min_daily_volume_usd: 600, min_health: 84 },
    ],
    crypto_prices_usd: {},
    settings: {
      history_retention_days: 7,
      history_file: 'history.json',
      data_file: 'faucets.json',
      group_by: 'category',
    },
  };
}

// Merges a (possibly partial / legacy) config with the engine defaults so the
// build never crashes on missing keys like `settings`/`settings.history_file`.
// Admin-provided values win; only absent structure is backfilled. Healing the
// config here also rewrites a complete object back to Turso via mirrorToTurso.
function mergeConfigWithDefaults(config) {
  const d = defaultEngineConfig();
  const c = config && typeof config === 'object' ? config : {};
  const out = Object.assign({}, d, c);
  out.settings = Object.assign({}, d.settings, c.settings || {});
  out.rating = Object.assign({}, d.rating, c.rating || {});
  out.rating_thresholds = Object.assign({}, d.rating_thresholds, c.rating_thresholds || {});
  out.targets = Array.isArray(c.targets) ? c.targets : d.targets;
  out.crypto_prices_usd = Object.assign({}, d.crypto_prices_usd, c.crypto_prices_usd || {});
  return out;
}

async function main() {
  const argv = parseArgs();
  const mode = resolveMode(argv);

  const configFile =
    argv.config || CONFIG_FILE;

  let config = null;
  config = await loadConfigFromTurso(mode);
  if (config) {
    console.log('[config] loaded from Turso (' + mode + ')');
  } else if (fs.existsSync(configFile)) {
    config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    console.log('[config] loaded from disk fallback: ' + configFile);
  }
  if (!config) {
    console.warn('[config] using engine default config');
    config = defaultEngineConfig();
  }
  config = mergeConfigWithDefaults(config);
  validateEngineConfig(config);

  if (argv['fetch-prices'] || argv['fetchprices'] || argv['prices-only']) {
    // Build the full set of currencies to fetch rates for:
    //  1) currencies already saved in config.crypto_prices_usd,
    //  2) every currency symbol present in the actual FaucetPay source data,
    //  3) EVERY FaucetPay-supported coin (all 23) — so rates are always parsed
    //     for the complete set, even coins no faucet in the current snapshot
    //     happens to use (their columns then show up in "Сырые данные API").
    const cp = require('./cryptoPrices.js');
    const priceInputPath = argv.input || (config.settings && config.settings.data_file) || 'faucets.json';
    const symbolSet = new Set(Object.keys(config.crypto_prices_usd || {}));
    for (const s of gatherInputCurrencySymbols(priceInputPath)) symbolSet.add(s);
    for (const s of Object.keys(cp.SYMBOL_TO_CG_ID)) symbolSet.add(s);
    const symbols = Array.from(symbolSet);
    if (symbols.length === 0) {
      console.log('[prices] no currencies found in config or FaucetPay source data (' + mode + ') — nothing to fetch.');
    } else {
      try {
        const res = await cp.fetchCryptoPrices(symbols);
        let updated = 0;
        config.crypto_prices_usd = config.crypto_prices_usd || {};
        for (const k of Object.keys(res.prices)) {
          config.crypto_prices_usd[k] = res.prices[k];
          updated++;
        }
        console.log('[prices] fetched from API: ' + updated + ' coins updated (coingecko=' + res.sources.coingecko + ', coinbase=' + res.sources.coinbase + ', binance=' + res.sources.binance + ', coincap=' + res.sources.coincap + ')');
        const missing = symbols.filter((s) => !(s in config.crypto_prices_usd));
        if (missing.length) {
          console.warn('[prices] WARNING: could not resolve rates for: ' + missing.join(', '));
        } else {
          console.log('[prices] all ' + symbols.length + ' requested coins resolved.');
        }
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

  historyFile = argv.history || config.settings.history_file || HISTORY_FILE;
  input = argv.input || config.settings.data_file || 'faucets.json';
  output = argv.output || input;

  let history = null;
  // history is canonical in Turso. If empty, seed a fresh structure
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

  let raw = null;
  if (!fs.existsSync(input)) {
    console.error('input file not found: ' + input);
    process.exit(1);
  }
  raw = JSON.parse(fs.readFileSync(input, 'utf8'));

  const fetchedAt = raw.fetched_at ? new Date(raw.fetched_at).getTime() : Date.now();
  const nowTs = isNaN(fetchedAt) ? Date.now() : fetchedAt;

  const freshByUrl = collectFreshByUrl(extractFaucetList(raw));

  const overridesMap = await loadTargetOverridesFromTurso();
  const updateResult = updateHistory(freshByUrl, history, config, overridesMap, nowTs);

  // Блок 1 daily_volume + health + payout_activity: эталоны из raw_hourly (если доступны креды Turso).
  let dailyVolByUrl = new Map();
  let medianHsByUrl = new Map();
  let payoutPauseByUrl = new Map();
  let peakByUrl = new Map();
  try {
    const client = getTursoClient();
    if (client) {
      const retentionDays = (config.settings && config.settings.history_retention_days) || 7;
      dailyVolByUrl = await computeDailyVolumeByUrl(client, mode);
      medianHsByUrl = await computeMedianHsByUrl(client, mode);
      payoutPauseByUrl = await computePayoutPauseByUrl(client, retentionDays);
      peakByUrl = await computePeakRawBalanceByUrl(client, mode);
      try { await client.close(); } catch (_) {}
      _tursoClient = null;
    }
  } catch (e) {
    console.warn('[turso] raw pre-load failed: ' + (e && e.message ? e.message : e));
  }

  const enrichResult = enrichFaucets(raw, history, config, overridesMap, dailyVolByUrl, medianHsByUrl, payoutPauseByUrl);

  // Build full raw hourly snapshots (all coins, including zero balances) for the
  // "Сырые данные API" tab.
  const rawRows = buildRawSnapshots(freshByUrl, config.crypto_prices_usd, nowTs);

  // Mirror enriched data to Turso (configs, faucets, history_faucets, raw_hourly).
  // No local .json artifacts are produced — the static site reads Turso directly;
  // the raw faucets.json API array stays in the repo root as the API input source.
  await mirrorToTurso(mode, raw, history, config, rawRows);

  // === STEP 1: статичный snapshot для мгновенной загрузки фронтенда ===
  // Формируем data.json со всеми рассчитанными данными (краны, история, конфиг).
  // Это заменяет тяжёлые прямые запросы к Turso при каждом открытии сайта.
  try {
    const snapshotPayload = {
      generated_at: new Date().toISOString(),
      timestamp: Date.now(),
      config: config,
      faucets: dedupeFaucetList(extractFaucetList(raw)),
      history: {
        crypto_prices_usd: (history && history.crypto_prices_usd) || (config && config.crypto_prices_usd) || {},
        retention_days: (history && history.retention_days) || (config && config.settings && config.settings.history_retention_days) || 7,
        updated_at: (history && history.updated_at) || null,
        faucets: (history && history.faucets) || [],
      },
      lastSnapshotAt: rawRows && rawRows.length ? rawRows.reduce((m, r) => (r.snapshot_at > m ? r.snapshot_at : m), '') : null,
      // Все эталонные агрегаты (пик баланса, дневной объём, медиана HS, пауза выплат,
      // таргет-оверрайды) — вычислены из БД и зашиты сюда, чтобы браузер НЕ обращался
      // к Turso в быстром пути (кроме крошечной дельты change_logs для живых правок админа).
      references: {
        peakByUrl: mapToObj(peakByUrl),
        dailyVolByUrl: mapToObj(dailyVolByUrl),
        medianHsByUrl: mapToObj(medianHsByUrl),
        payoutPauseByUrl: mapToObj(payoutPauseByUrl),
        targetOverrides: mapToObj(overridesMap),
      },
    };
    fs.writeFileSync(path.join(__dirname, 'data.json'), JSON.stringify(snapshotPayload));
    console.log('[snapshot] data.json written: ' + snapshotPayload.faucets.length + ' faucets');

    // Все точечные правки из change_logs уже вошли в свежий snapshot — очищаем журнал.
    const snapClient = getTursoClient();
    if (snapClient) {
      try {
        await ensureTursoSchema(snapClient);
        await snapClient.execute('DELETE FROM change_logs');
        console.log('[change_logs] cleared after snapshot');
      } catch (cle) {
        console.warn('[change_logs] clear failed: ' + (cle && cle.message ? cle.message : cle));
      } finally {
        try { await snapClient.close(); } catch (_) {}
        _tursoClient = null;
      }
    }
  } catch (se) {
    console.warn('[snapshot] data.json generation failed: ' + (se && se.message ? se.message : se));
  }

  console.log('=== build_faucets.js (mode: ' + mode + ') ===');
  console.log('config:       ' + (configFile && fs.existsSync(configFile) ? configFile : 'Turso/' + mode));
  console.log('history updated_at: ' + history.updated_at);
  console.log('history faucets:    ' + history.faucets.length);
  console.log('input:  ' + input);
  console.log('enriched faucets:   ' + enrichResult.enriched);
  console.log('skipped (no history): ' + enrichResult.skipped);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('FATAL: ' + (e && e.stack ? e.stack : e));
    process.exit(1);
  });
}

module.exports = { snapshotTotalUsd, computeSimplifiedHealthScore };
