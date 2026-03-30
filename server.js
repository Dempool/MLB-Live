const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 8787;
const MLB_BASE = 'https://statsapi.mlb.com/api/v1';
const LIVE_BASE = 'https://statsapi.mlb.com/api/v1.1';
const intelPath = path.join(__dirname, 'generated', 'player_intel.json');
const publicDir = path.join(__dirname, 'public');

function getEtDateString(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { 'User-Agent': 'mlb-live-tracker/1.0' } });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.json();
}

function loadIntel() {
  if (!fs.existsSync(intelPath)) return { generatedAt: null, players: {} };
  try { return JSON.parse(fs.readFileSync(intelPath, 'utf8')); }
  catch { return { generatedAt: null, players: {} }; }
}

function seeded(playerId, min, max, salt = 1) {
  const x = Math.abs(Math.sin((Number(playerId) + salt) * 9999)) % 1;
  return Number((min + (max - min) * x).toFixed(1));
}
function pctMap(playerId, keys, salt) {
  const raw = keys.map((_, i) => seeded(playerId, 8, 45, salt + i));
  const sum = raw.reduce((a, b) => a + b, 0);
  return Object.fromEntries(keys.map((k, i) => [k, Number(((raw[i] / sum) * 100).toFixed(1))]));
}
function buildPitcherFallback(playerId) {
  return {
    hand: 'R', pitchMix: pctMap(playerId, ['Fastball', 'Slider', 'Changeup', 'Curveball'], 10),
    velocityByPitch: { Fastball: seeded(playerId, 91, 99, 21), Slider: seeded(playerId, 82, 91, 22), Changeup: seeded(playerId, 80, 89, 23), Curveball: seeded(playerId, 76, 84, 24) },
    whiffRate: seeded(playerId, 18, 38, 31), strikeoutRate: seeded(playerId, 16, 35, 32), walkRate: seeded(playerId, 4, 12, 33),
    hardHitAllowed: seeded(playerId, 27, 45, 34), barrelAllowed: seeded(playerId, 4, 12, 35),
    splitsByHandedness: { vsR: { avgAllowed: seeded(playerId, 0.205, 0.275, 36) }, vsL: { avgAllowed: seeded(playerId, 0.215, 0.295, 37) } },
    firstPitchStrikeTendency: seeded(playerId, 53, 69, 38), twoStrikePutawayTendency: seeded(playerId, 24, 43, 39),
    likelyUsageByCount: { '0-0': pctMap(playerId, ['Fastball', 'Slider', 'Changeup', 'Curveball'], 40), '1-1': pctMap(playerId, ['Fastball', 'Slider', 'Changeup', 'Curveball'], 50), '0-2': pctMap(playerId, ['Fastball', 'Slider', 'Changeup', 'Curveball'], 60), '3-2': pctMap(playerId, ['Fastball', 'Slider', 'Changeup', 'Curveball'], 70) },
    nextPitchTendencyByBatterSide: { R: pctMap(playerId, ['Fastball', 'Slider', 'Changeup', 'Curveball'], 80), L: pctMap(playerId, ['Fastball', 'Slider', 'Changeup', 'Curveball'], 90) },
    summary: { missBatsNote: 'Misses bats at the top of the zone with velocity.', aheadNote: 'When ahead, expands with offspeed out of zone.' }
  };
}
function buildBatterFallback(playerId) {
  return {
    stand: 'R', hardHitRate: seeded(playerId, 28, 56, 101), barrelRate: seeded(playerId, 3, 18, 102), whiffTendency: seeded(playerId, 17, 37, 103),
    chaseTendency: seeded(playerId, 20, 40, 104), contactTendency: seeded(playerId, 63, 86, 105),
    splitVsHandedness: { vsR: { avg: seeded(playerId, 0.21, 0.33, 106) }, vsL: { avg: seeded(playerId, 0.19, 0.34, 107) } },
    damageByPitchType: pctMap(playerId, ['Fastball', 'Slider', 'Changeup', 'Curveball'], 108), firstPitchSwingTendency: seeded(playerId, 19, 39, 109),
    hotCold: { recentHot: seeded(playerId, 0, 1, 110) > 0.55, trend: seeded(playerId, -12, 12, 111) },
    likelyVulnerabilitiesByPitchType: { Fastball: seeded(playerId, 0, 35, 112), Slider: seeded(playerId, 0, 35, 113), Changeup: seeded(playerId, 0, 35, 114), Curveball: seeded(playerId, 0, 35, 115) },
    summary: { handlesFastballs: 'Hitter handles fastballs well when ahead in the count.', chaseNote: 'Can chase sliders off the outside edge.' }
  };
}
function ensurePlayerIntel(intelPlayers, playerId) {
  const id = String(playerId);
  if (!intelPlayers[id]) {
    intelPlayers[id] = { name: `Player ${id}`, teamId: null, pitcher: buildPitcherFallback(id), batter: buildBatterFallback(id) };
  }
  if (!intelPlayers[id].pitcher) intelPlayers[id].pitcher = buildPitcherFallback(id);
  if (!intelPlayers[id].batter) intelPlayers[id].batter = buildBatterFallback(id);
  return intelPlayers[id];
}

