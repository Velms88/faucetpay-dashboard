// ============================================================================
// FaucetPay Monitor — frontend logic (self-contained, no external libraries)
// ============================================================================

const DATA_FILES = {
  real: './faucets.json',
};

// Turso (read-only, browser-facing). This is a READ-ONLY token — safe to
// expose publicly. Writes happen server-side in build_faucets.js (full token).
const TURSO_DB_URL = 'https://faucetpay-db-velms.aws-eu-west-1.turso.io';
const TURSO_READONLY_TOKEN = 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicm8iLCJpYXQiOjE3ODcyMzM4MDMsImlkIjoiMDFhMDFmMjktZmQwMS03YjkwLThmN2ItNmE5YWUyZTIxNWI1Iiwia2lkIjoiUGlNWXZRQnNyeUNyY1NveUhvdUU0VUxCYjktSExyZXdERk1zRlJJd0NqZyIsInJpZCI6Ijk5NDY1OWM3LTA0MjMtNGRiYS1hYWY2LTAzYWFhYzU0YzQwZiJ9.rEWeefUlnZfzv7i_JWxbsA55DMph3OWf5wIXRlReZW7245yPAlR-5aFDLqMEeosHEVVaWidbhb7u4dHtxXXlCg';

let mode = 'real';
let dataUrl = DATA_FILES.real;

const errorBanner = document.getElementById('error-banner');
const recordCountEl = document.getElementById('record-count');
const lastUpdatedEl = document.getElementById('last-updated');
const tableHost = document.getElementById('faucet-table');

let allRows = [];
let sortKey = 'health';
let sortDir = 'desc';
let page = 1;
let pageSize = 25;

const COLUMNS = [
  { key: 'name', title: 'Название крана', ellipsis: true, left: true },
  { key: 'url', title: '' },
  { key: 'block_1_solvency', title: 'Блок 1: Платёжеспособность', num: true },
  { key: 'block_2_reliability', title: 'Блок 2: Надёжность', num: true },
  { key: 'uii', title: 'UII', num: true },
  { key: 'payout_type', title: 'Тип выплаты' },
  { key: 'usd_median', title: 'MAX баланс 7d (USD)', num: true },
  { key: 'total_users_paid', title: 'Выплат за 24h', num: true },
  { key: 'paid_today', title: 'Выплачено (сегодня)', num: true },
  { key: 'current_capital', title: 'Капитал (текущий)', num: true },
  { key: 'health_score', title: 'Здоровье', num: true },
  { key: 'rating', title: 'Рейтинг', num: true },
];

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function showError(message) {
  errorBanner.textContent = message;
  errorBanner.classList.add('show');
}

function hideError() {
  errorBanner.classList.remove('show');
  errorBanner.textContent = '';
}

function formatTimestamp(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('ru-RU', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
  } catch (e) {
    return iso;
  }
}

function findCategoryNameById(categories, targetId) {
  if (!categories || typeof categories !== 'object') return null;
  for (const key of Object.keys(categories)) {
    const cat = categories[key];
    if (cat && String(cat.id) === String(targetId)) {
      return cat.name;
    }
  }
  return null;
}

function collectFaucetEntries(node, out) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.name === 'string' && typeof node.url === 'string') {
    out.push(node);
    return;
  }
  for (const key of Object.keys(node)) {
    collectFaucetEntries(node[key], out);
  }
}

function normalizeResponse(json) {
  let fetchedAt = null;
  let payload = json;

  if (json && typeof json === 'object' && !Array.isArray(json) && 'data' in json) {
    fetchedAt = json.fetched_at || null;
    payload = json.data;
  }

  const listData = payload && typeof payload === 'object' ? payload.list_data : null;

  const rawRows = [];
  if (listData && typeof listData === 'object') {
    collectFaucetEntries(listData, rawRows);
  } else if (Array.isArray(payload)) {
    rawRows.push(...payload);
  } else if (payload && typeof payload === 'object') {
    collectFaucetEntries(payload, rawRows);
  }

  const faucetMap = new Map();

  rawRows.forEach((r) => {
    const name = (r.name || '').trim();
    const url = (r.url || '').trim();
    const key = url.toLowerCase() || name.toLowerCase();

    if (!key) return;

    const currency = (r.currency || '').trim();

    if (!faucetMap.has(key)) {
      faucetMap.set(key, {
        name: name,
        url: url,
        category_name: findCategoryNameById(r.categories, '1') ?? '—',
        is_enabled: r.is_enabled === '1' || r.is_enabled === 1 || r.is_enabled === true,
        currencies: new Set(currency ? [currency] : []),
        active_users: r.active_users !== undefined ? Number(r.active_users) : null,
        paid_today: r.paid_today !== undefined ? Number(r.paid_today) : null,
        total_users_paid: r.total_users_paid !== undefined ? Number(r.total_users_paid) : null,
        balance: r.balance !== undefined ? Number(r.balance) : null,
        current_capital: r.current_capital != null ? Number(r.current_capital) : null,
        health: r.health !== undefined ? Number(r.health) : null,
        health_score: r.health_score != null ? Number(r.health_score) : null,
        rating: r.rating != null ? Number(r.rating) : null,
        rating_grade: r.rating_grade != null ? String(r.rating_grade) : null,
      });
    } else {
      if (currency) {
        faucetMap.get(key).currencies.add(currency);
      }
    }
  });

  const rows = Array.from(faucetMap.values()).map(r => {
    r.currency = Array.from(r.currencies).join(', ');
    delete r.currencies;
    return r;
  });

  return { fetchedAt, rows };
}

function copyUrlFallback(text) {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  try {
    document.execCommand('copy');
  } catch (e) {
    console.error('Copy fallback failed:', e);
  }
  document.body.removeChild(textarea);
}

async function copyText(text, btn) {
  const originalText = btn.textContent;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      copyUrlFallback(text);
    }
  } catch (e) {
    copyUrlFallback(text);
  }
  btn.textContent = 'Copied!';
  setTimeout(() => { btn.textContent = originalText; }, 1200);
}

function fmtInt(v) {
  return (v === null || v === undefined || isNaN(v)) ? '—' : String(Math.round(Number(v)));
}

function fmtMoney(v) {
  return (v === null || v === undefined || isNaN(v)) ? '—' : Number(v).toFixed(2);
}

