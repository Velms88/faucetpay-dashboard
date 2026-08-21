const BINANCE_TICKER = 'https://api.binance.com/api/v3/ticker/price';
const COINCAP_ASSETS = 'https://api.coincap.io/v2/assets?limit=2000';
const COINGECKO_SIMPLE = 'https://api.coingecko.com/api/v3/simple/price';
const COINBASE_SPOT = 'https://api.coinbase.com/v2/prices/';
// CoinGecko identifies coins by id (not ticker), so we map our symbols to ids.
const SYMBOL_TO_CG_ID = {
  BTC: 'bitcoin', ETH: 'ethereum', DOGE: 'dogecoin', LTC: 'litecoin',
  BCH: 'bitcoin-cash', DASH: 'dash', DGB: 'digibyte', TRX: 'tron',
  USDT: 'tether', FEY: 'feyorra', ZEC: 'zcash', BNB: 'binancecoin',
  SOL: 'solana', XRP: 'ripple', POL: 'polygon-ecosystem-token', ADA: 'cardano',
  TON: 'the-open-network', XLM: 'stellar', USDC: 'usd-coin', XMR: 'monero',
  TRUMP: 'official-trump', PEPE: 'pepe', FLT: 'flector',
};
const TIMEOUT_MS = 8000;
const STABLE_DEFAULT = { USDT: 1, USDC: 1, DAI: 1, TUSD: 1, FDUSD: 1, USDE: 1, PYUSD: 1 };

// CoinGecko API key. MUST come from the environment (GitHub secret
// "COINGECKO_API"), never hardcoded. The free/demo plan authenticates via the
// `x_cg_demo_api_key` query parameter; that is what the provided key is for.
const COINGECKO_API_KEY =
  (typeof process !== 'undefined' && process.env && process.env.COINGECKO_API)
    ? String(process.env.COINGECKO_API).trim()
    : '';

function round2(v) {
  const n = Number(v);
  if (!isFinite(n)) return 0;
  return Math.round(n * 1e6) / 1e6;
}