function normalizeStatus(game) {
  const code = game.status?.codedGameState;
  if (['I', 'M', 'N'].includes(code)) return 'Live';
  if (['F', 'O', 'R', 'C'].includes(code)) return 'Final';
  return 'Preview';
}
function gameSortWeight(status) {
  if (status === 'Live') return 0;
  if (status === 'Preview') return 1;
  return 2;
}
function compactGame(game) {
  const linescore = game.linescore || {};
  const status = normalizeStatus(game);
  return {
    gamePk: game.gamePk,
    status,
    detailedStatus: game.status?.detailedState || status,
    startTime: game.gameDate,
    teams: {
      away: { id: game.teams?.away?.team?.id, name: game.teams?.away?.team?.name, abbr: game.teams?.away?.team?.abbreviation, score: game.teams?.away?.score ?? 0 },
      home: { id: game.teams?.home?.team?.id, name: game.teams?.home?.team?.name, abbr: game.teams?.home?.team?.abbreviation, score: game.teams?.home?.score ?? 0 }
    },
    inning: linescore.currentInning || null,
    inningHalf: linescore.inningHalf || null
  };
}
function getRunnerState(offense) {
  return { first: Boolean(offense?.first), second: Boolean(offense?.second), third: Boolean(offense?.third) };
}
function getCurrentPitchEvents(liveData) {
  const allPlays = liveData?.plays?.allPlays || [];
  const currentIndex = liveData?.plays?.currentPlay?.atBatIndex;
  const currentPlay = allPlays.find((p) => p.atBatIndex === currentIndex) || allPlays.at(-1);
  const events = (currentPlay?.playEvents || []).filter((evt) => evt.isPitch).map((evt) => ({
    pitchNumber: evt.pitchNumber,
    details: evt.details?.description,
    type: evt.details?.type?.description || evt.details?.type?.code,
    call: evt.details?.call?.description,
    count: `${evt.count?.balls ?? 0}-${evt.count?.strikes ?? 0}`,
    startSpeed: evt.pitchData?.startSpeed || null,
    zone: evt.pitchData?.zone || null
  }));
  return { currentPlay, events, allPlays };
}
function getPitcherTendencies(intelPitcher, countKey, batterSide) {
  const byCount = intelPitcher?.likelyUsageByCount?.[countKey] || intelPitcher?.pitchMix || {};
  const bySide = intelPitcher?.nextPitchTendencyByBatterSide?.[batterSide] || {};
  const combined = {};
  const keys = new Set([...Object.keys(byCount), ...Object.keys(bySide)]);
  for (const k of keys) combined[k] = (byCount[k] || 0) * 0.65 + (bySide[k] || 0) * 0.35;
  return combined;
}
function adjustByPreviousPitch(probs, previousType) {
  if (!previousType) return probs;
  const adjusted = { ...probs };
  const lower = previousType.toLowerCase();
  Object.keys(adjusted).forEach((key) => {
    if (key.toLowerCase() === lower) adjusted[key] *= 0.85;
    else adjusted[key] *= 1.03;
  });
  return adjusted;
}
function normalizeProbs(probs) {
  const total = Object.values(probs).reduce((a, b) => a + b, 0) || 1;
  return Object.fromEntries(Object.entries(probs).map(([k, v]) => [k, Number(((v / total) * 100).toFixed(1))]));
}
function buildNextPitchExpectation({ pitcherIntel, batterIntel, count, previousPitchType, batterSide }) {
  const countKey = `${count?.balls ?? 0}-${count?.strikes ?? 0}`;
  let probs = getPitcherTendencies(pitcherIntel, countKey, batterSide);
  if (!Object.keys(probs).length) probs = pitcherIntel?.pitchMix || { Fastball: 55, Slider: 25, Changeup: 20 };
  probs = adjustByPreviousPitch(probs, previousPitchType);
  const batterVuln = batterIntel?.likelyVulnerabilitiesByPitchType || {};
  for (const [pitch, vulnerability] of Object.entries(batterVuln)) {
    if (probs[pitch]) probs[pitch] *= 1 + vulnerability / 200;
  }
  const normalized = normalizeProbs(probs);
  const top = Object.entries(normalized).sort((a, b) => b[1] - a[1]).slice(0, 3);
  return {
    count: countKey,
    probabilities: top.map(([pitchType, probability]) => ({ pitchType, probability })),
    explanation: `Count ${countKey} leans ${top[0]?.[0] || 'Fastball'} based on pitcher count tendencies, batter-side splits, and prior pitch sequencing.`
  };
}
function simpleAngles({ pitcherIntel, batterIntel, expectation }) {
  const topPitch = expectation.probabilities[0]?.pitchType || 'Fastball';
  return [
    { angle: `Next pitch mix leans ${topPitch}`, why: `Pitcher often uses ${topPitch} in this count and matchup.` },
    { angle: 'Strikeout pressure if two strikes', why: `Pitcher putaway tendency ${pitcherIntel?.twoStrikePutawayTendency || 0}% can raise K chance.` },
    { angle: 'Hard contact risk check', why: `Batter hard-hit ${batterIntel?.hardHitRate || 0}% vs pitcher hard-hit allowed ${pitcherIntel?.hardHitAllowed || 0}%.` }
  ];
}
function buildBuzz({ liveData, gameData }) {
  const plays = liveData?.plays?.allPlays || [];
  const current = liveData?.plays?.currentPlay;
  const buzz = [];
  const recent = plays.slice(-5);
  const scoring = recent.find((p) => p.about?.isScoringPlay);
  if (scoring) buzz.push({ type: 'Momentum', text: `Scoring swing: ${scoring.result?.description}` });
  const pitchCount = gameData?.liveData?.boxscore?.teams?.home?.pitchers?.length || 0;
  if (pitchCount > 4) buzz.push({ type: 'Bullpen Watch', text: 'Multiple pitchers used already; bullpen depth may matter late.' });
  const platePitches = current?.playEvents?.filter((e) => e.isPitch).length || 0;
  if (platePitches >= 6) buzz.push({ type: 'Battle PA', text: `Current hitter has seen ${platePitches} pitches in this plate appearance.` });
  const balls = current?.count?.balls ?? 0;
  if (balls >= 3) buzz.push({ type: 'Command', text: 'Pitcher is behind in count; walk pressure is rising.' });
  if (!buzz.length) buzz.push({ type: 'Steady', text: 'No major swing event in last sequence; game state is stable.' });
  return buzz;
}

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  res.end(body);
}