// Format a USD amount (total balance) with a $ prefix and thousands separators.
function fmtUsd(v) {
  const n = Number(v);
  if (!isFinite(n) || n === 0) return '$0';
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Format a crypto rate. For "normal" values (>= 0.01) we just show the number
// with a sensible number of decimals. For very small rates (2 or more leading
// zeros after the decimal) we use the CoinGecko style: the count of leading
// zeros is rendered as a subscript index, followed by 5 significant digits
// (e.g. 0.000003582 -> "0.<sub>5</sub>35820"). Returns safe HTML (numbers and a
// <sub> tag only) — no external/user input is interpolated.
function fmtRate(p) {
  const n = Number(p);
  if (!isFinite(n) || n === 0) return '0';
  if (n >= 0.01) {
    return Number(n.toFixed(6)).toLocaleString('en-US');
  }
  const s = n.toFixed(20);
  const dot = s.indexOf('.');
  let i = dot + 1;
  let zeros = 0;
  while (i < s.length && s[i] === '0') { zeros++; i++; }
  const sig = s.slice(i, i + 5);
  const digits = (sig + '00000').slice(0, 5);
  return '0.<sub>' + zeros + '</sub>' + digits;
}

// Format a coin balance for display. JS stringifies tiny balances in scientific
// notation (e.g. 0.00000009 -> "9e-8"), so force a fixed number of decimals and
// trim trailing zeros. Never emits an exponent.
function fmtBalance(v) {
  const n = Number(v);
  if (!isFinite(n) || n === 0) return '0';
  const abs = Math.abs(n);
  let dp = 8;
  if (abs < 1e-4) dp = 12;
  else if (abs < 1) dp = 8;
  else dp = 8;
  let s = n.toFixed(dp);
  s = s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  return s;
}

function fmtPct(v) {
  return (v === null || v === undefined || isNaN(v)) ? '—' : Number(v) + '%';
}

// ----------------------------------------------------------------------------
// DOM building
// ----------------------------------------------------------------------------

const searchInput = document.getElementById('name-search');

const scrollWrap = document.createElement('div');
scrollWrap.className = 'table-scroll';

const table = document.createElement('table');
const thead = document.createElement('thead');
const theadRow = document.createElement('tr');

const SORT_IND = { asc: '▲', desc: '▼' };

COLUMNS.forEach((col) => {
  const th = document.createElement('th');
  th.textContent = col.title;
  if (col.num) th.classList.add('num');
  if (!col.left) th.classList.add('center');

  if (col.key === 'url') {
    theadRow.appendChild(th);
    return;
  }

  th.classList.add('sortable');
  th.dataset.sort = col.key;

  const ind = document.createElement('span');
  ind.className = 'sort-ind';
  th.appendChild(ind);

  theadRow.appendChild(th);
});

thead.appendChild(theadRow);
table.appendChild(thead);

const tbody = document.createElement('tbody');
table.appendChild(tbody);

scrollWrap.appendChild(table);

const paginationBar = document.createElement('div');
paginationBar.className = 'pagination-bar';

const pageInfo = document.createElement('span');
paginationBar.appendChild(pageInfo);

const controls = document.createElement('div');
controls.className = 'pagination-controls';

const pageSizeSelect = document.createElement('select');
[20, 25, 50, 100].forEach((n) => {
  const opt = document.createElement('option');
  opt.value = String(n);
  opt.textContent = n + ' на стр.';
  pageSizeSelect.appendChild(opt);
});
pageSizeSelect.value = '25';

const prevBtn = document.createElement('button');
prevBtn.type = 'button';
prevBtn.className = 'pager-btn';
prevBtn.textContent = '← Назад';

const pageNum = document.createElement('span');

const nextBtn = document.createElement('button');
nextBtn.type = 'button';
nextBtn.className = 'pager-btn';
nextBtn.textContent = 'Вперёд →';

controls.append(prevBtn, pageNum, nextBtn);
paginationBar.append(pageSizeSelect, controls);

tableHost.append(scrollWrap, paginationBar);

// ----------------------------------------------------------------------------
// Rendering
// ----------------------------------------------------------------------------

function scoreBadgeClass(value, isRating) {
  if (value === null || value === undefined || isNaN(value)) return null;
  if (isRating) {
    if (value >= 60) return 'badge-good';
    if (value >= 20) return 'badge-mid';
    return 'badge-bad';
  }
  if (value > 60) return 'badge-good';
  if (value >= 20) return 'badge-mid';
  return 'badge-bad';
}

function appendScoreBadge(td, value, grade) {
  const cls = scoreBadgeClass(value, typeof grade === 'string' && grade !== null);
  const badge = document.createElement('span');
  if (cls === null) {
    badge.className = 'badge-na';
    badge.textContent = 'N/A';
  } else {
    badge.className = 'badge ' + cls;
    badge.textContent = Number(value).toFixed(1) + (grade ? ' / ' + grade : '');
  }
  td.appendChild(badge);
}

function trFor(r) {
  const tr = document.createElement('tr');

  COLUMNS.forEach((col) => {
    const td = document.createElement('td');
    td.style.textAlign = col.left ? 'left' : 'center';
    if (col.num) td.classList.add('num');
    if (col.center) td.classList.add('center');
    if (col.ellipsis) td.classList.add('cell-ellipsis');

    switch (col.key) {
      case 'name':
        td.textContent = r.name || '';
        break;
      case 'url': {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'copy-btn';
        btn.textContent = 'Copy URL';
        btn.dataset.url = r.url || '';
        td.appendChild(btn);
        break;
      }
      case 'block_1_solvency':
        td.textContent = fmtPct(r.block_1_solvency);
        break;
      case 'block_2_reliability':
        td.textContent = fmtPct(r.block_2_reliability);
        break;
      case 'total_users_paid':
        td.textContent = (r.total_users_paid != null) ? fmtInt(r.total_users_paid) : '—';
        break;
      case 'uii':
        td.textContent = (r.uii == null) ? '—' : Number(r.uii).toFixed(2);
        break;
      case 'usd_median':
        td.textContent = fmtMoney(r.usd_median);
        break;
      case 'current_capital':
        td.textContent = fmtMoney(r.current_capital);
        break;
      case 'payout_type':
        td.textContent = r.payout_type ? String(r.payout_type) : '—';
        break;
      case 'paid_today':
        td.textContent = fmtMoney(r.paid_today);
        break;
      case 'health_score':
        appendScoreBadge(td, r.health_score, null);
        break;
      case 'rating':
        appendScoreBadge(td, r.rating, r.rating_grade);
        break;
    }

    tr.appendChild(td);
  });

  return tr;
}

function getFiltered() {
  const q = searchInput.value.trim().toLowerCase();
  if (!q) return allRows;
  return allRows.filter((r) =>
    (r.name || '').toLowerCase().includes(q) ||
    (r.category_name || '').toLowerCase().includes(q) ||
    (r.currency || '').toLowerCase().includes(q) ||
    (r.url || '').toLowerCase().includes(q)
  );
}

function sortRows(rows) {
  const dir = sortDir === 'asc' ? 1 : -1;
  const col = COLUMNS.find((c) => c.key === sortKey);
  const numeric = !!col && !!col.num;

  return rows.slice().sort((a, b) => {
    if (sortKey === 'is_enabled') {
      return ((a.is_enabled ? 1 : 0) - (b.is_enabled ? 1 : 0)) * dir;
    }
    if (numeric) {
      const av = (a[sortKey] === null || a[sortKey] === undefined) ? -Infinity : Number(a[sortKey]);
      const bv = (b[sortKey] === null || b[sortKey] === undefined) ? -Infinity : Number(b[sortKey]);
      return (av - bv) * dir;
    }
    return String(a[sortKey] == null ? '' : a[sortKey])
      .localeCompare(String(b[sortKey] == null ? '' : b[sortKey]), 'ru', { sensitivity: 'base' }) * dir;
  });
}

function render() {
  const rows = sortRows(getFiltered());
  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  if (page > totalPages) page = totalPages;
  if (page < 1) page = 1;

  const start = (page - 1) * pageSize;
  const slice = rows.slice(start, start + pageSize);

  tbody.replaceChildren(...slice.map(trFor));

  for (const th of theadRow.querySelectorAll('th.sortable')) {
    const active = th.dataset.sort === sortKey;
    th.classList.toggle('sorted', active);
    const ind = th.querySelector('.sort-ind');
    if (ind) ind.textContent = active ? SORT_IND[sortDir] : '';
  }

  if (total === 0) {
    pageInfo.textContent = 'Показано 0 из 0';
    pageNum.textContent = 'Стр. 1 из 1';
  } else {
    const from = start + 1;
    const to = Math.min(start + pageSize, total);
    pageInfo.textContent = `Показано ${from}–${to} из ${total}`;
    pageNum.textContent = `Стр. ${page} из ${totalPages}`;
  }

  prevBtn.disabled = page <= 1;
  nextBtn.disabled = page >= totalPages;
}

// ----------------------------------------------------------------------------
// Events
// ----------------------------------------------------------------------------

theadRow.addEventListener('click', (e) => {
  const th = e.target.closest('th.sortable');
  if (!th) return;
  const key = th.dataset.sort;
  if (sortKey === key) {
    sortDir = sortDir === 'asc' ? 'desc' : 'asc';
  } else {
    sortKey = key;
    sortDir = 'desc';
  }
  page = 1;
  render();
});

table.addEventListener('click', (e) => {
  const btn = e.target.closest('.copy-btn');
  if (!btn || !btn.dataset.url) return;
  copyText(btn.dataset.url, btn);
});

searchInput.addEventListener('input', () => {
  page = 1;
  render();
});

pageSizeSelect.addEventListener('change', () => {
  pageSize = Number(pageSizeSelect.value);
  page = 1;
  render();
});

prevBtn.addEventListener('click', () => {
  if (page > 1) { page--; render(); }
});

nextBtn.addEventListener('click', () => {
  if (page < Math.ceil(getFiltered().length / pageSize)) { page++; render(); }
});

// ----------------------------------------------------------------------------
// Data loading
// ----------------------------------------------------------------------------

async function loadData() {
  hideError();
  recordCountEl.textContent = '…';
  lastUpdatedEl.textContent = '…';

  if (window.location.protocol === 'file:') {
    allRows = [];
    recordCountEl.textContent = '0';
    lastUpdatedEl.textContent = '—';
    render();
    showError(
      'Страница открыта напрямую как файл (file://), поэтому браузер блокирует загрузку данных. ' +
      'Запусти локальный сервер, например: "python -m http.server 8000" в папке проекта, и открой http://localhost:8000/, ' +
      'либо тестируй через опубликованный GitHub Pages.'
    );
    return;
  }

  try {
    const { faucetsJson, hist, cfg, lastSnapshotAt } = await loadRealDataFromTurso();
    if (cfg) realConfigCache = cfg;
    const { fetchedAt, rows } = normalizeResponse(faucetsJson);

    if (!Array.isArray(rows) || rows.length === 0) {
      throw new Error('Turso: не удалось извлечь ни одной записи о кране — проверь подключение к БД.');
    }

    let finalRows = rows;
    try {
      if (cfg && hist) {
        const ov = await loadTargetOverrides('prod');
        let peakMap = null;
        try { peakMap = await loadPeakRawBalanceByUrl(); } catch (e) { console.warn('peak balance load failed:', e); }
        finalRows = computeRealRows(rows, hist, cfg, ov, peakMap);
      }
    } catch (e) {
      console.warn('real recompute skipped (using raw faucets from Turso):', e);
    }

    allRows = finalRows;
    recordCountEl.textContent = finalRows.length;
    lastUpdatedEl.textContent = formatTimestamp(lastSnapshotAt || fetchedAt);
    render();

  } catch (err) {
    console.error(err);
    allRows = [];
    recordCountEl.textContent = '0';
    lastUpdatedEl.textContent = '—';
    render();
    showError(err.message || 'Не удалось загрузить данные из Turso.');
  }
}

document.getElementById('refresh-btn').addEventListener('click', loadData);

// NOTE: initial load is deferred to the end of the script (see bottom) so that
// all module-level `let`/`const` are already initialized.

// ============================================================================
// Admin panel: password auth, single Real Mode modal
// ============================================================================

// ----- client-side math (mirror of healthScore.js / ratingCalculator.js) -----
function median(values) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  const nums = values.map(Number).filter((v) => !isNaN(v));
  if (nums.length === 0) return 0;
  nums.sort((a, b) => a - b);
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 === 0 ? (nums[mid - 1] + nums[mid]) / 2 : nums[mid];
}
function round(value, decimals) {
  const p = Math.pow(10, decimals);
  return Math.round((value + Number.EPSILON) * p) / p;
}
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
function ratingFromScore(score, thresholds) {
  if (score == null || score === undefined || isNaN(score)) return { grade: null, score };
  const GRADE_RANK = { A: 0, B: 1, C: 2, D: 3, F: 4 };
  const grades = Object.keys(thresholds || {}).sort((a, b) => ((GRADE_RANK[a] != null ? GRADE_RANK[a] : 99) - (GRADE_RANK[b] != null ? GRADE_RANK[b] : 99)));
  for (const grade of grades) {
    if (score >= thresholds[grade]) return { grade, score };
  }
  return { grade: grades[grades.length - 1] || null, score };
}
function getPointsFromThresholds(value, scale) {
  const thresholds = scale && Array.isArray(scale.thresholds) ? scale.thresholds : [];
  if (value == null || value === undefined || value === '') return 0;
  const v = Number(value);
  if (!isFinite(v)) return 0;
  for (const t of thresholds) {
    let ok = true;
    if (typeof t.min === 'number') ok = ok && (t.exclusive ? v > t.min : v >= t.min);
    if (typeof t.max === 'number') ok = ok && (t.exclusive ? v < t.max : v <= t.max);
    if (ok) return t.points;
  }
  return 0;
}
function ratioValue(actual, expected, fallback) {
  const exp = Number(expected);
  if (exp > 0) return Number(actual) / exp;
  return fallback;
}
function totalCurrentBalance(faucetData) {
  const coinsData = (faucetData && faucetData.coins) || {};
  let total = 0;
  for (const coin of Object.keys(coinsData)) {
    const recent = coinsData[coin].recent_balances || [];
    total += recent.length ? Number(recent[recent.length - 1]) || 0 : 0;
  }
  return total;
}

const clientCalc = {
  calculateHealthScore(faucetData, cryptoPricesUsd) {
    const url = faucetData ? faucetData.url : null;
    const isEnabled = !faucetData || faucetData.is_enabled !== false;
    const coinsData = (faucetData && faucetData.coins) || {};
    const prices = cryptoPricesUsd || {};
    let totalCurrentBalance = 0;
    for (const coin of Object.keys(coinsData)) {
      const recent = coinsData[coin].recent_balances || [];
      totalCurrentBalance += recent.length ? Number(recent[recent.length - 1]) || 0 : 0;
    }
    if (!isEnabled || totalCurrentBalance <= 0) {
      return { url, is_enabled: isEnabled, health_score: 0.0, coins: {}, coins_count: 0, total_usd_median: 0 };
    }
    const coinMetrics = {};
    const rawHealthPct = {};
    let totalUsdMedian = 0;
    for (const coin of Object.keys(coinsData)) {
      const dailyPeaks = coinsData[coin].daily_peaks || [];
      const recentBalances = coinsData[coin].recent_balances || [];
      const price = Number(prices[coin]) || 0;
      const medianVal = median(dailyPeaks);
      const maVal = recentBalances.length
        ? recentBalances.reduce((s, v) => s + (Number(v) || 0), 0) / recentBalances.length
        : 0;
      const healthPct = medianVal > 0 ? Math.min(100.0, (maVal / medianVal) * 100.0) : 0.0;
      const medianUsd = price > 0 ? medianVal * price : 0;
      totalUsdMedian += medianUsd;
      rawHealthPct[coin] = healthPct;
      coinMetrics[coin] = {
        price, median: medianVal, ma: maVal,
        health_pct: round(healthPct, 2), median_usd: medianUsd, weight_pct: 0,
      };
    }
    if (totalUsdMedian <= 0) {
      return { url, is_enabled: isEnabled, health_score: 0.0, coins: coinMetrics, coins_count: Object.keys(coinMetrics).length, total_usd_median: 0 };
    }
    let totalScore = 0;
    for (const coin of Object.keys(coinMetrics)) {
      const weightPct = (coinMetrics[coin].median_usd / totalUsdMedian) * 100.0;
      coinMetrics[coin].weight_pct = round(weightPct, 2);
      totalScore += (rawHealthPct[coin] * weightPct) / 100.0;
    }
    return { url, is_enabled: isEnabled, health_score: round(totalScore, 2), coins: coinMetrics, coins_count: Object.keys(coinMetrics).length, total_usd_median: round(totalUsdMedian, 2) };
  },

  calculateRating(faucetData, healthScoreResult, config) {
    const url = faucetData ? faucetData.url : '';
    const ratingConfig = (config && config.rating) || {};
    const letterThresholds = (config && config.rating_thresholds) || {};
    const weights = ratingConfig.block_weights || {};
    const weightBlock1 = weights.block_1_solvency !== undefined ? weights.block_1_solvency : 0.70;
    const weightBlock2 = weights.block_2_reliability !== undefined ? weights.block_2_reliability : 0.30;
    const uiiRange = ratingConfig.uii || {};
    const uiiMin = uiiRange.min !== undefined ? uiiRange.min : 0.80;
    const uiiMax = uiiRange.max !== undefined ? uiiRange.max : 1.20;
    const block1Max = ratingConfig.block_1_max_points !== undefined ? ratingConfig.block_1_max_points : 100.0;
    const block2Max = ratingConfig.block_2_max_points !== undefined ? ratingConfig.block_2_max_points : 100.0;
    const finalMax = ratingConfig.final_rating_max !== undefined ? ratingConfig.final_rating_max : 100.0;

    const isEnabled = !faucetData || faucetData.is_enabled !== false;
    const zeroResult = () => ({
      url,
      final_rating: 0.0,
      letter_grade: 'F',
      base_rating: 0.0,
      overall_health_pct: 0,
      block_1: { score: 0.0, weighted: 0.0, details: { daily_volume_pts: 0, health_pts: 0, activity_pts: 0 } },
      block_2: { score: 0.0, weighted: 0.0, details: { age_pts: 0, payout_type_pts: 0, gateways_pts: 0 } },
      uii_applied: round(clamp(Number(faucetData && faucetData.uii) || 1.0, uiiMin, uiiMax), 2),
    });
    if (!isEnabled || totalCurrentBalance(faucetData) <= 0) return zeroResult();

    const payouts = (faucetData && faucetData.payouts) || {};
    const volMedian = median(payouts.daily_volume_usd_7d_medians);
    const dailyVolumePts = getPointsFromThresholds(volMedian, ratingConfig.daily_volume_usd);
    const overallHealth = median(faucetData.daily_health_medians_7d);
    const healthPts = getPointsFromThresholds(overallHealth, ratingConfig.health_score);
    const hoursSince = payouts.hours_since_last_payout;
    const activityPts = getPointsFromThresholds(hoursSince, ratingConfig.payout_activity_hours);

    const block1Raw = dailyVolumePts + healthPts + activityPts;
    const block1Score = Math.min(block1Max, block1Raw);

    const agePts = getPointsFromThresholds(faucetData.age_months, ratingConfig.age_months);
    const payoutTypeMap = ratingConfig.payout_type || {};
    const ptRaw = faucetData.payout_type;
    const payoutTypePts = (ptRaw == null || ptRaw === '') ? 0
      : (payoutTypeMap[String(ptRaw).toLowerCase()] !== undefined
        ? payoutTypeMap[String(ptRaw).toLowerCase()]
        : (payoutTypeMap.manual !== undefined ? payoutTypeMap.manual : 10.0));
    const gatewaysPts = getPointsFromThresholds(faucetData.gateways_count !== undefined ? faucetData.gateways_count : 0, ratingConfig.gateways_count);

    const block2Raw = agePts + payoutTypePts + gatewaysPts;
    const block2Score = Math.min(block2Max, block2Raw);

    const baseRating = block1Score * weightBlock1 + block2Score * weightBlock2;
    const uiiApplied = clamp(Number(faucetData.uii) || 1.0, uiiMin, uiiMax);
    const finalRating = Math.min(finalMax, baseRating * uiiApplied);

    return {
      url,
      final_rating: round(finalRating, 2),
      letter_grade: ratingFromScore(finalRating, letterThresholds).grade,
      base_rating: round(baseRating, 2),
      overall_health_pct: round(overallHealth, 2),
      block_1: {
        score: round(block1Score, 2),
        weighted: round(block1Score * weightBlock1, 2),
        details: { daily_volume_pts: dailyVolumePts, health_pts: healthPts, activity_pts: activityPts },
      },
      block_2: {
        score: round(block2Score, 2),
        weighted: round(block2Score * weightBlock2, 2),
        details: { age_pts: agePts, payout_type_pts: payoutTypePts, gateways_pts: gatewaysPts },
      },
      uii_applied: round(uiiApplied, 2),
    };
  },
};

