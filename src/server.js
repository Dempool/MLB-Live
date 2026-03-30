const path = require('path');
const express = require('express');
const { getTodaySchedule, getLiveFeed } = require('./services/mlbApi');
const { loadIntel, getPitcher, getBatter, buildFallbackPitcher, buildFallbackBatter } = require('./services/intelStore');
const { buildNextPitchExpectation, buildPitcherVsBatter, buildSimpleAngles } = require('./services/matchupEngine');

const app = express();
const PORT = process.env.PORT || 8787;

loadIntel();

app.use(express.static(process.cwd()));

function latestPlay(feed) {
  const plays = feed?.liveData?.plays?.allPlays || [];
  return plays[plays.length - 1] || null;
}

function buildLiveSummary(feed) {
  const linescore = feed?.liveData?.linescore || {};
  const currentPlay = feed?.liveData?.plays?.currentPlay || {};
  const offense = linescore.offense || {};
  const defense = linescore.defense || {};
  return {
    gamePk: feed?.gamePk,
    status: feed?.gameData?.status?.detailedState,
    inning: linescore.currentInning || null,
    half: linescore.inningHalf || null,
    outs: linescore.outs || 0,
    runnersOn: ['first', 'second', 'third'].filter((base) => offense[base]).map((b) => b),
    count: {
      balls: currentPlay?.count?.balls ?? 0,
      strikes: currentPlay?.count?.strikes ?? 0
    },
    score: {
      away: linescore.teams?.away?.runs ?? 0,
      home: linescore.teams?.home?.runs ?? 0
    },
    currentBatter: currentPlay?.matchup?.batter || null,
    currentPitcher: currentPlay?.matchup?.pitcher || defense?.pitcher || null,
    probableStarters: {
      away: feed?.gameData?.probablePitchers?.away || null,
      home: feed?.gameData?.probablePitchers?.home || null
    }
  };
}

function buildPitchFeed(feed) {
  const currentPlay = feed?.liveData?.plays?.currentPlay || {};
  const events = currentPlay?.playEvents || [];
  const latest = latestPlay(feed);
  const recentPlays = (feed?.liveData?.plays?.allPlays || []).slice(-12).reverse().map((p) => ({
    atBatIndex: p.atBatIndex,
    inning: p.about?.inning,
    half: p.about?.halfInning,
    desc: p.result?.description,
    event: p.result?.event,
    isScoringPlay: !!p.about?.isScoringPlay
  }));
  return {
    currentPlateAppearance: events.map((ev) => ({
      pitchNumber: ev.pitchNumber,
      details: ev.details?.description,
      type: ev.details?.type?.description || ev.details?.type?.code,
      speed: ev.pitchData?.startSpeed || null,
      zone: ev.pitchData?.zone || null,
      count: `${ev.count?.balls ?? 0}-${ev.count?.strikes ?? 0}`
    })),
    recentPlays,
    latestPlay: latest?.result?.description || null,
    isScoringPlay: !!latest?.about?.isScoringPlay
  };
}

function getCurrentMatchup(feed) {
  const currentPlay = feed?.liveData?.plays?.currentPlay || {};
  return {
    batter: currentPlay?.matchup?.batter || null,
    pitcher: currentPlay?.matchup?.pitcher || feed?.liveData?.linescore?.defense?.pitcher || null,
    batterSide: currentPlay?.matchup?.batSide?.code || null,
    pitcherHand: currentPlay?.matchup?.pitchHand?.code || null,
    count: currentPlay?.count || { balls: 0, strikes: 0 },
    previousPitch: (currentPlay?.playEvents || []).filter((ev) => ev.isPitch).slice(-1)[0]?.details?.type?.description || null
  };
}

app.get('/api/schedule', async (_req, res) => {
  try {
    const games = await getTodaySchedule();
    const order = { live: 0, preview: 1, final: 2 };
    games.sort((a, b) => order[a.status] - order[b.status] || new Date(a.startTime) - new Date(b.startTime));
    res.json({ games });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/live-summary', async (req, res) => {
  try {
    const feed = await getLiveFeed(req.query.gamePk);
    res.json(buildLiveSummary(feed));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/pitch-feed', async (req, res) => {
  try {
    const feed = await getLiveFeed(req.query.gamePk);
    res.json(buildPitchFeed(feed));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/matchup', async (req, res) => {
  try {
    const feed = await getLiveFeed(req.query.gamePk);
    const liveSummary = buildLiveSummary(feed);
    const matchup = getCurrentMatchup(feed);

    const pitcherIntel = getPitcher(matchup.pitcher?.id) || buildFallbackPitcher(feed?.gameData?.players?.[`ID${matchup.pitcher?.id}`]);
    const batterIntel = getBatter(matchup.batter?.id) || buildFallbackBatter(feed?.gameData?.players?.[`ID${matchup.batter?.id}`]);

    const pvb = buildPitcherVsBatter({
      pitcherIntel,
      batterIntel,
      pitcherHand: matchup.pitcherHand,
      batterSide: matchup.batterSide
    });

    const nextPitchExpectation = buildNextPitchExpectation({
      pitcherIntel,
      batterIntel,
      count: matchup.count,
      previousPitch: matchup.previousPitch,
      batterSide: matchup.batterSide
    });

    const simpleAngles = buildSimpleAngles({ liveSummary, matchup: pvb });

    res.json({
      currentBatter: matchup.batter,
      currentPitcher: matchup.pitcher,
      starterInfo: liveSummary.probableStarters,
      pitcherVsBatter: pvb,
      nextPitchExpectation,
      simpleAngles,
      pitcherCard: pitcherIntel,
      batterCard: batterIntel
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/savant/pitcher/:playerId', (req, res) => {
  const intel = getPitcher(req.params.playerId);
  if (!intel) return res.status(404).json({ error: 'Pitcher intelligence not found. Run npm run generate:intel.' });
  return res.json(intel);
});

app.get('/api/savant/batter/:playerId', (req, res) => {
  const intel = getBatter(req.params.playerId);
  if (!intel) return res.status(404).json({ error: 'Batter intelligence not found. Run npm run generate:intel.' });
  return res.json(intel);
});

app.get('/api/game-buzz', async (req, res) => {
  try {
    const feed = await getLiveFeed(req.query.gamePk);
    const plays = (feed?.liveData?.plays?.allPlays || []).slice(-8).reverse();
    const buzz = plays.map((play) => ({
      headline: play.about?.isScoringPlay ? 'Scoring update' : 'Game moment',
      text: play.result?.description,
      tag: `${play.about?.halfInning || ''} ${play.about?.inning || ''}`.trim()
    }));
    res.json({
      source: 'derived-from-mlb-live-feed',
      items: buzz,
      links: [
        `https://www.mlb.com/gameday/${req.query.gamePk}`
      ]
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`MLB tracker listening on http://localhost:${PORT}`);
});