async function fetchJson(url, fetchFn, headers) {
  const f = fetchFn || (typeof fetch !== 'undefined' ? fetch : null);
  if (!f) throw new Error('fetch unavailable in this environment');
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), TIMEOUT_MS) : null;
  const opts = ctrl ? { signal: ctrl.signal } : {};
  if (headers) opts.headers = headers;
  try {
    const res = await f(url, opts);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function fetchFromBinance(fetchFn) {
  const data = await fetchJson(BINANCE_TICKER, fetchFn);
  const map = {};
  if (Array.isArray(data)) {
    for (const row of data) {
      const sym = row.symbol || '';
      if (sym.endsWith('USDT') && sym.length > 4) {
        const base = sym.slice(0, -4);
        const price = Number(row.price);
        if (isFinite(price)) map[base] = price;
      }
    }
  }
  return map;
}

async function fetchFromCoinCap(fetchFn) {
  const data = await fetchJson(COINCAP_ASSETS, fetchFn);
  const map = {};
  const arr = (data && data.data) || [];
  if (Array.isArray(arr)) {
    for (const a of arr) {
      const sym = String(a.symbol || '').toUpperCase();
      const price = Number(a.priceUsd);
      if (sym && isFinite(price)) map[sym] = price;
    }
  }
  return map;
}

async function fetchFromCoinGecko(symbols, fetchFn) {
  const ids = symbols
    .map((s) => SYMBOL_TO_CG_ID[String(s).toUpperCase()])
    .filter(Boolean);
  if (!ids.length) return {};
  // Demo/free plan authenticates with the `x_cg_demo_api_key` query parameter.
  const keyParam = COINGECKO_API_KEY ? '&x_cg_demo_api_key=' + encodeURIComponent(COINGECKO_API_KEY) : '';
  const url = COINGECKO_SIMPLE + '?ids=' + ids.join(',') + '&vs_currencies=usd' + keyParam;
  const data = await fetchJson(url, fetchFn, {
    // CoinGecko rejects requests without a descriptive User-Agent (HTTP 403).
    'User-Agent': 'faucetpay-monitor/1.0 (+https://github.com/)',
  });
  const map = {};
  for (const s of symbols) {
    const id = SYMBOL_TO_CG_ID[String(s).toUpperCase()];
    if (id && data && data[id] && isFinite(Number(data[id].usd))) {
      map[String(s).toUpperCase()] = Number(data[id].usd);
    }
  }
  return map;
}

// Coinbase public spot endpoint is extremely reliable and rarely blocks
// cloud/CI IP ranges (unlike Binance), so it serves as a robust fallback.
async function fetchFromCoinbase(symbols, fetchFn) {
  const map = {};
  await Promise.all(symbols.map(async (s) => {
    const up = String(s).toUpperCase();
    try {
      const data = await fetchJson(COINBASE_SPOT + up + '-USD/spot', fetchFn, {
        'User-Agent': 'faucetpay-monitor/1.0 (+https://github.com/)',
      });
      const price = Number(data && data.data && data.data.amount);
      if (isFinite(price) && price > 0) map[up] = price;
    } catch (e) {
      // per-symbol failure: ignore, other sources may cover it
    }
  }));
  return map;
}

async function fetchCryptoPrices(symbols, opts) {
  opts = opts || {};
  const fetchFn = opts.fetchFn || null;
  const requested = Array.isArray(symbols) ? symbols.slice() : symbols ? Object.keys(symbols) : [];
  const result = {};

  let binanceMap = {};
  let coincapMap = {};
  let coingeckoMap = {};
  let coinbaseMap = {};
  let binanceOk = false;
  let coincapOk = false;
  let coingeckoOk = false;
  let coinbaseOk = false;

  try {
    coinbaseMap = await fetchFromCoinbase(requested, fetchFn);
    coinbaseOk = true;
  } catch (e) {
    coinbaseOk = false;
  }
  try {
    binanceMap = await fetchFromBinance(fetchFn);
    binanceOk = true;
  } catch (e) {
    binanceOk = false;
  }
  try {
    coincapMap = await fetchFromCoinCap(fetchFn);
    coincapOk = true;
  } catch (e) {
    coincapOk = false;
  }
  try {
    coingeckoMap = await fetchFromCoinGecko(requested, fetchFn);
    coingeckoOk = true;
  } catch (e) {
    coingeckoOk = false;
  }

  if (!binanceOk && !coincapOk && !coingeckoOk && !coinbaseOk) {
    throw new Error('all price sources failed (no network / blocked)');
  }

  // Priority: CoinCap < Binance < Coinbase < CoinGecko. CoinGecko (with API
  // key) is PRIMARY; Coinbase is the CI-resilient FALLBACK; Binance/CoinCap
  // remain low-priority safety nets.
  const merged = Object.assign({}, coincapMap, binanceMap, coinbaseMap, coingeckoMap);

  for (const sym of requested) {
    const up = String(sym).toUpperCase();
    if (merged[up] !== undefined) result[sym] = round2(merged[up]);
    else if (STABLE_DEFAULT[up] !== undefined) result[sym] = STABLE_DEFAULT[up];
  }

  return {
    prices: result,
    sources: { binance: binanceOk, coincap: coincapOk, coinbase: coinbaseOk, coingecko: coingeckoOk },
    requested: requested.length,
    resolved: Object.keys(result).length,
  };
}

const api = {
  fetchCryptoPrices,
  fetchFromBinance,
  fetchFromCoinCap,
  fetchFromCoinGecko,
  fetchFromCoinbase,
  SYMBOL_TO_CG_ID,
  BINANCE_TICKER,
  COINCAP_ASSETS,
  COINGECKO_SIMPLE,
  COINBASE_SPOT,
};

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.CryptoPrices = api;