// client-side recompute of daily_health_medians_7d from coin balances/peaks
function recomputeDailyHealth(faucet, prices, retention) {
  const coins = faucet.coins || {};
  const coinKeys = Object.keys(coins);
  if (coinKeys.length === 0) { faucet.daily_health_medians_7d = []; return; }
  let maxDays = 0;
  coinKeys.forEach((c) => { maxDays = Math.max(maxDays, (coins[c].daily_peaks || []).length); });
  if (maxDays === 0) { faucet.daily_health_medians_7d = []; return; }
  const medians = {};
  let totalMedUsd = 0;
  coinKeys.forEach((c) => {
    const m = median(coins[c].daily_peaks || []);
    medians[c] = m;
    totalMedUsd += m * (Number(prices[c]) || 0);
  });
  const days = [];
  for (let i = 0; i < maxDays; i++) {
    let num = 0, den = 0;
    coinKeys.forEach((c) => {
      const peaks = coins[c].daily_peaks || [];
      const peak = peaks[i];
      if (peak === undefined) return;
      const price = Number(prices[c]) || 0;
      const ma = (coins[c].recent_balances || []).reduce((s, v) => s + (Number(v) || 0), 0) / Math.max(1, (coins[c].recent_balances || []).length);
      const pct = peak > 0 ? Math.min(100, (ma / peak) * 100) : 0;
      const w = medians[c] * price;
      num += pct * w; den += w;
    });
    days.push(round(den > 0 ? num / den : 0, 2));
  }
  faucet.daily_health_medians_7d = days.slice(-(retention || 7));
}

// ----- helpers -----
function normUrl(u) {
  return String(u || '').trim().toLowerCase().replace(/\/+$/, '');
}
function primaryCoin(f) {
  if (!f || !f.coins) return null;
  const ks = Object.keys(f.coins);
  return ks.length ? ks[0] : null;
}
function escapeAttr(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function sectionTitle(t) {
  const d = document.createElement('div');
  d.className = 'section-title';
  d.textContent = t;
  return d;
}
function readonlyPair(l1, v1, l2, v2) {
  const d = document.createElement('div');
  d.className = 'admin-grid';
  d.innerHTML =
    `<div class="admin-grid-cell"><label>${l1}</label><input class="admin-input num" value="${v1 != null ? v1 : ''}" style="width:90px" disabled/></div>` +
    `<div class="admin-grid-cell"><label>${l2}</label><input class="admin-input num" value="${v2 != null ? v2 : ''}" style="width:90px" disabled/></div>`;
  return d;
}

// Merge moderation (single home: config.targets) onto a snapshot record.
function mergeModeration(historyFaucet, target) {
  const out = Object.assign({}, historyFaucet);
  if (target) {
    ['is_enabled', 'age_months', 'payout_type', 'gateways_count', 'uii', 'label'].forEach((k) => {
      if (target[k] !== undefined) out[k] = target[k];
    });
  }
  return out;
}
// ----- session (password + Turso Admin Key, with explicit expiry) -----
// A single session bundles the panel password AND the Full-Access Turso token.
// It expires after SESSION_TTL_MS; on expiry the UI must re-prompt for BOTH
// (so DB writes never fail silently). Nothing is stored in localStorage.
const SESSION_KEY = 'faucet-monitor-session';
const SESSION_TTL_MS = 1440 * 60 * 1000; // 1440 minutes

function getSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s || s.authed !== true) return null;
    if (typeof s.expiresAt !== 'number' || Date.now() > s.expiresAt) return null;
    return s;
  } catch (e) { return null; }
}
function isSessionExpired() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return true;
    const s = JSON.parse(raw);
    return !s || s.authed !== true || typeof s.expiresAt !== 'number' || Date.now() > s.expiresAt;
  } catch (e) { return true; }
}
function setSession(adminKey, ttlMs) {
  const now = Date.now();
  const s = { authed: true, adminKey: adminKey || '', createdAt: now, expiresAt: now + (ttlMs || SESSION_TTL_MS) };
  try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch (e) {}
  sessionExpiredToastShown = false;
}
function clearSession() { try { sessionStorage.removeItem('faucet-monitor-session'); } catch (e) {} }
function isAuthed() { return !!getSession(); }

let sessionExpiredToastShown = false;
let lastOpenedAdmin = null;
function startSessionWatcher() {
  setInterval(() => {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) { sessionExpiredToastShown = false; return; }
    let s = null; try { s = JSON.parse(raw); } catch (e) {}
    if (!s || s.authed !== true || Date.now() > s.expiresAt) {
      if (!sessionExpiredToastShown) {
        sessionExpiredToastShown = true;
        const hasAdminOpen = Array.from(document.querySelectorAll('#admin-root .modal-overlay')).some((o) => o.querySelector('#modal-tab-body'));
        if (!hasAdminOpen) {
          showToast('Сессия истекла. Введите пароль и ключ доступа к БД заново.', 'error', null, true);
        }
      }
      clearSession();
      sessionExpiredToastShown = false;
      setTimeout(() => {
        if (isAuthed()) return;
        const open = Array.from(document.querySelectorAll('#admin-root .modal-overlay'));
        if (!open.length) return;
        if (open.some((o) => o.querySelector('#login-password'))) return;
        const type = lastOpenedAdmin;
        open.forEach((o) => o.remove());
        openLoginModal({ expired: true }, (ok) => {
          if (ok && type === 'real') openRealAdmin();
        });
      }, 1000);
    } else {
      sessionExpiredToastShown = false;
    }
  }, 30000);
}

// Login requires BOTH the panel password and the Turso Full-Access key, so a
// single re-auth restores both the UI session and DB write capability.
function openLoginModal(opts, cb) {
  opts = opts || {};
  const root = document.getElementById('admin-root');
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  const title = opts.expired ? '🔒 Сессия истекла' : (opts.writing ? '🔑 Доступ к БД' : '🔒 Вход в панель');
  const hint = opts.expired
    ? 'Сессия завершена. Введите пароль и ключ доступа к БД (Turso Admin Key, Full-Access) заново, чтобы продолжить.'
    : (opts.writing
      ? 'Для записи в БД нужны пароль и ключ доступа к БД (Turso Admin Key, Full-Access).'
      : 'Введите пароль и ключ доступа к БД для входа в панель управления.');
  overlay.innerHTML =
    '<div class="modal modal-sm">' +
      '<div class="modal-header"><span>' + title + '</span><button class="modal-close" data-close>✕</button></div>' +
      '<div class="modal-body">' +
        '<p class="modal-hint">' + hint + '</p>' +
        '<label style="display:block;margin:8px 0 4px;font-size:13px">Пароль</label>' +
        '<input type="password" class="admin-input" id="login-password" placeholder="Пароль" autocomplete="off" />' +
        '<label style="display:block;margin:10px 0 4px;font-size:13px">Ключ доступа к БД (Turso Admin Key)</label>' +
        '<input type="password" class="admin-input" id="login-key" placeholder="eyJ..." autocomplete="off" />' +
        '<div class="modal-error" id="login-error" hidden></div>' +
      '</div>' +
      '<div class="modal-footer">' +
        '<button class="btn" id="login-cancel">Отмена</button>' +
        '<button class="btn btn-primary" id="login-ok">Войти</button>' +
      '</div>' +
    '</div>';
  root.appendChild(overlay);
  if (opts.expired) {
    const modalEl = overlay.querySelector('.modal');
    setTimeout(() => {
      if (modalEl) showToast('Сессия истекла. Введите пароль и ключ доступа к БД заново.', 'error', modalEl, false, true);
    }, 60);
  }
  const pw = overlay.querySelector('#login-password');
  const key = overlay.querySelector('#login-key');
  const err = overlay.querySelector('#login-error');
  setTimeout(() => pw.focus(), 50);
  function close() { overlay.remove(); }
  function submit() {
    const expected = (window.AUTH_CONFIG && window.AUTH_CONFIG.password) || 'admin123';
    if (pw.value !== expected) {
      err.textContent = 'Неверный пароль'; err.hidden = false; pw.value = ''; pw.focus();
      showToast('Неверный пароль', 'error');
      return;
    }
    if (!key.value.trim()) {
      err.textContent = 'Введите ключ доступа к БД'; err.hidden = false; key.focus();
      showToast('Введите ключ доступа к БД', 'error');
      return;
    }
    setSession(key.value.trim());
    close(); cb(true);
  }
  overlay.querySelector('#login-ok').addEventListener('click', submit);
  overlay.querySelector('#login-cancel').addEventListener('click', () => { close(); cb(false); });
  overlay.querySelector('.modal-close').addEventListener('click', () => { close(); cb(false); });
  pw.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  key.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) { close(); cb(false); } });
}

function requireAuth() {
  if (isAuthed()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const expired = isSessionExpired();
    openLoginModal({ expired }, (ok) => resolve(ok));
  });
}

// ----- toast -----
function showToast(msg, type, anchor, centered, anchorBelow) {
  console.log('[TOAST]', type || 'info', msg);
  const t = document.createElement('div');
  t.className = 'toast toast-' + (type || 'info');
  t.textContent = msg;
  const base = 'opacity:1 !important;visibility:visible !important;display:block !important;pointer-events:auto !important;position:fixed;z-index:2147483647;box-sizing:border-box;';
  if (anchor && typeof anchor.getBoundingClientRect === 'function') {
    const r = anchor.getBoundingClientRect();
    if (r.width || r.height) {
      const vw = window.innerWidth || document.documentElement.clientWidth;
      const cx = r.left + r.width / 2;
      const left = Math.max(200, Math.min(cx, vw - 200));
      let pos;
      if (anchorBelow) {
        // Pop up directly BELOW the anchor with a small gap.
        pos = 'top:' + (r.bottom + 10) + 'px;transform:translate(-50%,0) !important;';
      } else {
        // Pop up directly ABOVE the anchor with a small gap.
        pos = 'top:' + (r.top - 10) + 'px;transform:translate(-50%,-100%) !important;';
      }
      t.setAttribute('style', base + 'margin:0;max-width:440px;left:' + left + 'px;' + pos);
      (document.body || document.documentElement).appendChild(t);
      setTimeout(() => { if (t && t.parentNode) t.parentNode.removeChild(t); }, 3500);
      return t;
    }
  }
  if (centered) {
    // Shown dead-center of the viewport (e.g. session-expired), so it can't be
    // clipped behind the bottom edge like the corner toast-host.
    t.setAttribute('style', base + 'margin:0;max-width:90vw;text-align:center;left:50% !important;top:50% !important;transform:translate(-50%,-50%) !important;font-size:15px;font-weight:600;box-shadow:0 8px 30px rgba(0,0,0,0.45);');
    (document.body || document.documentElement).appendChild(t);
    setTimeout(() => { if (t && t.parentNode) t.parentNode.removeChild(t); }, 3500);
    return t;
  }
  let host = document.getElementById('toast-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toast-host';
    host.setAttribute('style', 'position:fixed !important;left:0 !important;right:0 !important;bottom:18px !important;top:auto !important;display:flex !important;flex-direction:column !important;align-items:flex-end !important;gap:8px !important;z-index:2147483647 !important;pointer-events:none !important;');
    (document.body || document.documentElement).appendChild(host);
  }
  t.setAttribute('style', base + 'margin:4px 18px;');
  host.appendChild(t);
  setTimeout(() => { if (t && t.parentNode) t.parentNode.removeChild(t); }, 3500);
  return t;
}

// ----- download -----
function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 100);
}

// ----- data loaders -----
let realConfigCache = null;

async function fetchJson(url) {
  const res = await fetch(url + '?t=' + Date.now(), { cache: 'no-store' });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' для ' + url);
  return res.json();
}

// ---------------------------------------------------------------------------
// Turso (read-only, browser) — Real Mode data source.
// ---------------------------------------------------------------------------
function toTursoArg(v) {
  if (v === null || v === undefined) return { type: 'null' };
  if (typeof v === 'number') {
    return Number.isInteger(v) ? { type: 'integer', value: v } : { type: 'real', value: v };
  }
  if (typeof v === 'boolean') return { type: 'integer', value: v ? 1 : 0 };
  return { type: 'text', value: String(v) };
}

// Idempotent: already-wrapped Turso args ({type, value}) pass through untouched,
// raw values get wrapped. Prevents double-wrapping (which turned params into
// '[object Object]' and broke WHERE clauses like `mode = 'prod'`).
function normArg(v) {
  if (v && typeof v === 'object' && typeof v.type === 'string' && 'value' in v) return v;
  return toTursoArg(v);
}

