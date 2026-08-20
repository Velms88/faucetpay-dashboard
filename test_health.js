const config = require('./faucet_config.json');
const history = require('./history.json');
const { calculateHealthScore } = require('./healthScore.js');

const prices = history.crypto_prices_usd || {};

console.log('Health Score (Health-FORMULA.md)');
console.log('updated_at: ' + history.updated_at);
console.log('retention_days: ' + history.retention_days);
console.log('');

for (const faucet of history.faucets) {
  const res = calculateHealthScore(faucet, prices, config);

  console.log('=== ' + faucet.url + ' | enabled=' + faucet.is_enabled + ' ===');
  console.log('Health Score: ' + res.health_score.toFixed(2));

  const coinKeys = Object.keys(res.coins);
  if (coinKeys.length === 0) {
    console.log('  (нет данных по монетам / нулевой баланс / отключён)');
    console.log('');
    continue;
  }

  console.log('  coin  | median M_c     | MA_c          | Health_c % | Weight_c % | M_c x Price USD');
  let weightSum = 0;
  for (const coin of coinKeys) {
    const m = res.coins[coin];
    weightSum += m.weight_pct;
    console.log(
      '  ' + coin.padEnd(6) +
      '| ' + m.median.toFixed(8).padStart(13) +
      ' | ' + m.ma.toFixed(8).padStart(13) +
      ' | ' + m.health_pct.toFixed(2).padStart(10) +
      ' | ' + m.weight_pct.toFixed(2).padStart(10) +
      ' | ' + m.median_usd.toFixed(2).padStart(13)
    );
  }
  console.log('  total median USD: ' + res.total_usd_median.toFixed(2) + ' | weights sum: ' + weightSum.toFixed(2) + '%');
  console.log('');
}
