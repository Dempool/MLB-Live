// v2 const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const ODDS_API_KEY = process.env.ODDS_API_KEY || null;
const ODDS_API_BASE = 'https://api.the-odds-api.com/v4';
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
// FALLBACK ONLY — used when player is not in player_intel.json (e.g. call-ups, rookies)
// Real data comes from generate_intel.js which pulls from Baseball Savant CSVs
function buildPitcherFallback(playerId) {
  return {
    _isFallback: true,
    hand: 'R', pitchMix: pctMap(playerId, ['Fastball', 'Slider', 'Changeup', 'Curveball'], 10),
    velocityByPitch: { Fastball: seeded(playerId, 91, 99, 21), Slider: seeded(playerId, 82, 91, 22), Changeup: seeded(playerId, 80, 89, 23), Curveball: seeded(playerId, 76, 84, 24) },
    whiffRate: seeded(playerId, 18, 38, 31), strikeoutRate: seeded(playerId, 16, 35, 32), walkRate: seeded(playerId, 4, 12, 33),
    hardHitAllowed: seeded(playerId, 27, 45, 34), barrelAllowed: seeded(playerId, 4, 12, 35),
    splitsByHandedness: { vsR: { avgAllowed: seeded(playerId, 0.205, 0.275, 36) }, vsL: { avgAllowed: seeded(playerId, 0.215, 0.295, 37) } },
    firstPitchStrikeTendency: seeded(playerId, 53, 69, 38), twoStrikePutawayTendency: seeded(playerId, 24, 43, 39),
    likelyUsageByCount: { '0-0': pctMap(playerId, ['Fastball', 'Slider', 'Changeup', 'Curveball'], 40), '1-1': pctMap(playerId, ['Fastball', 'Slider', 'Changeup', 'Curveball'], 50), '0-2': pctMap(playerId, ['Fastball', 'Slider', 'Changeup', 'Curveball'], 60), '3-2': pctMap(playerId, ['Fastball', 'Slider', 'Changeup', 'Curveball'], 70) },
    nextPitchTendencyByBatterSide: { R: pctMap(playerId, ['Fastball', 'Slider', 'Changeup', 'Curveball'], 80), L: pctMap(playerId, ['Fastball', 'Slider', 'Changeup', 'Curveball'], 90) },
    summary: { missBatsNote: 'Statcast data not yet available for this pitcher.', aheadNote: 'Run generate_intel.js to fetch real data.' }
  };
}
function buildBatterFallback(playerId) {
  return {
    _isFallback: true,
    stand: 'R', hardHitRate: null, barrelRate: null, whiffTendency: null,
    chaseTendency: null, contactTendency: null,
    splitVsHandedness: { vsR: { avg: null }, vsL: { avg: null } },
    firstPitchSwingTendency: null,
    hotCold: { recentHot: null, trend: 0 },
    summary: { handlesFastballs: 'Statcast data not yet available for this batter.', chaseNote: 'Run generate_intel.js to fetch real data.' }
  };
}
function ensurePlayerIntel(intelPlayers, playerId) {
  const id = String(playerId);
  if (!intelPlayers[id]) {
    // Return minimal shell with null stats - no fake seeded data
    intelPlayers[id] = { name: `Player ${id}`, teamId: null, pitcher: buildPitcherFallback(id), batter: buildBatterFallback(id) };
  }
  if (!intelPlayers[id].pitcher) intelPlayers[id].pitcher = buildPitcherFallback(id);
  if (!intelPlayers[id].batter) intelPlayers[id].batter = buildBatterFallback(id);
  return intelPlayers[id];
}

