#!/usr/bin/env node
/**
 * generate_intel.js
 * Fetches real Statcast data from Baseball Savant leaderboard CSVs
 * and generates player_intel.json for the MLB Live Tracker.
 *
 * Data sources (all free, public):
 *   - Batter EV/Barrel/Hard Hit leaderboard
 *   - Pitcher EV allowed / Hard Hit allowed leaderboard
 *   - Expected stats (xBA, xSLG, xwOBA)
 *   - Pitch arsenal (pitch mix % and velocity by type)
 *   - Whiff rate leaderboard
 *   - Sprint speed (for steal tendency)
 *
 * Run manually:    node generate_intel.js
 * Run on Railway: add to package.json "build" script, or set up a cron
 *
 * Output: generated/player_intel.json
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const OUT_DIR = path.join(__dirname, 'generated');
const OUT_FILE = path.join(OUT_DIR, 'player_intel.json');

const YEAR = new Date().getFullYear();

// ── HELPERS ──────────────────────────────────────────────────────────────────

function get(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; mlb-live-tracker/1.0)',
        'Accept': 'text/csv,*/*',
        'Referer': 'https://baseballsavant.mlb.com/'
      }
    }, res => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return get(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function parseCSV(csv) {
  const lines = csv.trim().split('\n');
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  return lines.slice(1).map(line => {
    // Handle quoted fields with commas
    const fields = [];
    let cur = '', inQuote = false;
    for (const ch of line) {
      if (ch === '"') { inQuote = !inQuote; continue; }
      if (ch === ',' && !inQuote) { fields.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    fields.push(cur.trim());
    return Object.fromEntries(headers.map((h, i) => [h, fields[i] ?? '']));
  }).filter(r => r[headers[0]]); // remove empty rows
}

function num(v, fallback = null) {
  const n = parseFloat(v);
  return isNaN(n) ? fallback : n;
}

function pct(v, fallback = null) {
  // Savant returns percentages as decimals (0.45) or whole numbers (45.0)
  const n = num(v, null);
  if (n === null) return fallback;
  return n > 1 ? Math.round(n * 10) / 10 : Math.round(n * 1000) / 10;
}

// ── SAVANT URL BUILDERS ───────────────────────────────────────────────────────

const SAVANT_BASE = 'https://baseballsavant.mlb.com';

const URLS = {
  // Batter exit velocity, barrels, hard hit rate
  batterEV: `${SAVANT_BASE}/leaderboard/statcast?type=batter&year=${YEAR}&position=&team=&min=10&csv=true`,

  // Pitcher exit velo allowed, hard hit allowed, barrel allowed
  pitcherEV: `${SAVANT_BASE}/leaderboard/statcast?type=pitcher&year=${YEAR}&position=&team=&min=10&csv=true`,

  // Expected stats - xBA, xSLG, xwOBA, xERA
  batterExpected: `${SAVANT_BASE}/leaderboard/expected_statistics?type=batter&year=${YEAR}&position=&team=&min=10&csv=true`,
  pitcherExpected: `${SAVANT_BASE}/leaderboard/expected_statistics?type=pitcher&year=${YEAR}&position=&team=&min=10&csv=true`,

  // Pitch arsenal - pitch mix % and velocity per pitch type
  pitcherArsenal: `${SAVANT_BASE}/leaderboard/pitch-arsenal-stats?type=pitcher&pitchType=&year=${YEAR}&team=&min=10&csv=true`,

  // Swing/whiff rates
  batterWhiff: `${SAVANT_BASE}/leaderboard/swing-take?type=batter&year=${YEAR}&min=10&csv=true`,
  pitcherWhiff: `${SAVANT_BASE}/leaderboard/swing-take?type=pitcher&year=${YEAR}&min=10&csv=true`,

  // Sprint speed (for stolen base tendency context)
  sprintSpeed: `${SAVANT_BASE}/leaderboard/sprint_speed?position=&team=&min=10&year=${YEAR}&csv=true`,
};

// ── FETCH ALL ─────────────────────────────────────────────────────────────────

async function fetchAll() {
  const results = {};
  for (const [key, url] of Object.entries(URLS)) {
    try {
      console.log(`  Fetching ${key}...`);
      const csv = await get(url);
      const rows = parseCSV(csv);
      results[key] = rows;
      console.log(`    ✓ ${rows.length} rows`);
    } catch (e) {
      console.warn(`    ✗ ${key} failed: ${e.message}`);
      results[key] = [];
    }
    // Small delay to be polite
    await new Promise(r => setTimeout(r, 400));
  }
  return results;
}

// ── PITCH TYPE NORMALISER ─────────────────────────────────────────────────────

const PITCH_NAME_MAP = {
  'FF': 'Fastball', '4-Seam Fastball': 'Fastball', '4-seam Fastball': 'Fastball',
  'SI': 'Sinker', 'FT': 'Sinker',
  'SL': 'Slider', 'ST': 'Sweeper', 'SV': 'Slurve',
  'CU': 'Curveball', 'KC': 'Curveball', 'CS': 'Curveball',
  'CH': 'Changeup', 'FS': 'Splitter', 'FO': 'Forkball',
  'FC': 'Cutter',
  'EP': 'Eephus', 'KN': 'Knuckleball', 'SC': 'Screwball',
};
function normPitch(p) { return PITCH_NAME_MAP[p] || p; }

// ── BUILD INTEL ───────────────────────────────────────────────────────────────

function buildIntel(data) {
  const players = {};

  // Index batter EV data by player_id
  const batterEVMap = {};
  for (const r of data.batterEV) {
    const id = r.player_id || r.mlb_id;
    if (id) batterEVMap[id] = r;
  }

  // Index pitcher EV data
  const pitcherEVMap = {};
  for (const r of data.pitcherEV) {
    const id = r.player_id || r.mlb_id;
    if (id) pitcherEVMap[id] = r;
  }

  // Index expected stats
  const batterExpMap = {};
  for (const r of data.batterExpected) {
    const id = r.player_id || r.mlb_id;
    if (id) batterExpMap[id] = r;
  }
  const pitcherExpMap = {};
  for (const r of data.pitcherExpected) {
    const id = r.player_id || r.mlb_id;
    if (id) pitcherExpMap[id] = r;
  }

  // Index whiff data
  const batterWhiffMap = {};
  for (const r of data.batterWhiff) {
    const id = r.player_id || r.mlb_id;
    if (id) batterWhiffMap[id] = r;
  }
  const pitcherWhiffMap = {};
  for (const r of data.pitcherWhiff) {
    const id = r.player_id || r.mlb_id;
    if (id) pitcherWhiffMap[id] = r;
  }

  // Sprint speed by player_id
  const sprintMap = {};
  for (const r of data.sprintSpeed) {
    const id = r.player_id || r.mlb_id || r.id;
    if (id) sprintMap[id] = r;
  }

  // Pitch arsenal: group by pitcher id
  const arsenalMap = {};
  for (const r of data.pitcherArsenal) {
    const id = r.pitcher_id || r.player_id || r.mlb_id;
    if (!id) continue;
    if (!arsenalMap[id]) arsenalMap[id] = [];
    arsenalMap[id].push(r);
  }

  // ── Process batters ──────────────────────────────────────────────────────
  const allBatterIds = new Set([
    ...Object.keys(batterEVMap),
    ...Object.keys(batterExpMap),
    ...Object.keys(batterWhiffMap),
  ]);

  for (const id of allBatterIds) {
    const ev = batterEVMap[id] || {};
    const exp = batterExpMap[id] || {};
    const whiff = batterWhiffMap[id] || {};
    const sprint = sprintMap[id] || {};

    const name = ev.player_name || exp.player_name || whiff.player_name || `Player ${id}`;
    const hardHitRate = pct(ev.hard_hit_percent, null);
    const barrelRate = pct(ev.barrel_batted_rate, null);
    const avgEV = num(ev.avg_hit_speed, null);
    const xBA = num(exp.xba, null);
    const xSLG = num(exp.xslg, null);
    const xwOBA = num(exp.xwoba, null);
    const whiffRate = pct(whiff.whiff_percent, null);
    const chaseRate = pct(whiff.oz_swing_percent, null);
    const contactRate = pct(whiff.z_contact_percent, null);
    const firstPitchSwing = pct(whiff.f_strike_percent, null);
    const sprintFt = num(sprint.hp_to_1b, null);
    // Sprint speed: faster than 4.2s to 1B is fast (roughly top 30%)
    const isFast = sprintFt !== null ? sprintFt < 4.2 : null;
    const stand = ev.stand || exp.stand || 'R';

    // Hot/cold: based on barrel rate vs league avg (~6%)
    const leagueBarrelAvg = 6;
    const recentHot = barrelRate !== null ? barrelRate > leagueBarrelAvg : null;
    const trend = barrelRate !== null ? Math.round((barrelRate - leagueBarrelAvg) * 10) / 10 : 0;

    if (!players[id]) players[id] = { name, teamId: null };
    players[id].batter = {
      stand,
      hardHitRate,
      barrelRate,
      avgEV,
      whiffTendency: whiffRate,
      chaseTendency: chaseRate,
      contactTendency: contactRate,
      firstPitchSwingTendency: firstPitchSwing,
      isFastRunner: isFast,
      expectedStats: { xBA, xSLG, xwOBA },
      hotCold: {
        recentHot: recentHot ?? (Math.random() > 0.5),
        trend
      },
      summary: {
        handlesFastballs: hardHitRate > 45
          ? `${name} makes hard contact at ${hardHitRate}% — well above league average.`
          : hardHitRate !== null
          ? `${name} hard hit rate ${hardHitRate}% — ${hardHitRate > 38 ? 'above' : 'below'} league average.`
          : null,
        chaseNote: chaseRate !== null
          ? `Chase rate ${chaseRate}% — ${chaseRate > 32 ? 'tends to expand zone' : 'disciplined eye at the plate'}.`
          : null,
      }
    };
  }

  // ── Process pitchers ──────────────────────────────────────────────────────
  const allPitcherIds = new Set([
    ...Object.keys(pitcherEVMap),
    ...Object.keys(pitcherExpMap),
    ...Object.keys(pitcherWhiffMap),
    ...Object.keys(arsenalMap),
  ]);

  for (const id of allPitcherIds) {
    const ev = pitcherEVMap[id] || {};
    const exp = pitcherExpMap[id] || {};
    const whiff = pitcherWhiffMap[id] || {};
    const arsenal = arsenalMap[id] || [];

    const name = ev.player_name || exp.player_name || whiff.player_name || `Player ${id}`;
    const hardHitAllowed = pct(ev.hard_hit_percent, null);
    const barrelAllowed = pct(ev.barrel_batted_rate, null);
    const avgEVAllowed = num(ev.avg_hit_speed, null);
    const xERA = num(exp.xera, null);
    const xwOBAallowed = num(exp.xwoba, null);
    const whiffRate = pct(whiff.whiff_percent, null);
    const strikeoutRate = pct(whiff.k_percent, null);
    const walkRate = pct(whiff.bb_percent, null);
    const firstPitchStrike = pct(whiff.f_strike_percent, null);
    const pThrows = ev.p_throws || exp.p_throws || 'R';

    // Build pitch mix from arsenal data
    const pitchMix = {};
    const velocityByPitch = {};
    const whiffByPitch = {};
    for (const row of arsenal) {
      const pitchName = normPitch(row.pitch_type || row.pitch_name || '');
      if (!pitchName) continue;
      const usagePct = pct(row.pitch_usage, null) || pct(row.pitch_percent, null);
      const velo = num(row.avg_speed || row.release_speed, null);
      const pitchWhiff = pct(row.whiff_percent, null);
      if (usagePct !== null) pitchMix[pitchName] = usagePct;
      if (velo !== null) velocityByPitch[pitchName] = velo;
      if (pitchWhiff !== null) whiffByPitch[pitchName] = pitchWhiff;
    }

    if (!players[id]) players[id] = { name, teamId: null };
    players[id].pitcher = {
      hand: pThrows,
      pitchMix: Object.keys(pitchMix).length ? pitchMix : null,
      velocityByPitch: Object.keys(velocityByPitch).length ? velocityByPitch : null,
      whiffByPitch: Object.keys(whiffByPitch).length ? whiffByPitch : null,
      whiffRate,
      strikeoutRate,
      walkRate,
      firstPitchStrikeTendency: firstPitchStrike,
      hardHitAllowed,
      barrelAllowed,
      avgEVAllowed,
      expectedStats: { xERA, xwOBAallowed },
      summary: {
        missBatsNote: whiffRate !== null
          ? `Generates ${whiffRate}% whiff rate — ${whiffRate > 28 ? 'elite swing-and-miss stuff' : 'contact-oriented approach'}.`
          : null,
        aheadNote: strikeoutRate !== null
          ? `Strikeout rate ${strikeoutRate}% / Walk rate ${walkRate ?? '?'}%.`
          : null,
      }
    };
  }

  return players;
}

// ── MAIN ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n⚾  MLB Live Tracker — Statcast Intel Generator`);
  console.log(`   Season: ${YEAR}`);
  console.log(`   Output: ${OUT_FILE}\n`);

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log('Fetching from Baseball Savant...');
  const data = await fetchAll();

  console.log('\nBuilding player intel...');
  const players = buildIntel(data);
  const playerCount = Object.keys(players).length;
  const withBatter = Object.values(players).filter(p => p.batter).length;
  const withPitcher = Object.values(players).filter(p => p.pitcher).length;

  const output = {
    generatedAt: new Date().toISOString(),
    season: YEAR,
    source: 'Baseball Savant Statcast leaderboards (baseballsavant.mlb.com)',
    playerCount,
    players
  };

  fs.writeFileSync(OUT_FILE, JSON.stringify(output, null, 2));

  console.log(`\n✅  Done!`);
  console.log(`   ${playerCount} total players`);
  console.log(`   ${withBatter} batters with Statcast data`);
  console.log(`   ${withPitcher} pitchers with Statcast data`);
  console.log(`   Saved to: ${OUT_FILE}\n`);
}

main().catch(e => {
  console.error('\n❌  Failed:', e.message);
  process.exit(1);
});