async function queryTurso(sql, args) {
  const token = (typeof window !== 'undefined' && window.__TURSO_TOKEN) || TURSO_READONLY_TOKEN;
  const stmt = args ? { sql, args: args.map(normArg) } : { sql };
  const res = await fetch(`${TURSO_DB_URL}/v2/pipeline`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ requests: [{ type: 'execute', stmt }, { type: 'close' }] }),
  });
  if (!res.ok) throw new Error('Turso HTTP ' + res.status);
  const data = await res.json();
  if (data.error) throw new Error('Turso error: ' + (data.error.message || data.error));
  const exec = data.results && data.results[0];
  if (!exec || exec.type !== 'ok' || !exec.response || !exec.response.result) return [];
  const result = exec.response.result;
  const cols = (result.cols || []).map((c) => c.name);
  const rows = result.rows || [];
  return rows.map((row) => {
    const obj = {};
    cols.forEach((c, i) => { obj[c] = row[i] ? row[i].value : null; });
    return obj;
  });
}

// Smart read: when an admin session is active we read from the PRIMARY (the
// same database the writes go to) so the UI reflects just-saved data instead of
// a possibly-lagging read-only replica. Falls back to the read-only token when
// no session key is present (public, logged-out view).
async function readTurso(sql, args) {
  if (getTursoAdminKey()) {
    try { return await tursoAdminQuery(sql, args); }
    catch (e) { console.warn('primary read failed, falling back to read-only:', e.message); }
  }
  return queryTurso(sql, args);
}

// Latest CURRENT_HEALTH (raw_hourly.health_score) per faucet URL — used to fill
// the main Real Mode table's "Health Score" column from the raw snapshots.
// The simplified Health Score is recomputed LIVE here (over the faucet's full raw
// history) with the current business rules, so the main table always reflects the
// latest logic immediately — without depending on a separate DB backfill.
async function loadLatestRawHealthByUrl() {
  const out = new Map();
  const rows = await queryTurso('SELECT url, snapshot_at, health_score, coins_json, prices_json FROM raw_hourly ORDER BY url, snapshot_at DESC');
  const byUrl = new Map();
  for (const r of (rows || [])) {
    const u = normUrl(r.url);
    if (!byUrl.has(u)) byUrl.set(u, []);
    byUrl.get(u).push({
      snapshot_at: r.snapshot_at,
      coins: JSON.parse(r.coins_json || '[]'),
      prices: JSON.parse(r.prices_json || '{}'),
      stored_health: r.health_score != null ? Number(r.health_score) : null,
    });
  }
  for (const [u, snaps] of byUrl) {
    const latest = snaps[0]; // DESC order -> first row is the latest snapshot
    const series = computeRawHealthSeries(snaps);
    let hs = series.healthByAt[latest.snapshot_at];
    if (hs == null) hs = latest.stored_health;
    let bal = 0;
    for (const c of latest.coins) bal += (Number(c.balance) || 0) * (Number(latest.prices[c.symbol]) || 0);
    const paid = latest.coins.length ? (Number(latest.coins[0].total_users_paid) || 0) : 0;
    out.set(u, {
      health_score: hs != null ? hs : null,
      current_capital: bal,
      total_users_paid: Math.round(paid),
    });
  }
  return out;
}

// All-time peak TOTAL_BALANCE (USD) per URL — mirrors the bright-orange "пик"
// number shown in the "Сырые данные" TOTAL_BALANCE column. Used to populate the
// main table's "Пик 7d (USD)" column.
async function loadPeakRawBalanceByUrl() {
  const out = new Map();
  const rows = await queryTurso('SELECT url, coins_json, prices_json FROM raw_hourly');
  for (const r of (rows || [])) {
    const u = normUrl(r.url);
    const coins = JSON.parse(r.coins_json || '[]');
    const prices = JSON.parse(r.prices_json || '{}');
    const tb = snapshotTotalUsd(coins, prices);
    const cur = out.get(u);
    if (cur === undefined || tb > cur) out.set(u, tb);
  }
  return out;
}

async function loadRealDataFromTurso() {
  const cfgRows = await readTurso("SELECT data FROM configs WHERE mode='prod'");
  const cfg = cfgRows.length ? JSON.parse(cfgRows[0].data) : null;

  const faucetRows = await readTurso(
    "SELECT raw_json, health_score, rating, rating_grade FROM faucets WHERE mode='prod'"
  );
  const listData = faucetRows.map((r) => {
    const base = JSON.parse(r.raw_json);
    return Object.assign({}, base, {
      health_score: r.health_score != null ? Number(r.health_score) : null,
      rating: r.rating != null ? Number(r.rating) : null,
      rating_grade: r.rating_grade != null ? r.rating_grade : null,
    });
  });
  // Health Score column = latest CURRENT_HEALTH from raw_hourly (the "Сырые данные"
  // CURRENT_HEALTH). Overrides the DB faucets.health_score so the main table always
  // reflects the latest snapshot immediately, regardless of pipeline timing.
  try {
    const latest = await loadLatestRawHealthByUrl();
    for (const r of listData) {
      const v = latest.get(normUrl(r.url));
      if (!v) { r.health_score = null; continue; }
      if (v.health_score != null) r.health_score = v.health_score;
      if (v.current_capital != null) r.current_capital = round(v.current_capital, 2);
      if (v.total_users_paid != null) r.total_users_paid = v.total_users_paid;
    }
  } catch (e) { console.warn('latest raw override failed:', e); }
  const fetchedAt = (cfg && cfg.updated_at) || new Date().toISOString();
  const faucetsJson = { fetched_at: fetchedAt, data: { list_data: listData } };

  const histRows = await queryTurso('SELECT url, data FROM history_faucets');
  const hist = {
    crypto_prices_usd: (cfg && cfg.crypto_prices_usd) || {},
    retention_days: (cfg && cfg.settings && cfg.settings.history_retention_days) || 7,
    updated_at: (cfg && cfg.updated_at) || null,
    faucets: histRows.map((r) => JSON.parse(r.data)),
  };
  // Latest history snapshot time (the "Обновлено" badge should reflect this, not
  // the moment the page fetched the data).
  let lastSnapshotAt = null;
  try {
    const sn = await queryTurso('SELECT MAX(snapshot_at) AS mx FROM raw_hourly');
    if (sn && sn.length && sn[0].mx) lastSnapshotAt = sn[0].mx;
  } catch (e) { console.warn('last snapshot query failed:', e); }
  return { faucetsJson, hist, cfg, lastSnapshotAt };
}

// NEW, parallel Health Score for the raw-data tab. Computed EXCLUSIVELY from
// raw_hourly snapshots (each coin's `balance`), independent of the existing
// history_faucets / recomputeDailyHealth / calculateHealthScore paths. raw_hourly
// stores per-snapshot `balance` (no separate peak column). The BASELINE (эталон)
// is the MEDIAN OF PER-DAY PEAK balances (max balance seen each calendar day over
// the 7-day window). The health is the CURRENT balance compared directly against
// that daily-peak baseline (эталон) — no averaging with the previous snapshot.
//   prevSnaps: prior raw snapshots (ascending), each { snapshot_at, coins:[{symbol,balance}], prices:{sym:rate} }
//   curSnap:   the snapshot being scored.
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

// SIMPLIFIED Health Score (CURRENT_HEALTH) с доп. бизнес-правилами поверх базовой
// формулы. peakUsd = абсолютный пик общего баланса (всегда >= totalUsd; это
// "max Баланс 7D" / ЭТАЛОН). Правила:
//   1) peakUsd < 0.01 И totalUsd < 0.01 -> 0
//   3) 0.01 <= peakUsd < 1            -> base * peakUsd
//   4) peakUsd >= 1                   -> base
// base = round(min(100, (totalUsd / peakUsd) * 100)). Возвращает целое HS.
function computeSimplifiedHealthScore(totalUsd, peakUsd) {
  const t = Number(totalUsd) || 0;
  const peak = Number(peakUsd) || 0;
  const base = peak > 0 ? Math.round(Math.min(100, (t / peak) * 100)) : 0;
  if (peak < 0.01 && t < 0.01) return 0;
  if (peak >= 1) return base;
  if (peak >= 0.01) return Math.round(base * peak);
  return 0;
}

// ЭТАЛОН = абсолютный пик суммарного баланса в USD за ВЕСЬ период истории
// (все снимки до расчётной строки ВКЛЮЧИТЕЛЬНО с текущей). Health Score =
// текущий суммарный баланс в USD / эталон × 100. Возвращает { totalByAt, healthByAt }
// для всех переданных снимков (в хронологическом порядке).
function computeRawHealthSeries(history) {
  const sorted = (history || []).slice().sort((a, b) =>
    a.snapshot_at < b.snapshot_at ? -1 : a.snapshot_at > b.snapshot_at ? 1 : 0);
  const totalByAt = {};
  const healthByAt = {};
  let runningMax = 0;
  for (const h of sorted) {
    const t = snapshotTotalUsd(h.coins, h.prices);
    if (t > runningMax) runningMax = t;
    totalByAt[h.snapshot_at] = t;
    healthByAt[h.snapshot_at] = computeSimplifiedHealthScore(t, runningMax);
  }
  // peakValue = абсолютный пик баланса в USD за всю историю (эталон). Строки, чей
  // TOTAL_BALANCE равен ему, подсвечиваются оранжевым.
  return { totalByAt, healthByAt, peakValue: runningMax };
}

// "Медиана HS" считается ДИНАМИЧЕСКИ для каждого снимка (строки) отдельно — это
// скользящая медиана пиковых (максимальных) значений Health Score ("Current health")
// по дням. Для снимка в день D берём: (1) бегущий пик HS внутри текущего дня D
// нарастающим итогом ДО и ВКЛЮЧАЯ этот снимок; (2) полный пик HS каждого
// ПРЕДЫДУЩЕГО дня (дней строго раньше D). Медиана этого набора пиков, округлённая
// до ближайшего целого, — значение именно для строки этого снимка. Использует
// healthByAt (тот же HS, что в колонке "Current health").
function medianOf(arr) {
  const vals = (arr || []).filter((v) => v != null).slice().sort((a, b) => a - b);
  if (!vals.length) return null;
  const n = vals.length;
  const med = (n % 2 === 1) ? vals[(n - 1) / 2] : (vals[n / 2 - 1] + vals[n / 2]) / 2;
  return Math.round(med);
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
  // Для каждого дня D — список полных пиков всех дней СТРОГО раньше D.
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

// Load the FULL raw_hourly history for a faucet (all available snapshots, oldest
// first) so the simplified Health Score uses the absolute peak over the ENTIRE
// history period (not a sliding window).
async function loadRawFullHistory(url) {
  const rows = await queryTurso(
    'SELECT snapshot_at, coins_json, prices_json, health_score FROM raw_hourly WHERE url = ? ORDER BY snapshot_at ASC',
    [normUrl(url)]
  );
  const out = [];
  for (const r of (rows || [])) {
    out.push({
      snapshot_at: r.snapshot_at,
      coins: JSON.parse(r.coins_json || '[]'),
      prices: JSON.parse(r.prices_json || '{}'),
      health_score: r.health_score != null ? Number(r.health_score) : null,
    });
  }
  return out;
}

// Load full raw hourly snapshots for a faucet + day from Turso raw_hourly.
async function loadRawSnapshots(url, day) {
  const rows = await queryTurso(
    'SELECT snapshot_at, coins_json, prices_json FROM raw_hourly WHERE url = ? AND day = ? ORDER BY snapshot_at ASC',
    [normUrl(url), day]
  );
  return (rows || []).map((r) => ({
    snapshot_at: r.snapshot_at,
    coins: JSON.parse(r.coins_json || '[]'),
    prices: JSON.parse(r.prices_json || '{}'),
  }));
}

// Distinct faucet URLs that actually have raw snapshots in raw_hourly. This is
// the authoritative source for the "Сырые данные API" dropdown so every faucet
// that produced data is selectable (and not just whatever happens to be in the
// faucets table).
async function loadRawFaucetUrls() {
  try {
    const rows = await queryTurso('SELECT DISTINCT url FROM raw_hourly ORDER BY url ASC');
    return (rows || []).map((r) => r.url).filter(Boolean);
  } catch (e) {
    return [];
  }
}
// The Full-Access Turso token lives inside the session object (setSession),
// never in localStorage, so password + DB key share one expiry.
function getTursoAdminKey() {
  const s = getSession();
  return s ? (s.adminKey || '') : '';
}

// Save a config object to Turso (requires the Full-Access Admin Key).
async function saveConfigToTurso(mode, config) {
  const token = getTursoAdminKey();
  if (!token) throw new Error('Turso Admin Key (Full-Access token) не введён — сессия истекла.');
  const V = (v) => ({ type: 'text', value: String(v) });
  const sql =
    "INSERT INTO configs (mode, data, updated_at) VALUES (?, ?, ?) " +
    "ON CONFLICT(mode) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at";
  const res = await fetch(`${TURSO_DB_URL}/v2/pipeline`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({
      requests: [{ type: 'execute', stmt: { sql, args: [V(mode), V(JSON.stringify(config)), V(new Date().toISOString())] } }, { type: 'close' }],
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error('Turso write error: ' + (data.error.message || data.error));
  const r0 = data.results && data.results[0];
  if (!r0 || r0.type !== 'ok') throw new Error('Turso write failed');
  return true;
}

// Generic write against Turso with the Full-Access Admin Key (used for DELETE etc.).
async function tursoAdminWrite(sql, args) {
  const token = getTursoAdminKey();
  if (!token) throw new Error('Turso Admin Key (Full-Access token) не введён — сессия истекла.');
  const V = (v) => ({ type: 'text', value: v === null || v === undefined ? null : String(v) });
  const stmtArgs = (args || []).map(V);
  const res = await fetch(`${TURSO_DB_URL}/v2/pipeline`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ requests: [{ type: 'execute', stmt: { sql, args: stmtArgs } }, { type: 'close' }] }),
  });
  const data = await res.json();
  if (data.error) throw new Error('Turso write error: ' + (data.error.message || data.error));
  const r0 = data.results && data.results[0];
  if (!r0 || r0.type !== 'ok') throw new Error('Turso write failed');
  return true;
}

// Explicit per-row delete from the live faucets table (no orphan/musor rows).
async function deleteFaucetFromTurso(id, mode) {
  return tursoAdminWrite('DELETE FROM faucets WHERE id = ? AND mode = ?', [id, mode]);
}

// Delete every faucet row that belongs to a URL (id = normalized_url + '|' + CURRENCY).
async function deleteFaucetsByUrlFromTurso(url, mode) {
  const prefix = normUrl(url) + '|';
  const rows = await queryTurso('SELECT id FROM faucets WHERE mode = ? AND id LIKE ?', [
    { type: 'text', value: mode },
    { type: 'text', value: prefix + '%' },
  ]);
  let deleted = 0;
  for (const r of rows) {
    await deleteFaucetFromTurso(r.id, mode);
    deleted++;
  }
  return deleted;
}

// Read via the Full-Access Admin Key (hits the primary — no replica lag for verification).
async function tursoAdminQuery(sql, args) {
  const token = getTursoAdminKey();
  if (!token) throw new Error('Turso Admin Key (Full-Access token) не введён — сессия истекла.');
  const V = (v) => ({ type: 'text', value: v === null || v === undefined ? null : String(v) });
  const stmt = args ? { sql, args: args.map(normArg) } : { sql };
  const res = await fetch(`${TURSO_DB_URL}/v2/pipeline`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ requests: [{ type: 'execute', stmt }, { type: 'close' }] }),
  });
  if (!res.ok) throw new Error('Turso HTTP ' + res.status);
  const data = await res.json();
  if (data.error) throw new Error('Turso error: ' + (data.error.message || data.error));
  const exec = data.results && data.results[0];
  if (!exec || exec.type !== 'ok' || !exec.response || !exec.response.result) return [];
  const result = exec.response.result;
  const cols = (result.cols || []).map((c) => c.name);
  return (result.rows || []).map((row) => {
    const obj = {};
    cols.forEach((c, i) => { obj[c] = row[i] ? row[i].value : null; });
    return obj;
  });
}

