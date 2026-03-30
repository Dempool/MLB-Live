const MLB_API = 'https://statsapi.mlb.com/api/v1';

function getEtDate() {
  const formatted = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
  return formatted;
}

async function getJson(path) {
  const res = await fetch(`${MLB_API}${path}`);
  if (!res.ok) throw new Error(`MLB API error ${res.status} for ${path}`);
  return res.json();
}

function normalizeStatus(game) {
  const abstractState = game?.status?.abstractGameState || 'Preview';
  const detailed = game?.status?.detailedState || 'Preview';
  if (abstractState === 'Final' || /final|completed/i.test(detailed)) return 'final';
  if (abstractState === 'Live' || abstractState === 'Manager Challenge' || abstractState === 'Review') return 'live';
  return 'preview';
}

function mapScheduleGame(game) {
  const status = normalizeStatus(game);
  const away = game?.teams?.away;
  const home = game?.teams?.home;
  return {
    gamePk: game.gamePk,
    status,
    detailedState: game?.status?.detailedState || '',
    startTime: game.gameDate,
    teams: {
      away: {
        id: away?.team?.id,
        name: away?.team?.name,
        abbr: away?.team?.abbreviation,
        score: away?.score ?? 0
      },
      home: {
        id: home?.team?.id,
        name: home?.team?.name,
        abbr: home?.team?.abbreviation,
        score: home?.score ?? 0
      }
    },
    probableStarters: {
      away: away?.probablePitcher ? { id: away.probablePitcher.id, name: away.probablePitcher.fullName } : null,
      home: home?.probablePitcher ? { id: home.probablePitcher.id, name: home.probablePitcher.fullName } : null
    }
  };
}

async function getTodaySchedule() {
  const date = getEtDate();
  const payload = await getJson(`/schedule?sportId=1&date=${date}&hydrate=linescore,probablePitcher,team`);
  return (payload?.dates?.[0]?.games || []).map(mapScheduleGame);
}

async function getLiveFeed(gamePk) {
  return getJson(`/game/${gamePk}/feed/live`);
}

module.exports = {
  getEtDate,
  getTodaySchedule,
  getLiveFeed,
  normalizeStatus
};
