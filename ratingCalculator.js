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
  if (v === 0) return 0;
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
  const block1Enabled = weights.block_1_enabled !== undefined ? weights.block_1_enabled : true;
  const block2Enabled = weights.block_2_enabled !== undefined ? weights.block_2_enabled : true;
  const block3Enabled = weights.block_3_enabled !== undefined ? weights.block_3_enabled : true;
  const block4Enabled = weights.block_4_enabled !== undefined ? weights.block_4_enabled : false;
  
  const rawWeightBlock1 = weights.block_1_solvency !== undefined ? weights.block_1_solvency : 0.70;
  const rawWeightBlock2 = weights.block_2_reliability !== undefined ? weights.block_2_reliability : 0.30;
  const rawWeightBlock3 = weights.block_3_uii !== undefined ? weights.block_3_uii : 0.20;
  const rawWeightBlock4 = weights.block_4_bonus !== undefined ? weights.block_4_bonus : 0.02;
  
  const block1Max = ratingConfig.block_1_max_points !== undefined ? ratingConfig.block_1_max_points : 100.0;
  const block2Max = ratingConfig.block_2_max_points !== undefined ? ratingConfig.block_2_max_points : 100.0;
  const block3Max = rawWeightBlock3 * 100;
  const block4Max = rawWeightBlock4 * 100;
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
      details: { daily_volume_pts: 0, health_pts: 0, activity_pts: 0 },
    },
    block_2: {
      score: 0.0,
      weighted: 0.0,
      details: { age_pts: 0, payout_type_pts: 0, gateways_pts: 0 },
    },
    block_3: { score: 0.0, weighted: 0.0 },
    block_4: { score: 0.0, weighted: 0.0 },
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

  const volRef = (payouts.daily_volume_reference != null)
    ? payouts.daily_volume_reference
    : median(payouts.daily_volume_usd_7d_medians || []);
  const dailyVolumePts = getPointsFromThresholds(volRef, ratingConfig.daily_volume_usd);

  const healthRef = (faucetData.payouts && faucetData.payouts.health_reference != null)
    ? faucetData.payouts.health_reference
    : median(faucetData.daily_health_medians_7d || []);
  const healthPts = getPointsFromThresholds(healthRef, ratingConfig.health_score);

  const activityRef = (payouts.payout_activity_hours != null)
    ? payouts.payout_activity_hours
    : (payouts.hours_since_last_payout != null ? payouts.hours_since_last_payout : 0);
  const activityPts = getPointsFromThresholds(activityRef, ratingConfig.payout_activity_hours);

  const block1Raw = dailyVolumePts + healthPts + activityPts;
  const block1Score = Math.min(block1Max, block1Raw);

  const agePts = getPointsFromThresholds(faucetData.age_months, ratingConfig.age_months);
  const payoutTypeMap = ratingConfig.payout_type || {};
  const ptRaw = faucetData.payout_type;
  const payoutTypePts = (ptRaw == null || ptRaw === '') ? 0
    : (payoutTypeMap[String(ptRaw).toLowerCase()] !== undefined
      ? payoutTypeMap[String(ptRaw).toLowerCase()]
      : 0);
  const gatewaysPts = getPointsFromThresholds(faucetData.gateways_count, ratingConfig.gateways_count);

  const block2Raw = agePts + payoutTypePts + gatewaysPts;
  const block2Score = Math.min(block2Max, block2Raw);

  const block3Score = clamp(Number(faucetData.uii) || 0, 0, block3Max);
  const block4Score = clamp(Number(faucetData.bonus_points) || 0, 0, block4Max);

  const block1Contrib = block1Enabled ? block1Max * rawWeightBlock1 : 0;
  const block2Contrib = block2Enabled ? block2Max * rawWeightBlock2 : 0;
  const block3Contrib = block3Enabled ? block3Max : 0;
  const block4Contrib = block4Enabled ? block4Max : 0;
  const totalMaxContrib = block1Contrib + block2Contrib + block3Contrib + block4Contrib;

  const b1Raw = block1Enabled ? block1Score * rawWeightBlock1 : 0;
  const b2Raw = block2Enabled ? block2Score * rawWeightBlock2 : 0;
  const b3Raw = block3Enabled ? block3Score : 0;
  const b4Raw = block4Enabled ? block4Score : 0;
  const rawSum = b1Raw + b2Raw + b3Raw + b4Raw;

  const baseRating = totalMaxContrib > 0 ? (rawSum / totalMaxContrib) * finalMax : 0;
  const finalRating = Math.min(finalMax, baseRating);

  return {
    url,
    final_rating: round(finalRating, 2),
    letter_grade: ratingFromScore(finalRating, letterThresholds).grade,
    base_rating: round(baseRating, 2),
    overall_health_pct: round(healthRef, 2),
    block_1: {
      score: block1Enabled ? round(block1Score, 2) : 0.0,
      weighted: block1Enabled ? round(block1Score * rawWeightBlock1, 2) : 0.0,
      enabled: block1Enabled,
      details: {
        daily_volume_pts: block1Enabled ? dailyVolumePts : 0,
        health_pts: block1Enabled ? healthPts : 0,
        activity_pts: block1Enabled ? activityPts : 0,
      },
    },
    block_2: {
      score: block2Enabled ? round(block2Score, 2) : 0.0,
      weighted: block2Enabled ? round(block2Score * rawWeightBlock2, 2) : 0.0,
      enabled: block2Enabled,
      details: {
        age_pts: block2Enabled ? agePts : 0,
        payout_type_pts: block2Enabled ? payoutTypePts : 0,
        gateways_pts: block2Enabled ? gatewaysPts : 0,
      },
    },
    block_3: {
      score: block3Enabled ? round(block3Score, 2) : 0.0,
      weighted: block3Enabled ? round(block3Score, 2) : 0.0,
      enabled: block3Enabled,
    },
    block_4: {
      score: block4Enabled ? round(block4Score, 2) : 0.0,
      weighted: block4Enabled ? round(block4Score, 2) : 0.0,
      enabled: block4Enabled,
    },
    _weights: {
      block_1_solvency: round(rawWeightBlock1, 4),
      block_2_reliability: round(rawWeightBlock2, 4),
      block_3_uii: round(rawWeightBlock3, 4),
      block_4_bonus: round(rawWeightBlock4, 4),
      block_1_enabled: block1Enabled,
      block_2_enabled: block2Enabled,
      block_3_enabled: block3Enabled,
      block_4_enabled: block4Enabled,
      total_max_contrib: round(totalMaxContrib, 2),
    },
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
