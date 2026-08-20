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

const LABEL_NAMES = {
  stable: 'Stable Faucet',
  declining: 'Declining Faucet',
  dried: 'Dried Faucet',
  new: 'New Faucet',
  fluctuating: 'Fluctuating Faucet',
  disabled: 'Disabled Faucet',
};

function buildRecord(target, historyFaucet, prices, index) {
  const coins = Object.keys(historyFaucet.coins);
  const primary = coins[0] || 'BTC';
  const price = Number(prices && prices[primary]) || 0;
  const todayUsd = historyFaucet.payouts.daily_volume_usd_7d_medians.slice(-1)[0] || 0;
  const paidToday = price > 0 ? todayUsd / price : 0;
  const balance = historyFaucet.coins[primary].recent_balances.slice(-1)[0] || 0;
  const lastHealth = historyFaucet.daily_health_medians_7d.slice(-1)[0] || 0;
  const ageMs = (target.age_months || 0) * 30 * 24 * 3600 * 1000;

  return {
    id: '9' + String(100000 + index),
    name: LABEL_NAMES[target.label] || target.url,
    url: target.url,
    owner_id: '0',
    owner_name: 'mock',
    currency: primary,
    timer_in_minutes: '5',
    reward: '0.00100000',
    is_enabled: target.is_enabled === false ? '0' : '1',
    creation_date: String(Math.floor((Date.now() - ageMs) / 1000)),
    category: '1',
    categories: { '0': { id: '1', name: 'Faucet' } },
    paid_today: paidToday.toFixed(8),
    total_users_paid: String(100 + index * 13),
    active_users: String(Math.round((historyFaucet.payouts.n_3h_actual || 0) / 3)),
    balance: balance.toFixed(8),
    health: String(Math.round(lastHealth)),
  };
}

function buildFaucetPayData(config, history, nowTs) {
  const prices = history.crypto_prices_usd || {};
  const historyByUrl = new Map();
  for (const f of history.faucets || []) {
    historyByUrl.set(normalizeUrl(f.url), f);
  }

  const normal = {};
  let added = 0;

  (config.targets || []).forEach((target, i) => {
    const key = normalizeUrl(target.url);
    const historyFaucet = historyByUrl.get(key);
    if (!historyFaucet) return;
    const rec = buildRecord(target, historyFaucet, prices, i);
    if (typeof normal[rec.currency] !== 'object') normal[rec.currency] = {};
    normal[rec.currency]['9' + String(90000 + i)] = rec;
    added++;
  });

  return {
    data: { list_data: { normal } },
    added,
  };
}

function main() {
  const argv = parseArgs();
  const config = JSON.parse(fs.readFileSync(argv.config || CONFIG_FILE, 'utf8'));
  const input = argv.input || config.settings.data_file || 'faucets.json';
  const output = argv.output || 'faucets.mock.json';

  if (!fs.existsSync(input)) {
    console.error('input file not found: ' + input);
    process.exit(1);
  }

  const raw = JSON.parse(fs.readFileSync(input, 'utf8'));
  const history = fs.existsSync(HISTORY_FILE)
    ? JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'))
    : { faucets: [] };

  const listData = raw.data && raw.data.list_data;
  if (!listData || typeof listData !== 'object') {
    console.error('data.list_data not found in ' + input);
    process.exit(1);
  }
  if (typeof listData.normal !== 'object') listData.normal = {};

  const { normal, added } = buildFaucetPayData(config, history, Date.now());
  for (const coin of Object.keys(normal)) {
    if (typeof listData.normal[coin] !== 'object') listData.normal[coin] = {};
    Object.assign(listData.normal[coin], normal[coin]);
  }

  fs.writeFileSync(output, JSON.stringify(raw, null, 2) + '\n');

  console.log('=== generate_mock_faucets.js ===');
  console.log('input:  ' + input);
  console.log('output: ' + output);
  console.log('mock records added: ' + added);
}

module.exports = { buildFaucetPayData, buildRecord };

if (require.main === module) {
  main();
}