// Compare two configs ignoring volatile timestamps.
function normalizeConfigForCompare(cfg) {
  const c = JSON.parse(JSON.stringify(cfg || {}));
  if (c.updated_at) delete c.updated_at;
  if (c.settings && c.settings.updated_at) delete c.settings.updated_at;
  return c;
}

// Write the config to Turso, then read it back from the primary to confirm 100% landed.
// Resolves true only if the saved data matches exactly what was sent.
async function saveAndVerifyConfigToTurso(mode, config) {
  await saveConfigToTurso(mode, config);
  const rows = await tursoAdminQuery('SELECT data FROM configs WHERE mode = ?', [mode]);
  if (!rows.length) throw new Error('Запись не найдена в БД после сохранения');
  const saved = JSON.parse(rows[0].data);
  const a = JSON.stringify(normalizeConfigForCompare(config));
  const b = JSON.stringify(normalizeConfigForCompare(saved));
  if (a !== b) throw new Error('Сохранённые данные не совпадают с отправленными');
  return true;
}

// ---- Per-faucet target overrides: surgical point edits (only changed rows are written) ----
let realTargetOverrides = new Map();      // normUrl(url) -> override object
let realTargetOverridesDirty = new Set(); // normUrl(url) keys pending save
let realConfigDirty = false; // formula/config edits pending save

function onFormulaChange() { realConfigDirty = true; refreshFormulaBadges(); }

async function loadTargetOverrides(mode) {
  const map = new Map();
  try {
    const rows = await readTurso('SELECT url, data FROM faucet_target_overrides WHERE mode = ?', [{ type: 'text', value: mode }]);
    rows.forEach((r) => { try { map.set(normUrl(r.url), JSON.parse(r.data)); } catch (e) {} });
  } catch (e) { console.warn('overrides load failed', e); }
  return map;
}

// Write ONLY the dirty override rows. A single pipeline request carries one INSERT/UPSERT
// per edited faucet — never the whole 294-row faucets table, never the full config blob.
async function saveTargetOverridesToTurso(mode, overridesMap, dirtySet) {
  const token = getTursoAdminKey();
  if (!token) throw new Error('Turso Admin Key (Full-Access token) не введён — сессия истекла.');
  const keys = Array.from(dirtySet);
  if (!keys.length) return 0;
  const now = new Date().toISOString();
  const V = (v) => ({ type: 'text', value: v == null ? '' : String(v) });
  const requests = keys.map((key) => {
    const ov = overridesMap.get(key);
    return { type: 'execute', stmt: {
      sql: "INSERT INTO faucet_target_overrides (mode, url, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(mode, url) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at",
      args: [V(mode), V(ov.url || key), V(JSON.stringify(ov)), V(now)],
    } };
  });
  requests.push({ type: 'close' });
  const res = await fetch(`${TURSO_DB_URL}/v2/pipeline`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ requests }),
  });
  const data = await res.json();
  if (data.error) throw new Error('Turso write error: ' + (data.error.message || data.error));
  const errRes = (data.results || []).find((r) => r.type === 'error');
  if (errRes) throw new Error('Turso write error: ' + (errRes.error && (errRes.error.message || JSON.stringify(errRes.error))));
  // Verify only the written (dirty) rows came back intact.
  const inArgs = keys.map((key) => overridesMap.get(key).url || key);
  const placeholders = inArgs.map(() => '?').join(',');
  const check = await tursoAdminQuery(
    `SELECT url, data FROM faucet_target_overrides WHERE mode = ? AND url IN (${placeholders})`,
    [mode, ...inArgs]
  );
  const byUrl = new Map(check.map((r) => [normUrl(r.url), r.data]));
  for (const key of keys) {
    const ov = overridesMap.get(key);
    const saved = byUrl.get(key);
    if (!saved || JSON.stringify(JSON.parse(saved)) !== JSON.stringify(ov)) {
      throw new Error('Сохранённые данные не совпадают с отправленными (' + (ov.url || key) + ')');
    }
  }
  return keys.length;
}

// Ensure a valid session (password + DB key) exists, then run the write action.
// On auth failure or expired session we clear the session and prompt for re-login
// (both password and key) and retry once. Non-auth failures are surfaced via
// handlers.onError so the caller can show a red "write failed" toast. Green
// toasts are fired only by the action itself, i.e. after a confirmed DB OK.
const AUTH_ERR_RE = /auth|token|unauthor|permission|forbidden|401|403|access|invalid|session/i;
async function ensureSessionThen(action, handlers) {
  handlers = handlers || {};
  const run = async () => {
    const s = getSession();
    if (!s || !s.adminKey) throw new Error('Turso Admin Key (Full-Access token) не введён — сессия истекла.');
    await action();
  };
  try {
    await run();
  } catch (e) {
    const msg = (e && e.message) || '';
    if (AUTH_ERR_RE.test(msg)) {
      clearSession();
      const wasExpired = msg.indexOf('сессия истекла') !== -1 || isSessionExpired();
      showToast(wasExpired ? 'Сессия истекла. Введите пароль и ключ доступа к БД заново.' : 'Нужны пароль и ключ доступа к БД', 'error', null, true);
      await promptLoginAndRun(action, handlers);
    } else if (handlers.onError) {
      handlers.onError(e);
    } else {
      throw e;
    }
  }
}

function promptLoginAndRun(action, handlers) {
  return new Promise((resolve) => {
    openLoginModal({ expired: true, writing: true }, async (ok) => {
      if (!ok) { resolve(); return; }
      try {
        await action();
      } catch (e2) {
        if (handlers && handlers.onError) handlers.onError(e2);
        else showToast('Не удалось записать данные в БД', 'error');
      }
      resolve();
    });
  });
}
const DEMO_FAUCET_URLS = new Set([
  'https://stablefaucet.com',
  'https://decliningfaucet.com',
  'https://driedfaucet.com',
  'https://newfaucet.com',
  'https://fluctuatingfaucet.com',
  'https://disabledfaucet.com',
]);

async function safeFetchJson(url) {
  try { return await fetchJson(url); } catch (e) { console.warn('fetch failed for', url, '-', e.message); return null; }
}
function defaultFormulaConfig() {
  return {
    settings: { history_retention_days: 7 },
    crypto_prices_usd: {},
    health: {},
    rating_thresholds: {},
    rating: { block_weights: { block_1_solvency: 0.70, block_2_reliability: 0.30 } },
    targets: [],
  };
}
async function loadRealConfig(forceDisk) {
  // Cloud config is the single source of truth for Real Mode. There is no
  // local .json artifact and no localStorage shadow — everything lives in Turso.
  if (forceDisk) realConfigCache = null;
  try {
    const rows = await readTurso("SELECT data FROM configs WHERE mode='prod'");
    if (rows.length) { realConfigCache = JSON.parse(rows[0].data); return realConfigCache; }
  } catch (e) {
    console.warn('Turso config load failed:', e.message);
  }
  console.warn('Real Mode config unavailable (Turso empty).');
  return null;
}

// Real Mode: enrich raw faucets.json display rows with freshly computed
// Health Score / Rating / Grade using the Real config (targets + formulas)
// and the real snapshots (history_faucets in Turso) — mirrors build_faucets.js enrichFaucets.
function computeRealRows(rawRows, hist, cfg, overridesMap, peakByUrl) {
  const prices = Object.assign({}, cfg.crypto_prices_usd || {}, hist.crypto_prices_usd || {});
  const retention = (cfg.settings && cfg.settings.history_retention_days) || 7;
  const historyByUrl = new Map((hist.faucets || []).map((f) => [normUrl(f.url), f]));
  const overrideByUrl = overridesMap || new Map();
  const resultRows = rawRows.map((row) => {
    const key = normUrl(row.url);
    const override = overrideByUrl.get(key);
    const f = historyByUrl.get(key);

    let merged;
    try {
      if (!f) {
        // No history snapshot yet for this faucet: render with safe defaults so
        // the row still appears (the server seeds its history on the next run).
        const emptyHist = {
          coins: {},
          payouts: { hours_since_last_payout: null, v_3h_actual: 0, v_3h_expected_median: 0, n_3h_actual: 0, n_3h_expected_median: 0, daily_volume_usd_7d_medians: [] },
          daily_health_medians_7d: [],
        };
        merged = mergeModeration(emptyHist, override);
      } else {
        recomputeDailyHealth(f, prices, retention);
        merged = mergeModeration(f, override);
      }
      const healthRes = clientCalc.calculateHealthScore(merged, prices);
      const ratingRes = clientCalc.calculateRating(merged, healthRes, cfg);
      return Object.assign({}, row, {
        health_score: (row.health_score != null ? Number(row.health_score) : null),
        rating: ratingRes.final_rating,
        rating_grade: ratingRes.letter_grade,
        // TOTAL_USERS_PAID = latest raw_hourly snapshot value (from "Сырые данные").
        total_users_paid: (row.total_users_paid != null ? Number(row.total_users_paid) : null),
        // "Пик 7d (USD)" = all-time peak TOTAL_BALANCE from "Сырые данные" (the orange
        // number). Falls back to the 7-day median if the raw peak is unavailable.
        usd_median: (peakByUrl && peakByUrl.has(key)) ? round(peakByUrl.get(key), 2) : healthRes.total_usd_median,
        current_capital: (row.current_capital != null ? Number(row.current_capital) : null),
        // Rating transparency: block scores + applied UII.
        block_1_solvency: ratingRes.block_1 ? ratingRes.block_1.score : null,
        block_2_reliability: ratingRes.block_2 ? ratingRes.block_2.score : null,
        uii: (ratingRes.uii_applied != null) ? ratingRes.uii_applied : null,
        payout_type: merged.payout_type || null,
        paid_today: row.paid_today != null ? Number(row.paid_today) : null,
      });
    } catch (e) {
      return row;
    }
  });
  return resultRows;
}

// ----- modal shell -----
function openModalShell(title, opts) {
  opts = opts || {};
  const root = document.getElementById('admin-root');
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML =
    '<div class="modal">' +
      '<div class="modal-header"><span>' + title + '</span><button class="modal-close" data-close>✕</button></div>' +
      '<div class="modal-tabs" id="modal-tabs"></div>' +
      '<div class="modal-body" id="modal-tab-body"></div>' +
      '<div class="modal-footer" id="modal-footer"></div>' +
    '</div>';
  root.appendChild(overlay);
  const realClose = () => {
    if (overlay._escHandler) document.removeEventListener('keydown', overlay._escHandler);
    overlay.remove();
    if (opts && opts.onClose) opts.onClose();
  };
  if (opts.onRequestClose) {
    const req = () => opts.onRequestClose(realClose);
    overlay.querySelector('[data-close]').addEventListener('click', req);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) req(); });
    overlay._escHandler = (e) => { if (e.key === 'Escape' || e.key === 'Esc') req(); };
    document.addEventListener('keydown', overlay._escHandler);
  } else {
    overlay.querySelector('[data-close]').addEventListener('click', realClose);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) realClose(); });
  }
  return overlay;
}

