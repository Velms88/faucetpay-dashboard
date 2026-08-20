const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, 'faucet_config.json');
const HISTORY_FILE = path.join(__dirname, 'history.json');

const CRYPTO_PRICES_USD = {
  BTC: 67000,
  ETH: 3500,
  DOGE: 0.12,
  LTC: 90,
  USDT: 1.0,
  SOL: 150,
};

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
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

function simulateStable(rng, hours) {
  const rows = [];
  let btc = 0.006;
  let doge = 5000;
  let ltc = 20;
  for (let h = 0; h < hours; h++) {
    btc = Math.max(0.0055, btc + (rng() - 0.5) * 0.00008);
    doge = Math.max(4800, doge + (rng() - 0.5) * 60);
    ltc = Math.max(19.5, ltc + (rng() - 0.5) * 0.4);
    rows.push({
      coins: {
        BTC: { balance: round(btc, 8), paid: round(0.0002 * (0.8 + rng() * 0.4), 8) },
        DOGE: { balance: round(doge, 2), paid: round(150 * (0.8 + rng() * 0.4), 2) },
        LTC: { balance: round(ltc, 4), paid: round(0.5 * (0.8 + rng() * 0.4), 4) },
      },
      payouts_count: Math.floor(20 + rng() * 21),
      health: Math.floor(85 + rng() * 11),
    });
  }
  return rows;
}

function simulateDeclining(rng, hours) {
  const rows = [];
  const declineStart = hours - 24;
  let btc = 0.004;
  let doge = 2000;
  for (let h = 0; h < hours; h++) {
    if (h < declineStart) {
      btc = Math.max(0.0039, btc + (rng() - 0.5) * 0.00005);
      doge = Math.max(1950, doge + (rng() - 0.5) * 30);
    } else {
      const k = Math.max(0, 1 - (h - declineStart + 1) / 24);
      btc = Math.max(0.0001, 0.004 * k);
      doge = Math.max(1, 2000 * k);
    }
    rows.push({
      coins: {
        BTC: { balance: round(btc, 8), paid: round(0.0001 * (0.8 + rng() * 0.4), 8) },
        DOGE: { balance: round(doge, 2), paid: round(40 * (0.8 + rng() * 0.4), 2) },
      },
      payouts_count: Math.floor(10 + rng() * 11),
      health: h < declineStart ? Math.floor(70 + rng() * 16) : Math.floor(15 + rng() * 16),
    });
  }
  return rows;
}

function simulateDried(rng, hours) {
  const rows = [];
  const cutoff = hours - 72;
  let btc = 0.0025;
  for (let h = 0; h < hours; h++) {
    if (h < cutoff) {
      btc = Math.max(0.002, btc + (rng() - 0.5) * 0.00003);
      rows.push({
        coins: { BTC: { balance: round(btc, 8), paid: round(0.00005 * (0.7 + rng() * 0.6), 8) } },
        payouts_count: Math.floor(3 + rng() * 6),
        health: Math.floor(55 + rng() * 26),
      });
    } else {
      rows.push({ coins: { BTC: { balance: 0, paid: 0 } }, payouts_count: 0, health: 0 });
    }
  }
  return rows;
}

function simulateNew(rng, hours) {
  const rows = [];
  let btc = 0.001;
  for (let h = 0; h < hours; h++) {
    btc = Math.max(0.0005, btc + (rng() - 0.5) * 0.0001);
    rows.push({
      coins: { BTC: { balance: round(btc, 8), paid: round(0.00001 * (0.5 + rng()), 8) } },
      payouts_count: Math.floor(1 + rng() * 5),
      health: Math.floor(55 + rng() * 31),
    });
  }
  return rows;
}

function simulateFluctuating(rng, hours) {
  const rows = [];
  let doge = 2000;
  let usdt = 50;
  for (let h = 0; h < hours; h++) {
    doge = Math.max(0, doge + (rng() - 0.5) * 1200);
    usdt = Math.max(0, usdt + (rng() - 0.5) * 30);
    const payDoge = rng() < 0.15 ? 0 : 20 + rng() * 80;
    const payUsdt = rng() < 0.15 ? 0 : 0.5 + rng() * 2;
    rows.push({
      coins: {
        DOGE: { balance: round(doge, 2), paid: round(payDoge, 2) },
        USDT: { balance: round(usdt, 2), paid: round(payUsdt, 4) },
      },
      payouts_count: rng() < 0.15 ? 0 : Math.floor(rng() * 31),
      health: Math.floor(rng() * 91),
    });
  }
  return rows;
}

function simulateDisabled(rng, hours) {
  const rows = [];
  const cutoff = hours - 72;
  let btc = 0.002;
  for (let h = 0; h < hours; h++) {
    if (h < cutoff) {
      btc = Math.max(0.0015, btc + (rng() - 0.5) * 0.00002);
      rows.push({
        coins: { BTC: { balance: round(btc, 8), paid: round(0.00005 * (0.7 + rng() * 0.6), 8) } },
        payouts_count: Math.floor(5 + rng() * 11),
        health: Math.floor(45 + rng() * 31),
      });
    } else {
      rows.push({ coins: { BTC: { balance: 0, paid: 0 } }, payouts_count: 0, health: 0 });
    }
  }
  return rows;
}

