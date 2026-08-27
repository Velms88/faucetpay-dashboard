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

function coinUsdValue(coin, amount, prices) {
  const price = Number(prices && prices[coin]);
  if (isNaN(price) || price <= 0) return 0;
  return amount * price;
}

function coinActiveIn7d(coinData) {
  const peaks = (coinData && coinData.daily_peaks) || [];
  const recents = (coinData && coinData.recent_balances) || [];
  const positive = (arr) => arr.some((v) => Number(v) > 0);
  // daily_peaks is already trimmed to the retention window (last 7 days), so a
  // positive peak there means the faucet held this coin at least once recently.
  return positive(peaks) || positive(recents);
}

function calculateHealthScore(faucetData, cryptoPricesUsd, config) {
  const url = faucetData ? faucetData.url : null;
  const isEnabled = !faucetData || faucetData.is_enabled !== false;
  const coinsData = (faucetData && faucetData.coins) || {};
  const prices = cryptoPricesUsd || {};

  // Rule: only coins that held a non-zero balance at least once in the
  // trailing 7-day window count toward the faucet's health. A coin with a
  // zero balance throughout the window contributes nothing, and a faucet is
  // only scored if at least one coin was active in that window.
  const activeCoins = Object.keys(coinsData).filter((c) => coinActiveIn7d(coinsData[c]));

  if (!isEnabled || activeCoins.length === 0) {
    return {
      url,
      is_enabled: isEnabled,
      health_score: 0.0,
      coins: {},
      coins_count: 0,
      total_usd_median: 0,
    };
  }

  const coinMetrics = {};
  const rawHealthPct = {};
  let totalUsdMedian = 0;

  for (const coin of activeCoins) {
    const dailyPeaks = coinsData[coin].daily_peaks || [];
    const recentBalances = coinsData[coin].recent_balances || [];
    const price = Number(prices[coin]) || 0;

    const medianVal = median(dailyPeaks);
    const window3 = recentBalances.slice(-3);
    const maVal = window3.length
      ? window3.reduce((sum, v) => sum + (Number(v) || 0), 0) / window3.length
      : 0;

    const healthPct = medianVal > 0 ? Math.min(100.0, (maVal / medianVal) * 100.0) : 0.0;
    const medianUsd = price > 0 ? medianVal * price : 0;

    totalUsdMedian += medianUsd;
    rawHealthPct[coin] = healthPct;
    coinMetrics[coin] = {
      price,
      median: medianVal,
      ma: maVal,
      health_pct: round(healthPct, 2),
      median_usd: medianUsd,
      weight_pct: 0,
    };
  }

  if (totalUsdMedian <= 0) {
    return {
      url,
      is_enabled: isEnabled,
      health_score: 0.0,
      coins: coinMetrics,
      coins_count: activeCoins.length,
      total_usd_median: 0,
    };
  }

  let totalScore = 0;
  for (const coin of activeCoins) {
    const weightPct = (coinMetrics[coin].median_usd / totalUsdMedian) * 100.0;
    coinMetrics[coin].weight_pct = round(weightPct, 2);
    totalScore += (rawHealthPct[coin] * weightPct) / 100.0;
  }

  return {
    url,
    is_enabled: isEnabled,
    health_score: round(totalScore, 2),
    coins: coinMetrics,
    coins_count: activeCoins.length,
    total_usd_median: round(totalUsdMedian, 2),
  };
}

module.exports = {
  round,
  median,
  coinUsdValue,
  calculateHealthScore,
};
