function median(values) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  const nums = values.map(Number).filter((v) => !isNaN(v));
  if (nums.length === 0) return 0;
  nums.sort((a, b) => a - b);
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 === 0 ? (nums[mid - 1] + nums[mid]) / 2 : nums[mid];
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round(value, decimals) {
  const p = Math.pow(10, decimals);
  return Math.round((value + Number.EPSILON) * p) / p;
}

function ratingFromScore(score, thresholds) {
  if (score === null || score === undefined || isNaN(score)) {
    return { grade: null, score };
  }
  const GRADE_RANK = { A: 0, B: 1, C: 2, D: 3, F: 4 };
  const grades = Object.keys(thresholds || {}).sort((a, b) => ((GRADE_RANK[a] != null ? GRADE_RANK[a] : 99) - (GRADE_RANK[b] != null ? GRADE_RANK[b] : 99)));
  for (const grade of grades) {
    if (score >= thresholds[grade]) {
      return { grade, score };
    }
  }
  return { grade: grades[grades.length - 1] || null, score };
}

function getPointsFromThresholds(value, scale) {
  const thresholds = scale && Array.isArray(scale.thresholds) ? scale.thresholds : [];
  if (value === null || value === undefined || value === '') return 0;
  const v = Number(value);
  if (!isFinite(v)) return 0;
  for (const t of thresholds) {
    let ok = true;
    if (typeof t.min === 'number') {
      ok = ok && (t.exclusive ? v > t.min : v >= t.min);
    }
    if (typeof t.max === 'number') {
      ok = ok && (t.exclusive ? v < t.max : v <= t.max);
    }
    if (ok) return t.points;
  }
  return 0;
}

function ratioValue(actual, expected, fallback) {
  const exp = Number(expected);
  if (exp > 0) {
    return Number(actual) / exp;
  }
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

function calculateRating(faucetData, healthScoreResult, config) {
  const url = faucetData ? faucetData.url : null;
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

  const zeroResult = () => ({
    url,
    final_rating: 0.0,
    letter_grade: 'F',
    base_rating: 0.0,
    overall_health_pct: 0,
    block_1: {
      score: 0.0,
      weighted: 0.0,
      details: { daily_volume_pts: 0, rvi_pts: 0, health_pts: 0, activity_pts: 0, rai_pts: 0 },
    },
    block_2: {
      score: 0.0,
      weighted: 0.0,
      details: { age_pts: 0, payout_type_pts: 0, gateways_pts: 0 },
    },
    uii_applied: round(clamp(Number(faucetData && faucetData.uii) || 1.0, uiiMin, uiiMax), 2),
  });

  const isEnabled = !faucetData || faucetData.is_enabled !== false;
  // Same rule as Health Score: a faucet is rated only if at least one coin held
  // a non-zero balance in the trailing 7-day window (not just "right now").
  const coinsData = (faucetData && faucetData.coins) || {};
  const hasActiveCoin = Object.keys(coinsData).some((c) => {
    const cd = coinsData[c];
    const positive = (arr) => (arr || []).some((v) => Number(v) > 0);
    return positive(cd.daily_peaks) || positive(cd.recent_balances);
  });
  if (!isEnabled || !hasActiveCoin) {
    return zeroResult();
  }

  const payouts = (faucetData && faucetData.payouts) || {};

  const volMedian = median(payouts.daily_volume_usd_7d_medians);
  const dailyVolumePts = getPointsFromThresholds(volMedian, ratingConfig.daily_volume_usd);

  const rviFallback = ratingConfig.rvi && ratingConfig.rvi.fallback_ratio !== undefined
    ? ratingConfig.rvi.fallback_ratio : 1.0;
  const rvi = ratioValue(payouts.v_3h_actual, payouts.v_3h_expected_median, rviFallback);
  const rviPts = getPointsFromThresholds(rvi, ratingConfig.rvi);

  const overallHealth = median(faucetData.daily_health_medians_7d);
  const healthPts = getPointsFromThresholds(overallHealth, ratingConfig.health_score);

  const hoursSince = payouts.hours_since_last_payout;
  const activityPts = getPointsFromThresholds(hoursSince, ratingConfig.payout_activity_hours);

  const raiFallback = ratingConfig.rai && ratingConfig.rai.fallback_ratio !== undefined
    ? ratingConfig.rai.fallback_ratio : 1.0;
  const rai = ratioValue(payouts.n_3h_actual, payouts.n_3h_expected_median, raiFallback);
  const raiPts = getPointsFromThresholds(rai, ratingConfig.rai);

  const block1Raw = dailyVolumePts + rviPts + healthPts + activityPts + raiPts;
  const block1Score = Math.min(block1Max, block1Raw);

  const agePts = getPointsFromThresholds(faucetData.age_months, ratingConfig.age_months);
  const payoutTypeMap = ratingConfig.payout_type || {};
  const ptRaw = faucetData.payout_type;
  const payoutTypePts = (ptRaw == null || ptRaw === '') ? 0
    : (payoutTypeMap[String(ptRaw).toLowerCase()] !== undefined
      ? payoutTypeMap[String(ptRaw).toLowerCase()]
      : (payoutTypeMap.manual !== undefined ? payoutTypeMap.manual : 10.0));
  const gatewaysPts = getPointsFromThresholds(faucetData.gateways_count, ratingConfig.gateways_count);

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
      details: {
        daily_volume_pts: dailyVolumePts,
        rvi_pts: rviPts,
        health_pts: healthPts,
        activity_pts: activityPts,
        rai_pts: raiPts,
      },
    },
    block_2: {
      score: round(block2Score, 2),
      weighted: round(block2Score * weightBlock2, 2),
      details: {
        age_pts: agePts,
        payout_type_pts: payoutTypePts,
        gateways_pts: gatewaysPts,
      },
    },
    uii_applied: round(uiiApplied, 2),
  };
}

module.exports = {
  median,
  clamp,
  round,
  ratingFromScore,
  getPointsFromThresholds,
  ratioValue,
  totalCurrentBalance,
  calculateRating,
};