const SIMULATORS = {
  stable: simulateStable,
  declining: simulateDeclining,
  dried: simulateDried,
  new: simulateNew,
  fluctuating: simulateFluctuating,
  disabled: simulateDisabled,
};

function volumeUsd(row, prices) {
  let total = 0;
  for (const coin of Object.keys(row.coins)) {
    total += row.coins[coin].paid * (prices[coin] || 0);
  }
  return total;
}

function aggregateFaucet(target, rows, prices, endTs) {
  const hours = rows.length;
  const startTs = endTs - (hours - 1) * 3600e3;
  rows.forEach((row, i) => {
    row.ts = startTs + i * 3600e3;
  });

  const allCoins = Object.keys(rows[0].coins);

  const last3Rows = rows.slice(-3);
  const recentBalances = {};
  for (const coin of allCoins) {
    recentBalances[coin] = last3Rows.map((row) => row.coins[coin].balance);
  }

  const dayBuckets = Array.from({ length: 7 }, () => []);
  rows.forEach((row) => {
    const dayIndex = Math.max(0, Math.min(6, Math.floor((endTs - row.ts) / 86400e3)));
    dayBuckets[dayIndex].push(row);
  });

  const dailyPeaks = {};
  const dailyHealth = [];
  const dailyVolumes = [];
  for (let d = 6; d >= 0; d--) {
    const bucket = dayBuckets[d];
    if (bucket.length === 0) continue;
    for (const coin of allCoins) {
      (dailyPeaks[coin] = dailyPeaks[coin] || []).push(
        Math.max(...bucket.map((row) => row.coins[coin].balance))
      );
    }
    dailyHealth.push(median(bucket.map((row) => row.health)));
    dailyVolumes.push(bucket.reduce((sum, row) => sum + volumeUsd(row, prices), 0));
  }

  const v3hActual = last3Rows.reduce((sum, row) => sum + volumeUsd(row, prices), 0);
  const n3hActual = last3Rows.reduce((sum, row) => sum + row.payouts_count, 0);
  const last3ClockHours = last3Rows.map((row) => new Date(row.ts).getUTCHours());

  const expected3h = [];
  for (let d = 1; d <= 6; d++) {
    const bucket = dayBuckets[d];
    if (!bucket.length) {
      expected3h.push({ vol: 0, cnt: 0 });
      continue;
    }
    const matching = bucket.filter((row) => last3ClockHours.includes(new Date(row.ts).getUTCHours()));
    expected3h.push({
      vol: matching.reduce((sum, row) => sum + volumeUsd(row, prices), 0),
      cnt: matching.reduce((sum, row) => sum + row.payouts_count, 0),
    });
  }
  const v3hExpectedMedian = median(expected3h.map((e) => e.vol));
  const n3hExpectedMedian = median(expected3h.map((e) => e.cnt));

  let hoursSinceLastPayout = hours;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (volumeUsd(rows[i], prices) > 0 || rows[i].payouts_count > 0) {
      hoursSinceLastPayout = rows.length - 1 - i;
      break;
    }
  }

  const coins = {};
  for (const coin of allCoins) {
    coins[coin] = {
      daily_peaks: dailyPeaks[coin] || [],
      recent_balances: recentBalances[coin],
    };
  }

  return {
    url: target.url,
    coins,
    payouts: {
      hours_since_last_payout: hoursSinceLastPayout,
      v_3h_actual: round(v3hActual, 2),
      v_3h_expected_median: round(v3hExpectedMedian, 2),
      n_3h_actual: n3hActual,
      n_3h_expected_median: round(n3hExpectedMedian, 1),
      daily_volume_usd_7d_medians: dailyVolumes.map((v) => round(v, 2)),
    },
    daily_health_medians_7d: dailyHealth.map((v) => round(v, 2)),
  };
}

function generate(config) {
  const hours = (config.settings.history_retention_days || 7) * 24;
  const endTs = new Date();
  endTs.setUTCMinutes(0, 0, 0);
  const endTime = endTs.getTime();

  const prices = config.crypto_prices_usd || CRYPTO_PRICES_USD;

  const faucets = (config.targets || []).map((target, index) => {
    const rng = mulberry32(1000 + index * 977);
    const simulator = SIMULATORS[target.label] || simulateStable;
    const simHours = target.label === 'new' ? 8 : hours;
    const rows = simulator(rng, simHours);
    return aggregateFaucet(target, rows, prices, endTime);
  }).sort((a, b) => a.url.localeCompare(b.url));

  return {
    updated_at: endTs.toISOString(),
    retention_days: config.settings.history_retention_days || 7,
    crypto_prices_usd: prices,
    faucets,
  };
}

function main() {
  const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  const history = generate(config);
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));

  console.log('generated history.json');
  console.log('updated_at: ' + history.updated_at);
  console.log('coins priced: ' + Object.keys(history.crypto_prices_usd).join(', '));
  for (const faucet of history.faucets) {
    const coins = Object.keys(faucet.coins)
      .map((c) => c + '(' + faucet.coins[c].daily_peaks.length + 'd)')
      .join(' ');
    console.log('  ' + faucet.url + ' | enabled=' + faucet.is_enabled + ' | coins: ' + coins);
  }
}

module.exports = { generate, CRYPTO_PRICES_USD };

if (require.main === module) {
  main();
}