function showConfirmDialog(opts) {
  const root = document.getElementById('admin-root');
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML =
    '<div class="modal confirm-modal">' +
      '<div class="modal-header"><span>' + (opts.title || 'Подтверждение') + '</span><button class="modal-close" data-close>✕</button></div>' +
      '<div class="modal-body"><p>' + (opts.message || '') + '</p></div>' +
      '<div class="modal-footer">' +
        '<button class="btn" data-no>' + (opts.noLabel || 'Нет') + '</button>' +
        '<button class="btn btn-primary" data-yes>' + (opts.yesLabel || 'Да') + '</button>' +
      '</div>' +
    '</div>';
  root.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('[data-yes]').addEventListener('click', () => { close(); if (opts.onYes) opts.onYes(); });
  overlay.querySelector('[data-no]').addEventListener('click', () => { close(); if (opts.onNo) opts.onNo(); });
  const closeBtn = overlay.querySelector('[data-close]');
  if (closeBtn) closeBtn.addEventListener('click', () => { close(); if (opts.onNo) opts.onNo(); });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) { close(); if (opts.onNo) opts.onNo(); } });
  return overlay;
}

// ----- REAL MODE (editable faucet list) -----
async function openRealAdmin() {
  const overlay = openModalShell('⚙️ Панель Управления', {
    onRequestClose: (realClose) => {
      const hasTargets = !!(realTargetOverridesDirty && realTargetOverridesDirty.size);
      const hasConfig = realConfigDirty === true;
      if (hasTargets || hasConfig) {
        showConfirmDialog({
          title: 'Сохранить изменения?',
          message: 'В панели управления есть несохранённые изменения' +
            (hasTargets ? ' (UII/тип выплат/шлюзы/возраст)' : '') +
            (hasConfig ? ' (параметры формул)' : '') +
            '. Сохранить их в БД перед закрытием?',
          yesLabel: 'Да, сохранить',
          noLabel: 'Нет, выйти',
          onYes: async () => {
            try {
              await ensureSessionThen(async () => {
                if (hasTargets) {
                  await saveTargetOverridesToTurso('prod', realTargetOverrides, realTargetOverridesDirty);
                  realTargetOverridesDirty.clear();
                }
                if (hasConfig) {
                  await saveAndVerifyConfigToTurso('prod', realConfigCache);
                  realConfigDirty = false;
                }
              }, { onError: (err) => { showToast('Не удалось записать данные в БД', 'error'); console.error(err); } });
            } catch (e) { /* ignore close */ }
            realClose();
          },
          onNo: () => {
            realTargetOverridesDirty.clear();
            realConfigDirty = false;
            realClose();
          },
        });
      } else {
        realClose();
      }
    },
  });
  lastOpenedAdmin = 'real';
  const tabsEl = overlay.querySelector('#modal-tabs');
  const bodyEl = overlay.querySelector('#modal-tab-body');
  const footerEl = overlay.querySelector('#modal-footer');

  const realHeader = overlay.querySelector('.modal-header');
  const sessionEndBtn = document.createElement('button');
  sessionEndBtn.className = 'btn btn-session-end';
  sessionEndBtn.textContent = 'Завершить сессию';
  sessionEndBtn.title = 'Принудительно завершить сессию админки';
  sessionEndBtn.style.marginLeft = 'auto';
  sessionEndBtn.style.marginRight = '8px';
  sessionEndBtn.addEventListener('click', () => {
    showConfirmDialog({
      title: 'Завершить сессию',
      message: 'Текущая сессия будет завершена — вы уверены?',
      yesLabel: 'Да, завершить',
      noLabel: 'Отмена',
      onYes: () => {
        clearSession();
        sessionExpiredToastShown = false;
        showToast('Сессия админки завершена. Для продолжения войдите заново.', 'info', null, true);
        if (overlay._escHandler) document.removeEventListener('keydown', overlay._escHandler);
        overlay.remove();
      },
    });
  });
  realHeader.insertBefore(sessionEndBtn, realHeader.querySelector('.modal-close'));

  footerEl.innerHTML =
    '<button class="btn btn-primary" id="real-save-db">💾 Сохранить в БД</button>';
  footerEl.querySelector('#real-save-db').addEventListener('click', (e) => {
    const anchor = e.currentTarget;
    ensureSessionThen(async () => {
      let n = 0;
      let savedConfig = false;
      if (realTargetOverridesDirty && realTargetOverridesDirty.size) {
        n = await saveTargetOverridesToTurso('prod', realTargetOverrides, realTargetOverridesDirty);
        realTargetOverridesDirty.clear();
      }
      if (realConfigDirty) {
        await saveAndVerifyConfigToTurso('prod', realConfigCache);
        realConfigDirty = false;
        savedConfig = true;
      }
      const parts = [];
      if (n) parts.push('Успешно сохранено: ' + n + ' кран(ов)');
      if (savedConfig) parts.push('Параметры формул сохранены');
      if (!n && !savedConfig) parts.push('Нет изменений для сохранения в БД');
      showToast(parts.length ? parts.join(' · ') : 'Сохранено', 'success', anchor);
    }, { anchor, onError: (err) => { showToast('Не удалось записать данные в БД', 'error', anchor); console.error(err); } })
      .then(async () => {
        // Reload from Turso, then re-render the active tab so its inputs rebind
        // to the freshly-loaded config. Without this, the rendered inputs would
        // keep pointing at the old config object and subsequent edits (after a
        // tab switch or a second save) would be lost.
        try {
          if (typeof loadData === 'function') await loadData();
          cfg = realConfigCache;
          selectTab(activeTabId);
        } catch (e) { console.warn('post-save refresh failed', e); }
      });
  });

  const tabs = [
    { id: 'targets', label: 'Общие настройки' },
    { id: 'formulas', label: 'Формулы' },
    { id: 'raw', label: 'Сырые данные API' },
  ];
  tabs.forEach((t, i) => {
    const b = document.createElement('button');
    b.className = 'tab-btn' + (i === 0 ? ' active' : '');
    b.textContent = t.label; b.dataset.tab = t.id;
    b.addEventListener('click', () => selectTab(t.id));
    tabsEl.appendChild(b);
  });
  let activeTabId = 'targets';
  let dataReady = false;
  function selectTab(id) {
    activeTabId = id;
    tabsEl.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === id));
    // "Сохранить в БД" belongs only to the editable Targets tab — hide it on the
    // read-only "Сырые данные API" tab.
    const saveBtn = footerEl.querySelector('#real-save-db');
    if (saveBtn) saveBtn.style.display = (id === 'raw') ? 'none' : '';
    // While data is still loading, just keep the active marker and show the
    // loading placeholder — don't render yet (data isn't ready) and don't force
    // a tab switch once loading finishes.
    if (!dataReady) {
      bodyEl.innerHTML = '<p class="modal-hint">⏳ Загрузка данных из БД…</p>';
      return;
    }
    bodyEl.innerHTML = '';
    if (id === 'targets') renderRealTargets(bodyEl, cfg, realFaucetRows, realTargetOverrides);
    else if (id === 'formulas') renderRealFormulas(bodyEl);
    else if (id === 'raw') renderRealRawData(bodyEl, realFaucetRows, realRawUrls);
  }
  bodyEl.innerHTML = '<p class="modal-hint">⏳ Загрузка данных из БД…</p>';

  // Load data asynchronously — the modal is already visible, so the user isn't
  // blocked waiting on Turso. Render only once everything is ready (and only if
  // the panel hasn't been closed mid-load).
  let cfg;
  try { cfg = await loadRealConfig(); } catch (e) { showToast('Не удалось загрузить конфиг Real Mode: ' + e.message, 'error'); cfg = {}; }
  if (!cfg.targets) cfg.targets = [];
  if (!cfg.rating) cfg.rating = {};
  if (!cfg.rating_thresholds) cfg.rating_thresholds = {};
  if (!overlay.isConnected) return;
  let realFaucetRows = [];
  try {
    const { faucetsJson } = await loadRealDataFromTurso();
    realFaucetRows = normalizeResponse(faucetsJson).rows.filter((r) => r && r.url);
  } catch (e) { console.warn('Real faucet list load failed:', e); }
  if (!overlay.isConnected) return;
  let realRawUrls = [];
  try { realRawUrls = await loadRawFaucetUrls(); } catch (e) { console.warn('Raw URL load failed:', e); }
  if (!overlay.isConnected) return;
  realTargetOverrides = await loadTargetOverrides('prod');
  realTargetOverridesDirty = new Set();
  if (!overlay.isConnected) return;
  dataReady = true;
  selectTab(activeTabId);
}

function renderRealTargets(container, cfg, faucetRows, overrides) {
  const defaults = { is_enabled: true, payout_type: '', gateways_count: 0, age_months: 0, uii: 1.0, comment: '' };
  const baseTarget = (url) => (cfg.targets || []).find((t) => normUrl(t.url) === normUrl(url)) || null;
  container.innerHTML = '';
  const wrap = document.createElement('div');

  const search = document.createElement('input');
  search.type = 'text';
  search.id = 'target-search-input';
  search.placeholder = '🔍 Поиск по URL крана...';
  search.className = 'admin-input';
  search.style.width = '100%';
  search.style.marginBottom = '10px';
  wrap.appendChild(search);

  const table = document.createElement('table');
  table.className = 'admin-table targets-table';
  table.innerHTML = '<thead><tr><th>URL</th><th>Name</th><th>Cur</th><th>UII</th><th>Payout type</th><th>Gateways</th><th>Age (мес.)</th><th>Enabled</th><th>Comment</th></tr></thead>';
  const tb = document.createElement('tbody');
  table.appendChild(tb);
  const tableScroll = document.createElement('div');
  tableScroll.className = 'raw-table-scroll';
  tableScroll.appendChild(table);
  wrap.appendChild(tableScroll);
  container.appendChild(wrap);

  const def = (v, d) => (v != null ? v : d);

  let term = '';
  function renderBody() {
    tb.innerHTML = '';
    const filtered = (faucetRows || []).filter((f) => !term || (f.url || '').toLowerCase().indexOf(term) !== -1);
    filtered.forEach((f) => {
      const key = normUrl(f.url);
      const ov = overrides.get(key) || baseTarget(f.url) || defaults;
      const uii = def(ov.uii, 1.0);
      const pay = def(ov.payout_type, '');
      const gw = def(ov.gateways_count, 0);
      const age = def(ov.age_months, 0);
      const en = ov.is_enabled !== false;
      const cm = def(ov.comment, '');
      const tr = document.createElement('tr');
      tr.innerHTML =
        '<td style="max-width:280px;overflow:hidden;text-overflow:ellipsis" title="' + escapeAttr(f.url || '') + '">' + escapeAttr(f.url || '') + '</td>' +
        '<td>' + escapeAttr(f.name || '') + '</td>' +
        '<td>' + escapeAttr(f.currency || '') + '</td>' +
        '<td><input class="admin-input num" data-f="uii" type="number" min="0.80" max="1.20" step="0.01" value="' + uii + '" style="width:64px"/></td>' +
        '<td><select class="admin-input" data-f="payout_type">' +
          '<option value="">None</option>' +
          '<option value="instant">instant</option><option value="mixed">mixed</option><option value="manual">manual</option>' +
        '</select></td>' +
        '<td><input class="admin-input num" data-f="gateways_count" type="number" min="0" step="1" value="' + gw + '" style="width:64px"/></td>' +
        '<td><input class="admin-input num" data-f="age_months" type="number" min="0" step="1" value="' + age + '" style="width:64px"/></td>' +
        '<td style="text-align:center"><input type="checkbox" data-f="is_enabled" ' + (en ? 'checked' : '') + '/></td>' +
        '<td><input class="admin-input" data-f="comment" value="' + escapeAttr(cm) + '" style="width:140px"/></td>';
      tr.querySelector('[data-f="payout_type"]').value = pay;
      tr.querySelectorAll('.admin-input').forEach((inp) => {
        const fld = inp.dataset.f;
        if (!fld) return;
        inp.addEventListener('input', () => {
          let t = overrides.get(key);
          if (!t) t = Object.assign({ url: f.url }, baseTarget(f.url) || defaults);
          else t = Object.assign({}, t);
          let v = inp.value;
          if (fld === 'uii' || fld === 'gateways_count' || fld === 'age_months') v = v === '' ? null : Number(v);
          if (fld === 'payout_type' && v === '') v = null;
          if (inp.type === 'checkbox') v = inp.checked;
          t[fld] = v;
          overrides.set(key, t);
          realTargetOverridesDirty.add(key);
        });
      });
      tb.appendChild(tr);
    });
    if (!filtered.length) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td colspan="9" style="text-align:center;color:var(--text-dim);padding:14px">Ничего не найдено</td>';
      tb.appendChild(tr);
    }
  }
  search.addEventListener('input', () => { term = search.value.trim().toLowerCase(); renderBody(); });
  renderBody();
}

function hourLabelFromIso(iso) {
  if (!iso) return '—';
  return String(iso).replace('T', ' ').slice(0, 16);
}

