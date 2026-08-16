// ============================================================================
// FaucetPay Monitor — frontend logic (self-contained, no external libraries)
// ============================================================================

const DATA_URL = './faucets.json';

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
  { key: 'name', title: 'Название крана', ellipsis: true },
  { key: 'url', title: '' },
  { key: 'category_name', title: 'Категория', ellipsis: true },
  { key: 'is_enabled', title: 'Статус', center: true },
  { key: 'currency', title: 'Валюта', ellipsis: true },
  { key: 'active_users', title: 'Актив. юзеры', num: true },
  { key: 'paid_today', title: 'Выплач. сегодня', num: true },
  { key: 'total_users_paid', title: 'Всего выплат', num: true },
  { key: 'balance', title: 'Баланс', num: true },
  { key: 'health', title: 'Здоровье', num: true },
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
        health: r.health !== undefined ? Number(r.health) : null,
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
  return (v === null || v === undefined || isNaN(v)) ? '—' : Number(v).toLocaleString('ru-RU');
}

function fmtMoney(v) {
  return (v === null || v === undefined || isNaN(v)) ? '—' : Number(v).toFixed(8);
}

function fmtPct(v) {
  return (v === null || v === undefined || isNaN(v)) ? '—' : Number(v) + '%';
}

// ----------------------------------------------------------------------------
// DOM building
// ----------------------------------------------------------------------------

const toolbar = document.createElement('div');
toolbar.className = 'toolbar';

const searchInput = document.createElement('input');
searchInput.type = 'search';
searchInput.className = 'search-input';
searchInput.placeholder = 'Поиск по названию, категории, валюте...';
toolbar.appendChild(searchInput);

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
  if (col.center) th.classList.add('center');

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

tableHost.append(toolbar, scrollWrap, paginationBar);

// ----------------------------------------------------------------------------
// Rendering
// ----------------------------------------------------------------------------

function trFor(r) {
  const tr = document.createElement('tr');

  COLUMNS.forEach((col) => {
    const td = document.createElement('td');
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
      case 'category_name':
        td.textContent = r.category_name || '—';
        break;
      case 'is_enabled': {
        const badge = document.createElement('span');
        badge.className = r.is_enabled ? 'badge-live' : 'badge-dead';
        badge.textContent = r.is_enabled ? 'ENABLED' : 'DISABLED';
        td.appendChild(badge);
        break;
      }
      case 'currency':
        td.textContent = r.currency || '—';
        break;
      case 'active_users':
        td.textContent = fmtInt(r.active_users);
        break;
      case 'paid_today':
        td.textContent = fmtMoney(r.paid_today);
        break;
      case 'total_users_paid':
        td.textContent = fmtInt(r.total_users_paid);
        break;
      case 'balance':
        td.textContent = fmtMoney(r.balance);
        break;
      case 'health':
        td.textContent = fmtPct(r.health);
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
      'Страница открыта напрямую как файл (file://), поэтому браузер блокирует загрузку faucets.json. ' +
      'Запусти локальный сервер, например: "python -m http.server 8000" в папке проекта, и открой http://localhost:8000/, ' +
      'либо тестируй через опубликованный GitHub Pages.'
    );
    return;
  }

  try {
    const res = await fetch(`${DATA_URL}?t=${Date.now()}`, { cache: 'no-store' });

    if (!res.ok) {
      throw new Error(`Файл faucets.json не найден (HTTP ${res.status}). Возможно, GitHub Action ещё не запускался.`);
    }

    let json;
    try {
      json = await res.json();
    } catch (e) {
      throw new Error('faucets.json повреждён или содержит некорректный JSON.');
    }

    const { fetchedAt, rows } = normalizeResponse(json);

    if (!Array.isArray(rows) || rows.length === 0) {
      throw new Error('faucets.json загружен, но не удалось извлечь ни одной записи о кране — проверь структуру файла.');
    }

    allRows = rows;
    recordCountEl.textContent = rows.length;
    lastUpdatedEl.textContent = formatTimestamp(fetchedAt);
    render();

  } catch (err) {
    console.error(err);
    allRows = [];
    recordCountEl.textContent = '0';
    lastUpdatedEl.textContent = '—';
    render();
    showError(err.message || 'Не удалось загрузить данные.');
  }
}

document.getElementById('refresh-btn').addEventListener('click', loadData);

loadData();