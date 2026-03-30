const fs = require('fs');
const path = require('path');

const DATA_PATH = path.join(process.cwd(), 'generated', 'player-intel.json');

let cache = { generatedAt: null, pitchers: {}, batters: {} };

function loadIntel() {
  try {
    if (fs.existsSync(DATA_PATH)) {
      cache = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
    }
  } catch (err) {
    console.warn('Failed to load generated intelligence dataset:', err.message);
  }
  return cache;
}

function getPitcher(playerId) {
  return cache.pitchers?.[String(playerId)] || null;
}

function getBatter(playerId) {
  return cache.batters?.[String(playerId)] || null;
}

function toPercent(value, fallback = 0) {
  if (typeof value !== 'number' || Number.isNaN(value)) return fallback;
  return Math.max(0, Math.min(100, Number(value.toFixed(1))));
}

function buildFallbackPitcher(person) {
  const hand = person?.pitchHand?.code || 'R';
  return {
    playerId: person?.id || null,
    name: person?.fullName || 'Unknown Pitcher',
    hand,
    source: 'fallback-profile',
    pitchMix: [
      { type: 'Fastball', pct: hand === 'L' ? 53 : 57 },
      { type: 'Slider', pct: 24 },
      { type: 'Changeup', pct: 14 },
      { type: 'Other', pct: 9 }
    ],
    velocityByPitch: { Fastball: hand === 'L' ? 93.1 : 94.4, Slider: 85.2, Changeup: 86.4 },
    whiffRate: 26,
    strikeoutRate: 24,
    walkRate: 8,
    hardHitAllowed: 37,
    barrelAllowed: 8,
    splitsByHandedness: { vsL: { opsAllowed: 0.695 }, vsR: { opsAllowed: 0.721 } },
    firstPitchStrike: 61,
    twoStrikePutaway: 29,
    usageByCount: {
      ahead: { Fastball: 44, Slider: 34, Changeup: 16, Other: 6 },
      even: { Fastball: 55, Slider: 25, Changeup: 13, Other: 7 },
      behind: { Fastball: 65, Slider: 16, Changeup: 12, Other: 7 }
    },
    nextPitchByCountAndSide: {
      '0-0_vsL': { Fastball: 58, Slider: 19, Changeup: 15, Other: 8 },
      '0-0_vsR': { Fastball: 61, Slider: 21, Changeup: 11, Other: 7 }
    }
  };
}

function buildFallbackBatter(person) {
  const bats = person?.batSide?.code || 'R';
  return {
    playerId: person?.id || null,
    name: person?.fullName || 'Unknown Batter',
    bats,
    source: 'fallback-profile',
    hardHitRate: 38,
    barrelRate: 9,
    whiffTendency: 25,
    chaseTendency: 30,
    contactTendency: 74,
    splitVsRight: { ops: 0.731 },
    splitVsLeft: { ops: 0.712 },
    damageByPitchType: { Fastball: 0.305, Slider: 0.272, Changeup: 0.261, Other: 0.248 },
    firstPitchSwing: 31,
    hotCold: { trend: 'neutral', note: 'No strong short-term trend yet.' },
    likelyVulnerabilities: [
      'Can chase sliders off the outside corner when behind in the count.',
      'Contact quality drops on elevated fastballs with two strikes.'
    ]
  };
}

module.exports = {
  loadIntel,
  getPitcher,
  getBatter,
  buildFallbackPitcher,
  buildFallbackBatter,
  toPercent
};