// Build the wide "Сырые данные API" table matching faucets_data.xlsx:
//   Время (UTC) | paid_today (USD) | total_users_paid
//   | <COIN> (баланс) | Курс <COIN> (rate in USD)  ... for EVERY coin,
//   including zero-balance ones. The coin universe is the union of all
//   currency rates available at snapshot time (prices_json) and all coins
//   present in the snapshots — this guarantees every FaucetPay currency gets
//   its two columns even when the faucet has a 0 balance for it. The table is
//   wrapped in a horizontally scrollable container because it is very wide.
function buildRawTableHtml(snaps, totalByAt, healthByAt, peakValue, medianArr) {
  const coinOrder = [];
  const coinSet = new Set();
  for (const s of snaps) {
    const prices = s.prices || {};
    // Rates (prices_json) describe the full currency set supported at snapshot
    // time — use them as the canonical source of "all coins".
    for (const k of Object.keys(prices)) {
      if (!coinSet.has(k)) { coinSet.add(k); coinOrder.push(k); }
    }
    for (const c of s.coins) {
      if (!coinSet.has(c.symbol)) { coinSet.add(c.symbol); coinOrder.push(c.symbol); }
    }
  }
  coinOrder.sort();

  let head = '<thead><tr><th>Время (UTC)</th><th>TOTAL_BALANCE (USD)</th><th>Current health</th><th>Медиана HS</th><th>paid_today (USD)</th><th>total_users_paid</th>';
  for (const sym of coinOrder) {
    head += '<th>' + escapeAttr(sym) + '</th><th>Курс ' + escapeAttr(sym) + '</th>';
  }
  head += '</tr></thead>';

  let dayPeak = null;
  for (const s of snaps) {
    const ph = healthByAt[s.snapshot_at];
    if (ph != null && (dayPeak == null || ph > dayPeak)) dayPeak = ph;
  }

  let body = '<tbody>';
  for (let i = 0; i < snaps.length; i++) {
    const s = snaps[i];
    const prices = s.prices || {};
    const coinMap = {};
    for (const c of s.coins) coinMap[c.symbol] = c;

    // paid_today and total_users_paid are BOTH single faucet-level values in
    // the FaucetPay API JSON (the same number repeats on every per-coin record
    // of the faucet). Take them RAW from the first coin — never sum across
    // coins, or the value gets multiplied by the number of coins.
    let paidTodayRaw = 0;
    let totalPaidRaw = 0;
    if (s.coins.length) {
      const first = s.coins[0];
      paidTodayRaw = Number(first.paid_today) || 0;
      totalPaidRaw = Number(first.total_users_paid) || 0;
    }

    const tb = (totalByAt && totalByAt[s.snapshot_at] != null) ? totalByAt[s.snapshot_at] : null;
    const hs = (healthByAt && healthByAt[s.snapshot_at] != null) ? healthByAt[s.snapshot_at] : null;
    const isPeak = tb != null && peakValue != null && tb === peakValue;
    const isHsPeak = hs != null && dayPeak != null && hs === dayPeak;
    let row = '<tr><td>' + escapeAttr(hourLabelFromIso(s.snapshot_at)) + '</td>'
      + '<td class="total-balance-cell' + (isPeak ? ' peak-balance-cell' : '') + '">' + (tb != null ? fmtUsd(tb) : '—') + '</td>'
      + '<td class="health-cell' + (isHsPeak ? ' peak-hs-cell' : '') + '">' + (hs != null ? escapeAttr(String(hs)) : '—') + '</td>'
      + '<td class="median-hs-cell">' + (medianArr && medianArr[i] != null ? escapeAttr(String(medianArr[i])) : '—') + '</td>'
      + '<td>' + escapeAttr(String(paidTodayRaw)) + '</td>'
      + '<td>' + fmtInt(totalPaidRaw) + '</td>';
    for (const sym of coinOrder) {
      const c = coinMap[sym];
      const bal = c ? Number(c.balance) : 0;
      const balStr = isFinite(bal) ? fmtBalance(bal) : '—';
      const p = Number(prices[sym]) || 0;
      row += '<td>' + escapeAttr(balStr) + '</td>'
        + '<td class="rate-cell">' + (p > 0 ? fmtRate(p) : '—') + '</td>';
    }
    row += '</tr>';
    body += row;
  }
  body += '</tbody>';
  return '<div class="raw-table-scroll"><table class="admin-table">' + head + body + '</table></div>';
}

function renderRealRawData(container, faucetRows, rawUrls) {
  container.innerHTML = '';
  const wrap = document.createElement('div');

  const ctrl = document.createElement('div');
  ctrl.style.display = 'flex';
  ctrl.style.gap = '12px';
  ctrl.style.margin = '10px 0';
  ctrl.style.flexWrap = 'wrap';
  ctrl.style.alignItems = 'center';
  ctrl.style.position = 'relative';

  // Build the full set of selectable faucet URLs: every URL that has raw
  // snapshots (already normalized in raw_hourly) plus every URL from the
  // faucets table. Both are normalized before de-duplication so the SAME
  // faucet can never appear twice (e.g. "https://X.com/" vs "https://x.com").
  const urlSet = new Set();
  const allUrls = [];
  const pushUrl = (u) => { const n = normUrl(u); if (n && !urlSet.has(n)) { urlSet.add(n); allUrls.push(n); } };
  (rawUrls || []).forEach(pushUrl);
  (faucetRows || []).forEach((f) => { if (f && f.url) pushUrl(f.url); });
  allUrls.sort();

  // Custom searchable combobox: a text input that, on focus/typing, opens a
  // dropdown list of all faucets (alphabetical); typing filters it
  // character-by-character, clicking an option selects it.
  const urlInput = document.createElement('input');
  urlInput.className = 'admin-input';
  urlInput.placeholder = '🔍 Выберите кран (поиск по URL)...';
  urlInput.setAttribute('autocomplete', 'off');
  urlInput.style.width = '100%';
  urlInput.style.boxSizing = 'border-box';
  urlInput.style.paddingRight = '30px';

  const listbox = document.createElement('div');
  listbox.className = 'raw-url-listbox';
  listbox.style.display = 'none';

  function renderListbox() {
    const f = (urlInput.value || '').trim().toLowerCase();
    listbox.innerHTML = '';
    const matches = allUrls.filter((u) => !f || u.toLowerCase().indexOf(f) !== -1);
    if (!matches.length) {
      const empty = document.createElement('div');
      empty.className = 'raw-url-option';
      empty.style.color = 'var(--text-dim)';
      empty.textContent = 'Ничего не найдено';
      listbox.appendChild(empty);
      return;
    }
    matches.forEach((u) => {
      const opt = document.createElement('div');
      opt.className = 'raw-url-option';
      opt.textContent = u;
      opt.addEventListener('mousedown', (e) => {
        e.preventDefault();
        urlInput.value = u;
        listbox.style.display = 'none';
        loadAndRender();
      });
      listbox.appendChild(opt);
    });
  }

  urlInput.addEventListener('focus', () => { renderListbox(); listbox.style.display = 'block'; });
  urlInput.addEventListener('input', () => { renderListbox(); listbox.style.display = 'block'; });
  urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { listbox.style.display = 'none'; loadAndRender(); }
    if (e.key === 'Escape') { listbox.style.display = 'none'; }
  });
  urlInput.addEventListener('blur', () => { setTimeout(() => { listbox.style.display = 'none'; }, 150); });

  const dateSel = document.createElement('select');
  dateSel.className = 'admin-input';
  dateSel.style.flex = '1 1 200px';
  dateSel.style.minWidth = '200px';
  dateSel.style.maxWidth = '240px';
  dateSel.style.boxSizing = 'border-box';
  const now = new Date();
  for (let i = 7; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86400000);
    const v = d.toISOString().slice(0, 10);
    const o = document.createElement('option');
    o.value = v;
    o.textContent = v;
    dateSel.appendChild(o);
  }
  // Default the date selector to TODAY (current date).
  dateSel.value = now.toISOString().slice(0, 10);

  const urlField = document.createElement('div');
  urlField.className = 'raw-url-field';
  urlField.style.flex = '1 1 200px';
  urlField.style.minWidth = '200px';
  urlField.style.maxWidth = '460px';

  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'raw-url-clear';
  clearBtn.textContent = '✕';
  clearBtn.title = 'Очистить выбор крана';
  clearBtn.addEventListener('click', () => {
    urlInput.value = '';
    listbox.style.display = 'none';
    tableHost.innerHTML = '<p class="modal-hint">Введите или выберите URL крана.</p>';
    urlInput.focus();
  });

  urlField.appendChild(urlInput);
  urlField.appendChild(clearBtn);
  urlField.appendChild(listbox);
  ctrl.appendChild(urlField);
  ctrl.appendChild(dateSel);
  wrap.appendChild(ctrl);

  const tableHost = document.createElement('div');
  tableHost.innerHTML = '<p class="modal-hint">Выберите кран и дату — таблица загрузится автоматически.</p>';
  wrap.appendChild(tableHost);

  container.appendChild(wrap);

  async function loadAndRender() {
    const url = urlInput.value.trim();
    const day = dateSel.value;
    if (!url) { tableHost.innerHTML = '<p class="modal-hint">Введите или выберите URL крана.</p>'; return; }
    tableHost.innerHTML = '<p class="modal-hint">Загрузка…</p>';
    let snaps = [];
    try {
      snaps = await loadRawSnapshots(url, day);
    } catch (e) {
      const msg = (e && e.message) ? e.message : String(e);
      if (/no such table|unknown|raw_hourly/i.test(msg)) {
        tableHost.innerHTML = '<p class="modal-hint" style="color:var(--err,#c0392b)">Таблица <code>raw_hourly</code> ещё не создана или пуста. Дождитесь прогона pipeline (или запустите workflow вручную) — схема и снимки появятся автоматически.</p>';
      } else {
        tableHost.innerHTML = '<p class="modal-hint" style="color:var(--err,#c0392b)">Ошибка загрузки: ' + escapeAttr(msg) + '</p>';
      }
      return;
    }
    if (!snaps.length) {
      tableHost.innerHTML = '<p class="modal-hint">Нет снимков за ' + escapeAttr(day) + ' для выбранного крана.</p>';
      return;
    }

    // Compute TOTAL_BALANCE (USD) and the simplified Health Score from the full
    // history: ЭТАЛОН = absolute peak total USD over all snapshots up to & including
    // the current row; Health Score = current total USD / ЭТАЛОН × 100.
    let totalByAt = {};
    let healthByAt = {};
    let peakValue = 0;
    let history = [];
    let series = null;
    try {
      history = await loadRawFullHistory(url);
      series = computeRawHealthSeries(history);
      totalByAt = series.totalByAt;
      healthByAt = series.healthByAt;
      peakValue = series.peakValue;
    } catch (e) {
      console.warn('Raw health compute failed:', e);
    }

    let medianArr = null;
    if (series) {
      try { medianArr = computePerSnapshotMedianHs(snaps, history, series); } catch (e) { console.warn('Median HS compute failed:', e); }
    }

    tableHost.innerHTML = buildRawTableHtml(snaps, totalByAt, healthByAt, peakValue, medianArr);
  }

  dateSel.addEventListener('change', loadAndRender);
  // Leave the faucet field empty by default — the user picks a faucet from the
  // dropdown (or types to filter). The table loads once a faucet is chosen.
  urlInput.value = '';
}

function buildBlockWeightsEditor() {
  const rating = realConfigCache.rating;
  const weights = rating.block_weights || (rating.block_weights = { block_1_solvency: 0.70, block_2_reliability: 0.30 });
  const block = document.createElement('div');
  block.className = 'admin-grid';
  const sumEl = document.createElement('div');
  sumEl.className = 'weights-sum';
  sumEl.style.marginTop = '6px';
  function sync() {
    const s = (Number(weights.block_1_solvency) || 0) + (Number(weights.block_2_reliability) || 0);
    sumEl.textContent = 'Сумма весов: ' + s.toFixed(2) + (Math.abs(s - 1) < 0.001 ? '  ✅ (100%)' : '  ⚠️ (≠ 100%)');
    sumEl.style.color = Math.abs(s - 1) < 0.001 ? 'var(--text-dim)' : '#ffb020';
  }
  function mk(key, label) {
    const cell = document.createElement('div'); cell.className = 'admin-grid-cell';
    cell.innerHTML =
      '<label>' + label + '</label>' +
      '<input type="range" min="0" max="1" step="0.01" class="bw-range" value="' + (weights[key] != null ? weights[key] : 0) + '" style="width:170px"/>' +
      '<input type="number" min="0" max="1" step="0.01" class="admin-input num bw-num" value="' + (weights[key] != null ? weights[key] : 0) + '" style="width:80px"/>';
    const range = cell.querySelector('.bw-range');
    const num = cell.querySelector('.bw-num');
    function set(v) { weights[key] = Number(v); range.value = v; num.value = v; sync(); onFormulaChange(); }
    range.addEventListener('input', () => set(range.value));
    num.addEventListener('input', () => set(num.value));
    return cell;
  }
  block.appendChild(mk('block_1_solvency', 'Блок 1 (платёжеспособность)'));
  block.appendChild(mk('block_2_reliability', 'Блок 2 (надёжность)'));
  block.appendChild(sumEl);
  sync();
  return block;
}