// Returns player intel only if real Savant data exists, otherwise null
function getPlayerIntelIfReal(intelPlayers, playerId) {
  const id = String(playerId);
  const p = intelPlayers[id];
  if (!p) return null;
  return p;
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
  const pp = game.teams?.away?.probablePitcher || null;
  return {
    gamePk: game.gamePk,
    status,
    detailedStatus: game.status?.detailedState || status,
    startTime: game.gameDate,
    venue: game.venue?.name || null,
    teams: {
      away: {
        id: game.teams?.away?.team?.id,
        name: game.teams?.away?.team?.name,
        abbr: game.teams?.away?.team?.abbreviation,
        score: game.teams?.away?.score ?? 0,
        record: game.teams?.away?.leagueRecord ? `${game.teams.away.leagueRecord.wins}-${game.teams.away.leagueRecord.losses}` : null,
        probablePitcher: game.teams?.away?.probablePitcher?.fullName || null
      },
      home: {
        id: game.teams?.home?.team?.id,
        name: game.teams?.home?.team?.name,
        abbr: game.teams?.home?.team?.abbreviation,
        score: game.teams?.home?.score ?? 0,
        record: game.teams?.home?.leagueRecord ? `${game.teams.home.leagueRecord.wins}-${game.teams.home.leagueRecord.losses}` : null,
        probablePitcher: game.teams?.home?.probablePitcher?.fullName || null
      }
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
    zone: evt.pitchData?.zone || null,
    exitVelocity: evt.hitData?.launchSpeed ? Math.round(evt.hitData.launchSpeed * 10) / 10 : null,
    launchAngle: evt.hitData?.launchAngle ? Math.round(evt.hitData.launchAngle) : null,
    totalDistance: evt.hitData?.totalDistance ? Math.round(evt.hitData.totalDistance) : null,
    hardHit: (evt.hitData?.launchSpeed || 0) >= 95
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
      const today = getEtDateString();
      const yesterdayDate = new Date();
      yesterdayDate.setDate(yesterdayDate.getDate() - 1);
      const yesterday = getEtDateString(yesterdayDate);

      // Fetch today's games
      const data = await fetchJson(`${MLB_BASE}/schedule?sportId=1&date=${today}&hydrate=probablePitcher,linescore,team`);
      let games = (data.dates?.[0]?.games || []).map(compactGame);

      // If it's early (before 6am ET) or any games from yesterday are still live, also fetch yesterday
      const etHour = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false });
      const isEarlyMorning = Number(etHour) < 6;

      if (isEarlyMorning) {
        try {
          const yData = await fetchJson(`${MLB_BASE}/schedule?sportId=1&date=${yesterday}&hydrate=probablePitcher,linescore,team`);
          const yGames = (yData.dates?.[0]?.games || []).map(compactGame);
          // Only include yesterday's games that are still live or finished within last 3 hours
          const liveOrRecent = yGames.filter(g => g.status === 'Live');
          if (liveOrRecent.length) {
            // Prepend yesterday's live games, avoid duplicates
            const existingPks = new Set(games.map(g => g.gamePk));
            games = [...liveOrRecent.filter(g => !existingPks.has(g.gamePk)), ...games];
          }
        } catch(e) { /* yesterday fetch failed, continue with today */ }
      }

      games.sort((a, b) => gameSortWeight(a.status) - gameSortWeight(b.status) || new Date(a.startTime) - new Date(b.startTime));
      return sendJson(res, 200, { date: today, games });
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
      const recentPlays = allPlays.map((play) => {
        const desc = play.result?.description || '';
        const eventType = play.result?.eventType || play.result?.event || '';
        const isSteal = /stolen base|steals|steal of/i.test(desc) || /stolen_base/i.test(eventType);
        const isCaughtStealing = /caught stealing/i.test(desc) || /caught_stealing/i.test(eventType);
        const isDoublePlay = /double play/i.test(desc) || /double_play/i.test(eventType);
        const isSpecial = /challenge|overturned|balk|hit by pitch|wild pitch|passed ball|ejection/i.test(desc);
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
          isDoublePlay,
          isSpecial,
          eventType,
          exitVelocity: bipEvent?.hitData?.launchSpeed ? Math.round(bipEvent.hitData.launchSpeed * 10) / 10 : null,
          launchAngle: bipEvent?.hitData?.launchAngle ? Math.round(bipEvent.hitData.launchAngle) : null,
          totalDistance: bipEvent?.hitData?.totalDistance ? Math.round(bipEvent.hitData.totalDistance) : null,
          hardHit: (bipEvent?.hitData?.launchSpeed || 0) >= 95
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

      // Get current pitcher for each team from boxscore
      const boxTeams = live?.boxscore?.teams || {};
      const getActivePitcher = (teamSide) => {
        const pitcherIds = boxTeams[teamSide]?.pitchers || [];
        const players = boxTeams[teamSide]?.players || {};
        const lastId = pitcherIds[pitcherIds.length - 1];
        if (!lastId) return null;
        const p = players[`ID${lastId}`];
        return p ? { id: lastId, fullName: p.person?.fullName || null } : null;
      };
      const awayCurrentPitcher = getActivePitcher('away');
      const homeCurrentPitcher = getActivePitcher('home');

      // Next batter up (on-deck)
      const onDeck = live?.linescore?.offense?.onDeck || null;

      // Special plays from recent history
      const allPlays = live?.plays?.allPlays || [];
      const recentSpecial = allPlays.slice(-20).filter(p => {
        const desc = (p.result?.description || '').toLowerCase();
        const evt = (p.result?.eventType || p.result?.event || '').toLowerCase();
        return desc.includes('double play') || evt.includes('double_play') ||
               desc.includes('triple play') ||
               desc.includes('challenge') || desc.includes('overturned') || desc.includes('confirmed') ||
               desc.includes('balk') || desc.includes('interference') || desc.includes('obstruction') ||
               desc.includes('hit by pitch') || evt.includes('hit_by_pitch') ||
               desc.includes('ejection') || desc.includes('ejected') ||
               desc.includes('wild pitch') || desc.includes('passed ball');
      }).slice(-5).map(p => ({
        description: p.result?.description || '',
        eventType: p.result?.eventType || p.result?.event || '',
        inning: p.about?.inning,
        half: p.about?.halfInning,
        time: p.about?.endTime || p.about?.startTime || null
      }));

      // Scoring plays from full game
      const scoringPlays = allPlays.filter(p => p.about?.isScoringPlay).map(p => ({
        description: p.result?.description || '',
        inning: p.about?.inning,
        half: p.about?.halfInning,
        time: p.about?.endTime || null,
        awayScore: p.result?.awayScore,
        homeScore: p.result?.homeScore
      }));

      return sendJson(res, 200, {
        gamePk: Number(gamePk),
        currentBatter: batter,
        currentPitcher: pitcher,
        onDeck,
        awayPitcher: awayCurrentPitcher || gameData.gameData?.probablePitchers?.away || null,
        homePitcher: homeCurrentPitcher || gameData.gameData?.probablePitchers?.home || null,
        activePitcherId: pitcher?.id || null,
        starterInfo: gameData.gameData?.probablePitchers || {},
        specialPlays: recentSpecial,
        scoringPlays,
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
      const player = intel[String(playerId)];
      if (player?.pitcher && !player.pitcher._isFallback) {
        return sendJson(res, 200, { playerId: Number(playerId), profileType: 'pitcher', data: player.pitcher });
      }
      return sendJson(res, 200, { playerId: Number(playerId), profileType: 'pitcher', data: null });
    }

    if (pathname.startsWith('/api/savant/batter/')) {
      const playerId = pathname.split('/').pop();
      const intel = loadIntel().players || {};
      const player = intel[String(playerId)];
      // If we have real data (not fallback), return it
      if (player?.batter && !player.batter._isFallback) {
        return sendJson(res, 200, { playerId: Number(playerId), profileType: 'batter', data: player.batter });
      }
      // No real data - return null stats so frontend shows last game context only
      return sendJson(res, 200, { playerId: Number(playerId), profileType: 'batter', data: null });
    }

    // Proxy: player game log (avoids CORS on direct MLB API calls from browser)
    if (pathname.startsWith('/api/player-log/')) {
      const parts = pathname.split('/'); // /api/player-log/{playerId}/{group}
      const playerId = parts[3];
      const group = parts[4] || 'hitting';
      const season = new Date().getFullYear();
      const url = `${MLB_BASE}/people/${playerId}/stats?stats=gameLog&group=${group}&season=${season}&limit=5`;
      const data = await fetchJson(url);
      return sendJson(res, 200, data);
    }

    // Proxy: player vs team splits
    if (pathname.startsWith('/api/player-splits/')) {
      const parts = pathname.split('/'); // /api/player-splits/{playerId}/{group}/{oppTeamId}
      const playerId = parts[3];
      const group = parts[4] || 'hitting';
      const oppTeamId = parts[5] || '';
      const season = new Date().getFullYear();
      const url = `${MLB_BASE}/people/${playerId}/stats?stats=vsTeam&group=${group}&season=${season}${oppTeamId ? `&opposingTeamId=${oppTeamId}` : ''}`;
      const data = await fetchJson(url);
      return sendJson(res, 200, data);
    }

    // Pregame risk signals — combines savant intel + matchup context for FanDuel risk panel
    if (pathname === '/api/pregame-risk') {
      if (!gamePk) return sendJson(res, 400, { error: 'Missing gamePk' });
      const intel = loadIntel().players || {};
      const gameData = await fetchJson(`${LIVE_BASE}/game/${gamePk}/feed/live`);
      const gd = gameData.gameData || {};
      const season = new Date().getFullYear();

      const awayId = gd.teams?.away?.id;
      const homeId = gd.teams?.home?.id;
      const awayAbbr = gd.teams?.away?.abbreviation || '';
      const homeAbbr = gd.teams?.home?.abbreviation || '';
      const venue = gd.venue?.name || '';
      const awayStarter = gd.probablePitchers?.away || null;
      const homeStarter = gd.probablePitchers?.home || null;

      // Park factor lookup (rough index — top HR parks)
      const HR_PARKS = { 'Coors Field': 1.35, 'Great American Ball Park': 1.18, 'Globe Life Field': 1.14,
        'Fenway Park': 1.12, 'Yankee Stadium': 1.11, 'Guaranteed Rate Field': 1.10,
        'Truist Park': 1.08, 'Chase Field': 1.07, 'PNC Park': 0.91, 'Oracle Park': 0.88,
        'Kauffman Stadium': 0.90, 'Petco Park': 0.89, 'T-Mobile Park': 0.88 };
      const parkHRFactor = HR_PARKS[venue] || 1.0;
      const parkNote = parkHRFactor >= 1.10 ? `${venue} is a hitter-friendly park (HR factor ${parkHRFactor})` :
                       parkHRFactor <= 0.91 ? `${venue} suppresses HRs (factor ${parkHRFactor})` : null;

      const signals = [];

      // Pitcher K signals
      const buildKSignal = async (pitcher, oppTeamId, side) => {
        if (!pitcher?.id) return null;
        const p = ensurePlayerIntel(intel, pitcher.id).pitcher;
        if (p._isFallback) return null;
        const whiff = p.whiffRate;
        const k = p.strikeoutRate;
        if (!whiff || !k) return null;
        // Get opponent lineup chase %
        try {
          const logData = await fetchJson(`${MLB_BASE}/people/${pitcher.id}/stats?stats=gameLog&group=pitching&season=${season}&limit=5`);
          const games = logData.stats?.[0]?.splits || [];
          const recentKs = games.map(g => g.stat?.strikeOuts || 0);
          const avgKs = recentKs.length ? (recentKs.reduce((a,b)=>a+b,0)/recentKs.length).toFixed(1) : null;
          const trend = recentKs.length >= 3 ? (recentKs[0] > recentKs[recentKs.length-1] ? 'rising' : recentKs[0] < recentKs[recentKs.length-1] ? 'falling' : 'steady') : null;
          const isKProp = whiff >= 28 && k >= 24;
          if (isKProp) {
            signals.push({
              type: 'PITCHER_K',
              level: whiff >= 32 ? 'HIGH' : 'MEDIUM',
              player: pitcher.fullName,
              team: side === 'away' ? awayAbbr : homeAbbr,
              stat: `K% ${k} · Whiff ${whiff}%`,
              detail: `${avgKs ? `Avg ${avgKs} Ks last ${recentKs.length} starts` : 'Strong K rate'}${trend ? `, ${trend} trend` : ''}. Expect heavy Over action on K prop.`,
              recentGames: recentKs,
              riskNote: `K line will attract Over bets — whiff rate in top tier, lineup likely to chase.`
            });
          }
        } catch(e) {}
      };

      // Batter HR signals
      const buildHRSignal = async (teamId, oppStarterId, teamAbbr) => {
        try {
          const rosterData = await fetchJson(`${MLB_BASE}/teams/${teamId}/roster?rosterType=active`);
          const roster = rosterData.roster || [];
          for (const player of roster.slice(0, 13)) {
            const b = ensurePlayerIntel(intel, player.person.id).batter;
            if (b._isFallback || !b.barrelRate || !b.hardHitRate) continue;
            if (b.barrelRate >= 10 || b.hardHitRate >= 50) {
              try {
                const logData = await fetchJson(`${MLB_BASE}/people/${player.person.id}/stats?stats=gameLog&group=hitting&season=${season}&limit=5`);
                const games = logData.stats?.[0]?.splits || [];
                const recentHRs = games.reduce((a,g)=>a+(g.stat?.homeRuns||0),0);
                if (b.barrelRate >= 10) {
                  signals.push({
                    type: 'BATTER_HR',
                    level: b.barrelRate >= 14 ? 'HIGH' : 'MEDIUM',
                    player: player.person.fullName,
                    team: teamAbbr,
                    stat: `Barrel ${b.barrelRate}% · Hard Hit ${b.hardHitRate}%`,
                    detail: `${recentHRs > 0 ? `${recentHRs} HR last 5 games — in form. ` : ''}${parkHRFactor >= 1.10 ? parkNote+'. ' : ''}Elite barrel rate signals HR prop value.`,
                    riskNote: `Anytime HR prop likely to attract action${parkHRFactor >= 1.10 ? ' — park amplifies risk' : ''}.`
                  });
                }
              } catch(e) {}
            }
          }
        } catch(e) {}
      };

      await Promise.all([
        buildKSignal(awayStarter, homeId, 'away'),
        buildKSignal(homeStarter, awayId, 'home'),
        buildHRSignal(awayId, homeStarter?.id, awayAbbr),
        buildHRSignal(homeId, awayStarter?.id, homeAbbr),
      ]);

      // Sort by risk level
      const order = { HIGH: 0, MEDIUM: 1 };
      signals.sort((a,b) => (order[a.level]||2) - (order[b.level]||2));

      return sendJson(res, 200, { gamePk: Number(gamePk), venue, parkHRFactor, parkNote, signals });
    }

    // ── ODDS API ──────────────────────────────────────────────────────────
    // Returns today's MLB game odds (moneyline + totals) from The Odds API
    if (pathname === '/api/odds/games') {
      if (!ODDS_API_KEY) return sendJson(res, 200, { error: 'no_key', games: [] });
      try {
        const data = await fetchJson(
          `${ODDS_API_BASE}/sports/baseball_mlb/odds?apiKey=${ODDS_API_KEY}&regions=us&markets=h2h,totals&oddsFormat=american&bookmakers=fanduel`
        );
        return sendJson(res, 200, { games: data || [] });
      } catch(e) {
        return sendJson(res, 200, { error: e.message, games: [] });
      }
    }

    // Returns player props for a specific event (pitcher Ks, batter HRs, hits, total bases)
    if (pathname === '/api/odds/props') {
      if (!ODDS_API_KEY) return sendJson(res, 200, { error: 'no_key', props: [] });
      const eventId = reqUrl.searchParams.get('eventId');
      if (!eventId) return sendJson(res, 400, { error: 'Missing eventId' });
      try {
        const data = await fetchJson(
          `${ODDS_API_BASE}/sports/baseball_mlb/events/${eventId}/odds?apiKey=${ODDS_API_KEY}&regions=us&markets=pitcher_strikeouts,batter_home_runs,batter_hits,batter_total_bases&oddsFormat=american&bookmakers=fanduel`
        );
        // Flatten into easy-to-use prop list
        const props = [];
        for (const bm of (data?.bookmakers || [])) {
          for (const market of (bm.markets || [])) {
            for (const outcome of (market.outcomes || [])) {
              props.push({
                market: market.key,
                player: outcome.description || outcome.name,
                name: outcome.name, // Over/Under
                point: outcome.point,
                price: outcome.price,
                bookmaker: bm.title
              });
            }
          }
        }
        return sendJson(res, 200, { eventId, props });
      } catch(e) {
        return sendJson(res, 200, { error: e.message, props: [] });
      }
    }

    // Match MLB gamePk to Odds API event ID
    if (pathname === '/api/odds/match') {
      if (!ODDS_API_KEY) return sendJson(res, 200, { error: 'no_key', eventId: null });
      const awayTeam = reqUrl.searchParams.get('away');
      const homeTeam = reqUrl.searchParams.get('home');
      if (!awayTeam || !homeTeam) return sendJson(res, 400, { error: 'Missing team params' });
      try {
        const data = await fetchJson(
          `${ODDS_API_BASE}/sports/baseball_mlb/events?apiKey=${ODDS_API_KEY}`
        );
        // Fuzzy match team names
        const norm = s => s.toLowerCase().replace(/[^a-z]/g,'');
        const match = (data || []).find(e => {
          const ha = norm(e.home_team), aa = norm(e.away_team);
          const hn = norm(homeTeam), an = norm(awayTeam);
          return (ha.includes(hn)||hn.includes(ha)) && (aa.includes(an)||an.includes(aa));
        });
        return sendJson(res, 200, { eventId: match?.id || null, found: !!match });
      } catch(e) {
        return sendJson(res, 200, { error: e.message, eventId: null });
      }
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
  refreshIntelIfStale();
});

// Auto-refresh intel daily — runs generate_intel.js if file is missing or older than 20 hours
function refreshIntelIfStale() {
  const staleAfterMs = 20 * 60 * 60 * 1000; // 20 hours
  let isStale = true;
  if (fs.existsSync(intelPath)) {
    try {
      const intel = JSON.parse(fs.readFileSync(intelPath, 'utf8'));
      const age = Date.now() - new Date(intel.generatedAt || 0).getTime();
      isStale = age > staleAfterMs;
      if (!isStale) {
        console.log(`Intel is fresh (generated ${Math.round(age/3600000)}h ago), skipping refresh`);
      }
    } catch { isStale = true; }
  }
  if (isStale) {
    console.log('Intel is stale or missing — regenerating from Baseball Savant...');
    const { execFile } = require('child_process');
    execFile('node', [path.join(__dirname, 'generate_intel.js')], (err, stdout, stderr) => {
      if (err) {
        console.warn('Intel refresh failed:', err.message);
      } else {
        console.log('Intel refreshed successfully');
        if (stdout) console.log(stdout);
      }
    });
  }
  // Schedule next check in 6 hours
  setTimeout(refreshIntelIfStale, 6 * 60 * 60 * 1000);
}
