// ============================================================================
// FaucetPay Monitor — frontend logic
// ============================================================================

const DATA_URL = './faucets.json';

const errorBanner = document.getElementById('error-banner');
const recordCountEl = document.getElementById('record-count');
const lastUpdatedEl = document.getElementById('last-updated');

function showError(message) {
  errorBanner.textContent = message;
  errorBanner.classList.remove('hidden');
}

function hideError() {
  errorBanner.classList.add('hidden');
  errorBanner.textContent = '';
}

function formatTimestamp(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return d.toLocaleString('ru-RU', {
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

// Измененная логика для группировки дубликатов кранов и сбора валют в одну строку
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

  // Создаем Map для группировки данных по URL крана (чтобы избежать повторений)
  const faucetMap = new Map();

  rawRows.forEach((r) => {
    const name = (r.name || '').trim();
    const url = (r.url || '').trim();
    
    // Используем URL в нижнем регистре как уникальный идентификатор
    const key = url.toLowerCase() || name.toLowerCase(); 

    if (!key) return;

    const currency = (r.currency || '').trim();

    if (!faucetMap.has(key)) {
      // Инициализируем новую запись
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
      // Если кран уже записан, просто добавляем поддерживаемую валюту
      if (currency) {
        faucetMap.get(key).currencies.add(currency);
      }
    }
  });

  // Преобразуем Map обратно в массив и склеиваем набор (Set) валют в строку через запятую
  const rows = Array.from(faucetMap.values()).map(r => {
    r.currency = Array.from(r.currencies).join(', ');
    delete r.currencies; // Очищаем временный Set
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

// ----------------------------------------------------------------------------
// Table setup logic
// ----------------------------------------------------------------------------

const table = new Tabulator('#faucet-table', {
  // fitColumns решает проблему лишней пустой колонки, растягивая данные на всю ширину
  layout: 'fitColumns', 
  responsiveLayout: false,
  pagination: true,
  paginationSize: 25,
  paginationSizeSelector: [20, 25, 50, 100],
  placeholder: 'Нет данных для отображения',
  columns: [
    {
      title: 'Название крана',
      field: 'name',
      sorter: 'string',
      headerFilter: 'input',
      headerFilterPlaceholder: 'Поиск...',
      width: 190,
      tooltip: true,
      formatter: 'plaintext',
      cssClass: 'truncate-cell',
    },
    {
      title: 'URL',
      field: 'url',
      hozAlign: 'center',
      width: 90,
      headerSort: false,
      formatter: function () {
        return '<button type="button" class="visit-btn copy-url-btn">Copy URL</button>';
      },
      cellClick: function (e, cell) {
        const url = cell.getValue();
        if (!url) return;

        const btn = cell.getElement().querySelector('button');
        const originalText = btn ? btn.textContent : null;

        const showCopied = () => {
          if (!btn) return;
          btn.textContent = 'Copied!';
          setTimeout(() => { btn.textContent = originalText; }, 1200);
        };

        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(url).then(showCopied).catch(() => {
            copyUrlFallback(url);
            showCopied();
          });
        } else {
          copyUrlFallback(url);
          showCopied();
        }
      },
    },
    {
      title: 'Категория',
      field: 'category_name',
      sorter: 'string',
      headerFilter: 'input',
      headerFilterPlaceholder: 'Поиск...',
      width: 100,
      tooltip: true,
      formatter: 'plaintext',
      cssClass: 'truncate-cell',
    },
    {
      title: 'Статус',
      field: 'is_enabled',
      hozAlign: 'center',
      width: 100,
      sorter: 'boolean',
      formatter: function (cell) {
        const val = cell.getValue();
        return val
          ? '<span class="badge-live">ENABLED</span>'
          : '<span class="badge-dead">DISABLED</span>';
      },
    },
    {
      title: 'Валюта',
      field: 'currency',
      sorter: 'string',
      headerFilter: 'input',
      headerFilterPlaceholder: 'Поиск...',
      // Удален жесткий width: 80 и заменен на minWidth, чтобы вместить строку "BTC, LTC, DASH..."
      minWidth: 120, 
    },
    {
      title: 'Актив. юзеры',
      field: 'active_users',
      sorter: 'number',
      hozAlign: 'right',
      width: 90,
    },
    {
      title: 'Выплач. сегодня',
      field: 'paid_today',
      sorter: 'number',
      hozAlign: 'right',
      width: 120,
      formatter: function (cell) {
        const val = cell.getValue();
        return (val === null || val === undefined || isNaN(val)) ? '—' : val.toFixed(8);
      },
    },
    {
      title: 'Всего выплат',
      field: 'total_users_paid',
      sorter: 'number',
      hozAlign: 'right',
      width: 90,
    },
    {
      title: 'Баланс',
      field: 'balance',
      sorter: 'number',
      hozAlign: 'right',
      width: 120,
      formatter: function (cell) {
        const val = cell.getValue();
        return (val === null || val === undefined || isNaN(val)) ? '—' : val.toFixed(8);
      },
    },
    {
      title: 'Здоровье',
      field: 'health',
      sorter: 'number',
      hozAlign: 'right',
      width: 90,
      formatter: function (cell) {
        const val = cell.getValue();
        return (val === null || val === undefined || isNaN(val)) ? '—' : `${val}%`;
      },
    },
  ],
  initialSort: [
    { column: 'health', dir: 'desc' },
  ],
});

// ----------------------------------------------------------------------------
// Data loading
// ----------------------------------------------------------------------------

async function loadData() {
  hideError();
  recordCountEl.textContent = '…';
  lastUpdatedEl.textContent = '…';

  if (window.location.protocol === 'file:') {
    recordCountEl.textContent = '0';
    lastUpdatedEl.textContent = '—';
    table.setData([]);
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

    table.setData(rows);
    recordCountEl.textContent = rows.length;
    lastUpdatedEl.textContent = formatTimestamp(fetchedAt);

  } catch (err) {
    console.error(err);
    recordCountEl.textContent = '0';
    lastUpdatedEl.textContent = '—';
    table.setData([]);
    showError(err.message || 'Не удалось загрузить данные.');
  }
}

document.getElementById('refresh-btn').addEventListener('click', loadData);

loadData();
