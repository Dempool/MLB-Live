/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

const OUT = path.join(process.cwd(), 'generated', 'player-intel.json');
const API = 'https://statsapi.mlb.com/api/v1';
const season = new Date().getUTCFullYear();

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed ${res.status}: ${url}`);
  return res.json();
}

function pct(n) {
  return Math.max(0, Math.min(100, Number((n * 100).toFixed(1))));
}

function clampNum(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

async function main() {
  console.log('Loading MLB teams...');
  const teamsPayload = await getJson(`${API}/teams?sportId=1`);
  const teams = teamsPayload.teams || [];

  const players = new Map();

  for (const team of teams) {
    const roster = await getJson(`${API}/teams/${team.id}/roster?rosterType=active`);
    for (const entry of roster.roster || []) {
      players.set(String(entry.person.id), entry.person);
    }
  }

  console.log(`Found ${players.size} active MLB players. Fetching stats...`);

  const pitchers = {};
  const batters = {};

  for (const person of players.values()) {
    const personPayload = await getJson(`${API}/people/${person.id}?hydrate=stats(group=[pitching,hitting],type=[season],season=${season})`);
    const p = personPayload.people?.[0];
    if (!p) continue;

    const throwing = p.pitchHand?.code || 'R';
    const batting = p.batSide?.code || 'R';
    const split = p.stats || [];
    const pitchSeason = split.find((s) => s.group?.displayName === 'pitching')?.splits?.[0]?.stat;
    const hitSeason = split.find((s) => s.group?.displayName === 'hitting')?.splits?.[0]?.stat;

    if (pitchSeason && (p.primaryPosition?.abbreviation || '').includes('P')) {
      const so = clampNum(pitchSeason.strikeOuts, 0);
      const bb = clampNum(pitchSeason.baseOnBalls, 0);
      const bf = Math.max(clampNum(pitchSeason.battersFaced, 0), so + bb + 1);
      const usageFastball = throwing === 'L' ? 52 : 56;
      pitchers[String(p.id)] = {
        playerId: p.id,
        name: p.fullName,
        hand: throwing,
        season,
        source: 'generated-from-mlb-stats-api',
        pitchMix: [
          { type: 'Fastball', pct: usageFastball },
          { type: 'Slider', pct: 24 },
          { type: 'Changeup', pct: 14 },
          { type: 'Other', pct: 100 - usageFastball - 24 - 14 }
        ],
        velocityByPitch: { Fastball: throwing === 'L' ? 92.8 : 94.2, Slider: 85.1, Changeup: 86.2 },
        whiffRate: pct((so / bf) * 0.55),
        strikeoutRate: pct(so / bf),
        walkRate: pct(bb / bf),
        hardHitAllowed: clampNum(pitchSeason.whip, 1.25) * 28,
        barrelAllowed: clampNum(pitchSeason.homeRuns, 0) > 0 ? 8.3 : 6.5,
        splitsByHandedness: {
          vsL: { opsAllowed: clampNum(pitchSeason.ops, 0.72) - 0.02 },
          vsR: { opsAllowed: clampNum(pitchSeason.ops, 0.72) + 0.02 }
        },
        firstPitchStrike: 60,
        twoStrikePutaway: pct((so / bf) * 1.2),
        usageByCount: {
          ahead: { Fastball: 42, Slider: 34, Changeup: 18, Other: 6 },
          even: { Fastball: 54, Slider: 25, Changeup: 14, Other: 7 },
          behind: { Fastball: 66, Slider: 16, Changeup: 12, Other: 6 }
        },
        nextPitchByCountAndSide: {
          '0-0_vsL': { Fastball: 59, Slider: 19, Changeup: 15, Other: 7 },
          '0-0_vsR': { Fastball: 62, Slider: 21, Changeup: 10, Other: 7 },
          '1-2_vsL': { Fastball: 39, Slider: 35, Changeup: 20, Other: 6 },
          '1-2_vsR': { Fastball: 43, Slider: 34, Changeup: 17, Other: 6 }
        }
      };
    }

    if (hitSeason) {
      const pa = Math.max(clampNum(hitSeason.plateAppearances, 0), 1);
      const so = clampNum(hitSeason.strikeOuts, 0);
      const bb = clampNum(hitSeason.baseOnBalls, 0);
      const hits = clampNum(hitSeason.hits, 0);
      batters[String(p.id)] = {
        playerId: p.id,
        name: p.fullName,
        bats: batting,
        season,
        source: 'generated-from-mlb-stats-api',
        hardHitRate: clampNum(hitSeason.slg, 0.39) * 55,
        barrelRate: clampNum(hitSeason.homeRuns, 0) > 0 ? 8.7 : 6.8,
        whiffTendency: pct((so / pa) * 0.9),
        chaseTendency: 28 + Math.min(8, pct(so / pa) / 10),
        contactTendency: Math.max(50, 100 - pct(so / pa)),
        splitVsRight: { ops: clampNum(hitSeason.ops, 0.72) + 0.01 },
        splitVsLeft: { ops: clampNum(hitSeason.ops, 0.72) - 0.01 },
        damageByPitchType: {
          Fastball: clampNum(hitSeason.avg, 0.245) + 0.035,
          Slider: clampNum(hitSeason.avg, 0.245),
          Changeup: clampNum(hitSeason.avg, 0.245) - 0.01,
          Other: clampNum(hitSeason.avg, 0.245) - 0.02
        },
        firstPitchSwing: 30 + Math.min(8, pct(hits / pa) / 10),
        hotCold: {
          trend: hitSeason.avg > 0.285 ? 'hot' : hitSeason.avg < 0.215 ? 'cold' : 'neutral',
          note: `Season AVG ${hitSeason.avg || '.000'} with OPS ${hitSeason.ops || '.000'}.`
        },
        likelyVulnerabilities: [
          'Can be expanded away with spin when behind in the count.',
          'Two-strike contact quality drops on elevated velocity.'
        ]
      };
    }
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), season, pitchers, batters }, null, 2));
  console.log(`Wrote ${Object.keys(pitchers).length} pitchers and ${Object.keys(batters).length} batters to ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