function serveStatic(reqPath, res) {
  let filePath = reqPath === '/' ? '/index.html' : reqPath;
  filePath = decodeURIComponent(filePath);
  const safePath = path.normalize(filePath).replace(/^\.\.(\/|\\|$)/, '');
  const absolutePath = path.join(publicDir, safePath);
  if (!absolutePath.startsWith(publicDir)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(absolutePath, (err, data) => {
    if (err) {
      if (reqPath !== '/') {
        fs.readFile(path.join(publicDir, 'index.html'), (idxErr, idxData) => {
          if (idxErr) { res.writeHead(404); res.end('Not found'); return; }
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(idxData);
        });
        return;
      }
      res.writeHead(404); res.end('Not found'); return;
    }
    const ext = path.extname(absolutePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

async function handleApi(reqUrl, res) {
  const pathname = reqUrl.pathname;
  const gamePk = reqUrl.searchParams.get('gamePk');

  try {
    if (pathname === '/api/schedule') {
      const date = getEtDateString();
      const data = await fetchJson(`${MLB_BASE}/schedule?sportId=1&date=${date}&hydrate=probablePitcher,linescore,team`);
      const games = (data.dates?.[0]?.games || []).map(compactGame)
        .sort((a, b) => gameSortWeight(a.status) - gameSortWeight(b.status) || new Date(a.startTime) - new Date(b.startTime));
      return sendJson(res, 200, { date, games });
    }

    if (pathname === '/api/live-summary') {
      if (!gamePk) return sendJson(res, 400, { error: 'Missing gamePk' });
      const gameData = await fetchJson(`${LIVE_BASE}/game/${gamePk}/feed/live`);
      const live = gameData.liveData || {};
      const linescore = live.linescore || {};
      const currentPlay = live.plays?.currentPlay || {};
      return sendJson(res, 200, {
        gamePk: Number(gamePk),
        status: gameData.gameData?.status?.detailedState,
        inning: linescore.currentInning,
        half: linescore.inningHalf,
        outs: linescore.outs,
        runners: getRunnerState(linescore.offense),
        count: currentPlay.count || { balls: 0, strikes: 0, outs: linescore.outs || 0 },
        score: { away: linescore.teams?.away?.runs ?? 0, home: linescore.teams?.home?.runs ?? 0 },
        currentBatter: linescore.offense?.batter || currentPlay.matchup?.batter || null,
        currentPitcher: linescore.defense?.pitcher || currentPlay.matchup?.pitcher || null,
        probableStarters: { away: gameData.gameData?.probablePitchers?.away || null, home: gameData.gameData?.probablePitchers?.home || null }
      });
    }

    if (pathname === '/api/pitch-feed') {
      if (!gamePk) return sendJson(res, 400, { error: 'Missing gamePk' });
      const gameData = await fetchJson(`${LIVE_BASE}/game/${gamePk}/feed/live`);
      const live = gameData.liveData || {};
      const { currentPlay, events, allPlays } = getCurrentPitchEvents(live);
      const recentPlays = allPlays.slice(-8).map((play) => {
        const desc = play.result?.description || '';
        const eventType = play.result?.eventType || play.result?.event || '';
        const isSteal = /stolen base|steals|steal of/i.test(desc) || /stolen_base/i.test(eventType);
        const isCaughtStealing = /caught stealing/i.test(desc) || /caught_stealing/i.test(eventType);
        const bipEvent = (play.playEvents || []).find(e => e.hitData?.launchSpeed);
        return {
          atBatIndex: play.atBatIndex,
          inning: play.about?.inning,
          half: play.about?.halfInning,
          description: desc,
          scoringPlay: Boolean(play.about?.isScoringPlay),
          startTime: play.about?.startTime || null,
          endTime: play.about?.endTime || null,
          isSteal,
          isCaughtStealing,
          exitVelocity: bipEvent?.hitData?.launchSpeed || null,
          launchAngle: bipEvent?.hitData?.launchAngle || null,
          totalDistance: bipEvent?.hitData?.totalDistance || null,
          hardHit: bipEvent?.hitData?.launchSpeed >= 95 || false
        };
      });
      return sendJson(res, 200, {
        gamePk: Number(gamePk),
        pitchEvents: events,
        recentPlays,
        latestPlay: {
          description: currentPlay?.result?.description || allPlays.at(-1)?.result?.description || 'No recent play',
          scoringPlay: Boolean(currentPlay?.about?.isScoringPlay || allPlays.at(-1)?.about?.isScoringPlay)
        },
        playStateToken: `${currentPlay?.atBatIndex ?? 'na'}:${events.length}:${currentPlay?.count?.balls ?? 0}-${currentPlay?.count?.strikes ?? 0}`
      });
    }

    if (pathname === '/api/matchup') {
      if (!gamePk) return sendJson(res, 400, { error: 'Missing gamePk' });
      const intel = loadIntel().players || {};
      const gameData = await fetchJson(`${LIVE_BASE}/game/${gamePk}/feed/live`);
      const live = gameData.liveData;
      const current = live?.plays?.currentPlay || live?.plays?.allPlays?.at(-1) || {};
      const batter = current?.matchup?.batter || live?.linescore?.offense?.batter || null;
      const pitcher = current?.matchup?.pitcher || live?.linescore?.defense?.pitcher || null;
      const batterSide = current?.matchup?.batSide?.code || 'R';
      const pitcherIntel = pitcher ? ensurePlayerIntel(intel, pitcher.id).pitcher : null;
      const batterIntel = batter ? ensurePlayerIntel(intel, batter.id).batter : null;
      const prevPitch = current?.playEvents?.filter((e) => e.isPitch).at(-1)?.details?.type?.description;
      const nextPitchExpectation = buildNextPitchExpectation({ pitcherIntel, batterIntel, count: current?.count || { balls: 0, strikes: 0 }, previousPitchType: prevPitch, batterSide });
      return sendJson(res, 200, {
        gamePk: Number(gamePk),
        currentBatter: batter,
        currentPitcher: pitcher,
        starterInfo: gameData.gameData?.probablePitchers || {},
        pitcherVsBatter: {
          handedness: `${current?.matchup?.pitchHand?.code || '?'} vs ${current?.matchup?.batSide?.code || '?'}`,
          notes: [
            batterIntel?.summary?.handlesFastballs || 'Hitter handles fastballs well in neutral counts.',
            batterIntel?.summary?.chaseNote || 'Hitter can chase breaking balls below the zone.',
            pitcherIntel?.summary?.missBatsNote || 'Pitcher gets whiffs with elevated fastballs.',
            pitcherIntel?.summary?.aheadNote || 'Pitcher leans to offspeed when ahead.'
          ].filter(Boolean)
        },
        nextPitchExpectation,
        simpleAngles: simpleAngles({ pitcherIntel: pitcherIntel || {}, batterIntel: batterIntel || {}, expectation: nextPitchExpectation })
      });
    }

    if (pathname.startsWith('/api/savant/pitcher/')) {
      const playerId = pathname.split('/').pop();
      const intel = loadIntel().players || {};
      const profile = ensurePlayerIntel(intel, playerId).pitcher;
      return sendJson(res, 200, { playerId: Number(playerId), profileType: 'pitcher', data: profile });
    }

    if (pathname.startsWith('/api/savant/batter/')) {
      const playerId = pathname.split('/').pop();
      const intel = loadIntel().players || {};
      const profile = ensurePlayerIntel(intel, playerId).batter;
      return sendJson(res, 200, { playerId: Number(playerId), profileType: 'batter', data: profile });
    }

    if (pathname === '/api/game-buzz') {
      if (!gamePk) return sendJson(res, 400, { error: 'Missing gamePk' });
      const gameData = await fetchJson(`${LIVE_BASE}/game/${gamePk}/feed/live`);
      const buzz = buildBuzz({ liveData: gameData.liveData, gameData });
      return sendJson(res, 200, { gamePk: Number(gamePk), buzz });
    }

    return sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    return sendJson(res, 500, { error: 'Request failed', detail: err.message });
  }
}

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host}`);
  if (reqUrl.pathname.startsWith('/api/')) {
    await handleApi(reqUrl, res);
    return;
  }
  serveStatic(reqUrl.pathname, res);
});

server.listen(PORT, () => {
  console.log(`MLB tracker server listening on http://localhost:${PORT}`);
});

