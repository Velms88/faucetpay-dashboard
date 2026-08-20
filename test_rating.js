const config = require('./faucet_config.json');
const history = require('./history.json');
const { calculateHealthScore } = require('./healthScore.js');
const { calculateRating } = require('./ratingCalculator.js');

const prices = history.crypto_prices_usd || {};

const results = history.faucets.map((faucet) => {
  const health = calculateHealthScore(faucet, prices, config);
  const rating = calculateRating(faucet, health, config);
  return { faucet, health, rating };
});

console.log('=== Rating (Rating-FORMULA.md) ===');
console.log('updated_at: ' + history.updated_at);
console.log('');

const header = 'URL'.padEnd(32) + ' | Health | Block1 | Block2 | UII   | Final | Grade';
console.log(header);
console.log('-'.repeat(header.length));

for (const { faucet, health, rating } of results) {
  console.log(
    faucet.url.padEnd(32) +
    ' | ' + health.health_score.toFixed(2).padStart(6) +
    ' | ' + rating.block_1.score.toFixed(1).padStart(6) +
    ' | ' + rating.block_2.score.toFixed(1).padStart(6) +
    ' | ' + rating.uii_applied.toFixed(2).padStart(5) +
    ' | ' + rating.final_rating.toFixed(2).padStart(5) +
    ' | ' + (rating.letter_grade || '?')
  );
}

console.log('');
console.log('=== Detailed breakdown ===');
console.log('');

for (const { faucet, health, rating } of results) {
  console.log('--- ' + faucet.url + ' (enabled=' + faucet.is_enabled + ') ---');
  console.log('  Health Score (coins): ' + health.health_score.toFixed(2) + ' | 7d health median (для Блока 1.3): ' + rating.overall_health_pct.toFixed(2));
  console.log('  Block 1 score=' + rating.block_1.score.toFixed(2) + ' weighted=' + rating.block_1.weighted.toFixed(2));
  console.log('    ' + JSON.stringify(rating.block_1.details));
  console.log('  Block 2 score=' + rating.block_2.score.toFixed(2) + ' weighted=' + rating.block_2.weighted.toFixed(2));
  console.log('    ' + JSON.stringify(rating.block_2.details));
  console.log('  base_rating=' + rating.base_rating.toFixed(2) + ' uii_applied=' + rating.uii_applied.toFixed(2) + ' final_rating=' + rating.final_rating.toFixed(2) + ' grade=' + rating.letter_grade);
  console.log('');
}