function buildUiiEditor() {
  const rating = realConfigCache.rating;
  const uii = rating.uii || (rating.uii = { min: 0.80, max: 1.20 });
  const block = document.createElement('div'); block.className = 'admin-grid uii-grid';
  ['min', 'max'].forEach((k) => {
    const cell = document.createElement('div'); cell.className = 'admin-grid-cell';
    cell.innerHTML = '<label>UII ' + k + '</label><input type="number" min="0" max="3" step="0.01" class="admin-input num" value="' + (uii[k] != null ? uii[k] : '') + '" style="width:80px"/>';
    cell.querySelector('input').addEventListener('input', (e) => { uii[k] = e.target.value === '' ? null : Number(e.target.value); onFormulaChange(); });
    block.appendChild(cell);
  });
  return block;
}

function buildGradeThresholdsEditor() {
  const cfg = realConfigCache;
  const rt = cfg.rating_thresholds || (cfg.rating_thresholds = {});
  const table = document.createElement('table'); table.className = 'admin-table';
  table.innerHTML = '<thead><tr><th>Грейд</th><th>Мин. балл</th></tr></thead>';
  const tb = document.createElement('tbody');
  ['A', 'B', 'C', 'D', 'F'].forEach((g) => {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td>' + g + '</td><td><input class="admin-input num" data-g="' + g + '" value="' + (rt[g] != null ? rt[g] : '') + '" style="width:80px"/></td>';
    tr.querySelector('input').addEventListener('input', (e) => { rt[g] = e.target.value === '' ? null : Number(e.target.value); onFormulaChange(); });
    tb.appendChild(tr);
  });
  table.appendChild(tb);
  return table;
}

function buildThresholdTable(scaleObj, mode, fallback) {
  const scale = scaleObj || (scaleObj = { thresholds: [] });
  if (!Array.isArray(scale.thresholds)) scale.thresholds = [];
  const hasMin = mode === 'min';
  const hasMax = mode === 'max';
  const block = document.createElement('div');
  if (fallback) {
    const fb = document.createElement('div'); fb.className = 'admin-subrow';
    fb.innerHTML = '<label>fallback_ratio:</label><input type="number" step="0.01" class="admin-input num" value="' + (scale.fallback_ratio != null ? scale.fallback_ratio : '') + '" style="width:80px"/>';
    fb.querySelector('input').addEventListener('input', (e) => { scale.fallback_ratio = e.target.value === '' ? null : Number(e.target.value); onFormulaChange(); });
    block.appendChild(fb);
  }
  const table = document.createElement('table'); table.className = 'admin-table';
  table.innerHTML = '<thead><tr>' +
    (hasMin ? '<th>min ≥</th>' : '') +
    (hasMax ? '<th>max ≤</th>' : '') +
    '<th>exclusive</th><th>баллы</th><th></th></tr></thead>';
  const tb = document.createElement('tbody');
  const renderRows = () => {
    tb.innerHTML = '';
    scale.thresholds.forEach((t, idx) => {
      const minVal = (hasMin && typeof t.min === 'number') ? t.min : '';
      const maxVal = (hasMax && typeof t.max === 'number') ? t.max : '';
      const tr = document.createElement('tr');
      tr.innerHTML =
        (hasMin ? '<td><input class="admin-input num" data-r="min" value="' + minVal + '" style="width:80px"/></td>' : '') +
        (hasMax ? '<td><input class="admin-input num" data-r="max" value="' + maxVal + '" style="width:80px"/></td>' : '') +
        '<td style="text-align:center"><input type="checkbox" data-r="exclusive" ' + (t.exclusive ? 'checked' : '') + '/></td>' +
        '<td><input class="admin-input num" data-r="points" value="' + (t.points != null ? t.points : '') + '" style="width:80px"/></td>' +
        '<td><button class="btn btn-danger" data-delrow>✕</button></td>';
      const setField = (field, raw) => { if (raw === '' || raw === null) delete t[field]; else t[field] = Number(raw); };
      if (hasMin) tr.querySelector('[data-r="min"]').addEventListener('input', (e) => { setField('min', e.target.value); onFormulaChange(); });
      if (hasMax) tr.querySelector('[data-r="max"]').addEventListener('input', (e) => { setField('max', e.target.value); onFormulaChange(); });
      tr.querySelector('[data-r="exclusive"]').addEventListener('change', (e) => { t.exclusive = e.target.checked; onFormulaChange(); });
      tr.querySelector('[data-r="points"]').addEventListener('input', (e) => { t.points = e.target.value === '' ? 0 : Number(e.target.value); onFormulaChange(); });
      tr.querySelector('[data-delrow]').addEventListener('click', () => { scale.thresholds.splice(idx, 1); renderRows(); onFormulaChange(); });
      tb.appendChild(tr);
    });
  };
  renderRows();
  table.appendChild(tb);
  block.appendChild(table);
  const addBtn = document.createElement('button'); addBtn.className = 'btn btn-primary'; addBtn.textContent = '+ Добавить порог';
  addBtn.addEventListener('click', () => { scale.thresholds.push(hasMin ? { min: 0, points: 0 } : { max: 0, points: 0 }); renderRows(); onFormulaChange(); });
  block.appendChild(addBtn);
  return block;
}

function buildPayoutTypeEditor(mapObj) {
  const map = mapObj || (mapObj = {});
  const block = document.createElement('div');
  const table = document.createElement('table'); table.className = 'admin-table';
  table.innerHTML = '<thead><tr><th>Тип выплат</th><th>Баллы</th><th></th></tr></thead>';
  const tb = document.createElement('tbody');
  const renderRows = () => {
    tb.innerHTML = '';
    Object.keys(map).forEach((type) => {
      const tr = document.createElement('tr');
      tr.innerHTML =
        '<td><input class="admin-input" data-pt="type" value="' + escapeAttr(type) + '" style="width:120px"/></td>' +
        '<td><input class="admin-input num" data-pt="points" value="' + (map[type] != null ? map[type] : '') + '" style="width:80px"/></td>' +
        '<td><button class="btn btn-danger" data-delpt>✕</button></td>';
      const typeInp = tr.querySelector('[data-pt="type"]');
      typeInp.addEventListener('input', (e) => {
        const old = type; const nv = e.target.value;
        if (nv !== old) { const v = map[old]; delete map[old]; map[nv] = v; type = nv; }
        onFormulaChange();
      });
      tr.querySelector('[data-pt="points"]').addEventListener('input', (e) => { map[type] = e.target.value === '' ? null : Number(e.target.value); onFormulaChange(); });
      tr.querySelector('[data-delpt]').addEventListener('click', () => { delete map[type]; renderRows(); onFormulaChange(); });
      tb.appendChild(tr);
    });
  };
  renderRows();
  table.appendChild(tb);
  block.appendChild(table);
  const addRow = document.createElement('div'); addRow.className = 'admin-subrow';
  addRow.innerHTML = '<label>Новый тип:</label><input class="admin-input" id="pt-new" placeholder="auto" style="width:120px"/><input class="admin-input num" id="pt-new-pts" placeholder="0" style="width:80px"/>';
  const addBtn = document.createElement('button'); addBtn.className = 'btn btn-primary'; addBtn.textContent = '+ Добавить тип';
  addBtn.addEventListener('click', () => {
    const t = addRow.querySelector('#pt-new').value.trim() || ('type' + (Object.keys(map).length + 1));
    const p = Number(addRow.querySelector('#pt-new-pts').value);
    map[t] = isFinite(p) ? p : 0;
    addRow.querySelector('#pt-new').value = '';
    addRow.querySelector('#pt-new-pts').value = '';
    renderRows(); onFormulaChange();
  });
  addRow.appendChild(addBtn);
  block.appendChild(addRow);
  return block;
}

const formulaBadges = [];

function upperFieldPoints(scale) {
  const ts = scale && Array.isArray(scale.thresholds) ? scale.thresholds : [];
  if (!ts.length) return 0;
  const p = Number(ts[0].points);
  return isNaN(p) ? 0 : p;
}
function maxPointsOfMap(map) {
  const values = Object.values(map || {}).filter(v => !isNaN(Number(v)));
  return values.length > 0 ? Number(values[0]) : 0;
}
const BLOCK1_KEYS = ['daily_volume_usd', 'health_score', 'payout_activity_hours'];
const BLOCK2_KEYS = ['age_months', 'gateways_count', 'payout_type'];
function sumMaxPoints(rating, keys) {
  let s = 0;
  for (const k of keys) {
    if (k === 'payout_type') s += maxPointsOfMap(rating.payout_type);
    else s += upperFieldPoints(rating[k]);
  }
  return s;
}
function maxBadgeClass(n) {
  if (n === 100) return 'green';
  if (n >= 101 && n <= 120) return 'blue-light';
  if (n >= 121) return 'blue';
  if (n >= 80 && n <= 99) return 'yellow';
  return 'orange';
}
function makeMaxBadge(getMax) {
  const badge = document.createElement('span');
  badge.title = 'Сумма верхних (максимальных) полей баллов по этому глобальному блоку';
  const update = () => {
    const v = getMax();
    badge.textContent = v;
    badge.className = 'max-badge ' + maxBadgeClass(v);
  };
  update();
  formulaBadges.push(update);
  return badge;
}
function refreshFormulaBadges() { for (const u of formulaBadges) u(); }

function appendFormulaBlock(wrap, title, editor, getMax) {
  const block = document.createElement('div');
  block.className = 'formula-block';
  const head = document.createElement('div');
  head.className = 'formula-block-head';
  head.appendChild(sectionTitle(title));
  if (getMax) head.appendChild(makeMaxBadge(getMax));
  block.appendChild(head);
  block.appendChild(editor);
  wrap.appendChild(block);
}

function renderRealFormulas(container) {
  const cfg = realConfigCache || (realConfigCache = defaultFormulaConfig());
  const wrap = document.createElement('div');
  const rating = cfg.rating || (cfg.rating = {});
  formulaBadges.length = 0;
    wrap.innerHTML = '<p class="modal-hint">Конструктор математической модели. Все параметры считываются из Turso (<code>configs(\'prod\')</code>) и применяются ко всем кранам после сохранения через «Сохранить в БД». Без хардкода таблиц и монет.</p>';

  appendFormulaBlock(wrap, 'Веса блоков (block_weights)', buildBlockWeightsEditor());

  appendFormulaBlock(wrap, 'Диапазон UII (uii.min / uii.max)', buildUiiEditor());

  appendFormulaBlock(wrap, 'Пороги грейдов (rating_thresholds)', buildGradeThresholdsEditor());

  const tables = [
    { key: 'daily_volume_usd', title: 'Блок 1 · Суточный объём выплат (daily_volume_usd)', mode: 'min', block: 1 },
    { key: 'health_score', title: 'Блок 1 · Баллы за здоровье (health_score)', mode: 'min', block: 1 },
    { key: 'payout_activity_hours', title: 'Блок 1 · Пауза в выплатах (payout_activity_hours)', mode: 'max', block: 1 },
    { key: 'age_months', title: 'Блок 2 · Возраст (age_months)', mode: 'min', block: 2 },
    { key: 'gateways_count', title: 'Блок 2 · Шлюзы (gateways_count)', mode: 'min', block: 2 },
  ];
  tables.forEach((t) => { if (!rating[t.key]) rating[t.key] = { thresholds: [] }; });
  if (!rating.payout_type) rating.payout_type = {};
  tables.forEach((t) => {
    const keys = t.block === 1 ? BLOCK1_KEYS : BLOCK2_KEYS;
    appendFormulaBlock(wrap, t.title, buildThresholdTable(rating[t.key] || (rating[t.key] = { thresholds: [] }), t.mode, t.fallback), () => sumMaxPoints(rating, keys));
  });

  appendFormulaBlock(wrap, 'Блок 2 · Тип выплат (payout_type)', buildPayoutTypeEditor(rating.payout_type || (rating.payout_type = {})), () => sumMaxPoints(rating, BLOCK2_KEYS));

  const resetBtn = document.createElement('button');
  resetBtn.className = 'btn';
  resetBtn.id = 'sb-reset';
  resetBtn.textContent = '↺ Сбросить настройки формул к дефолту';
  resetBtn.style.marginTop = '18px';
  resetBtn.addEventListener('click', () => {
    try {
      const def = defaultFormulaConfig();
      // reset ONLY formula settings (Health Score + Rating calculation), keep targets/history
      realConfigCache.rating = JSON.parse(JSON.stringify(def.rating));
      realConfigCache.rating_thresholds = JSON.parse(JSON.stringify(def.rating_thresholds));
      realConfigCache.health = JSON.parse(JSON.stringify(def.health));
      container.innerHTML = '';
      renderRealFormulas(container);
      onFormulaChange();
      showToast('Настройки формул сброшены к дефолту', 'success');
    } catch (e) { showToast('Ошибка сброса: ' + e.message, 'error'); }
  });
  wrap.appendChild(resetBtn);

  container.appendChild(wrap);
}


// ----- wiring -----
const adminRealBtn = document.getElementById('admin-real-btn');
if (adminRealBtn) adminRealBtn.addEventListener('click', async () => { const ok = await requireAuth(); if (ok) openRealAdmin(); });

// Initial data load — runs last so every module-level declaration (DOM refs, etc.) is ready.
loadData();

// Proactively warn (once) when the session expires instead of failing writes silently.
startSessionWatcher();