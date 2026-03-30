const state = {
  games: [], selectedGamePk: null, level: localStorage.getItem('knowledgeLevel') || 'intermediate', playStateToken: null
};

const levelCopy = {
  new: {
    whatItMeans: 'What this means',
    buzzPrefix: 'Simple read',
    nextPitch: (exp) => `Most likely next pitch: ${exp.probabilities[0]?.pitchType || 'Fastball'}. ${exp.explanation}`
  },
  intermediate: {
    whatItMeans: 'Why it matters',
    buzzPrefix: 'Game read',
    nextPitch: (exp) => `Likely next pitch mix in count ${exp.count}: ${exp.probabilities.map((p) => `${p.pitchType} ${p.probability}%`).join(', ')}.`
  },
  experienced: {
    whatItMeans: 'Edge',
    buzzPrefix: 'Signal',
    nextPitch: (exp) => `Count ${exp.count} model: ${exp.probabilities.map((p) => `${p.pitchType} ${p.probability}%`).join(' · ')}. ${exp.explanation}`
  }
};

const el = (id) => document.getElementById(id);

async function api(path) { const res = await fetch(path); if (!res.ok) throw new Error(await res.text()); return res.json(); }

function statusClass(status) {
  if (status === 'Live') return 'status-live';
  if (status === 'Final') return 'status-final';
  return 'muted';
}

function sortGames(g) {
  const w = { Live: 0, Preview: 1, Final: 2 };
  return g.sort((a, b) => (w[a.status] - w[b.status]) || (new Date(a.startTime) - new Date(b.startTime)));
}

function renderGames() {
  const gamesEl = el('games');
  gamesEl.innerHTML = '';
  state.games.forEach((g) => {
    const card = document.createElement('div');
    card.className = `game-card ${state.selectedGamePk === g.gamePk ? 'active' : ''}`;
    card.innerHTML = `
      <div class="${statusClass(g.status)}">${g.status === 'Final' ? 'FINAL' : g.detailedStatus}</div>
      <div>${g.teams.away.abbr} ${g.teams.away.score} @ ${g.teams.home.abbr} ${g.teams.home.score}</div>
      <div class="muted">${new Date(g.startTime).toLocaleTimeString()}</div>`;
    card.onclick = () => selectGame(g.gamePk);
    gamesEl.appendChild(card);
  });
}

function explain(text) {
  if (state.level === 'new') return `${text} (${levelCopy.new.whatItMeans}: this can change the next result.)`;
  if (state.level === 'experienced') return text;
  return `${text} (${levelCopy.intermediate.whatItMeans}: affects at-bat outcome.)`;
}

async function loadSlate() {
  const data = await api('/api/schedule');
  state.games = sortGames(data.games);
  if (!state.selectedGamePk && state.games.length) state.selectedGamePk = state.games[0].gamePk;
  renderGames();
  if (state.selectedGamePk) await refreshGame();
}

async function selectGame(gamePk) {
  state.selectedGamePk = gamePk;
  state.playStateToken = null;
  renderGames();
  await refreshGame();
}

function renderCard(targetId, obj) {
  const target = el(targetId);
  target.innerHTML = Object.entries(obj || {}).map(([k, v]) => `<div>${k}: <b>${typeof v === 'object' ? JSON.stringify(v) : v}</b></div>`).join('');
}

async function refreshGame() {
  const gamePk = state.selectedGamePk;
  if (!gamePk) return;

  const [summary, feed, matchup, buzz] = await Promise.all([
    api(`/api/live-summary?gamePk=${gamePk}`),
    api(`/api/pitch-feed?gamePk=${gamePk}`),
    api(`/api/matchup?gamePk=${gamePk}`),
    api(`/api/game-buzz?gamePk=${gamePk}`)
  ]);

  el('banner').innerHTML = `<div>
    <div>${summary.currentBatter?.fullName || 'TBD'} vs ${summary.currentPitcher?.fullName || 'TBD'}</div>
    <div class="muted">${summary.status} · ${summary.half || ''} ${summary.inning || ''} · Outs ${summary.outs ?? 0}</div>
  </div><div><div>${summary.score.away} - ${summary.score.home}</div><div class="muted">Count ${summary.count.balls}-${summary.count.strikes}</div></div>`;

  el('liveTicker').innerHTML = feed.recentPlays.map((p) => `<div class="item">${p.half} ${p.inning}: ${explain(p.description)} ${p.scoringPlay ? '🔥' : ''}</div>`).join('') || '<div class="muted">No recent plays</div>';
  el('currentMatchup').innerHTML = `<div>${matchup.currentPitcher?.fullName || 'Pitcher'} (${matchup.pitcherVsBatter.handedness}) vs ${matchup.currentBatter?.fullName || 'Batter'}</div>`;
  el('pitchByPitch').innerHTML = feed.pitchEvents.map((p) => `<div class="item">#${p.pitchNumber} ${p.type} ${p.startSpeed || ''}mph · ${p.call || p.details} · ${p.count}</div>`).join('') || '<div class="muted">No pitch events yet</div>';

  const pitcherId = matchup.currentPitcher?.id;
  const batterId = matchup.currentBatter?.id;
  if (pitcherId) {
    try { const p = await api(`/api/savant/pitcher/${pitcherId}`); renderCard('pitcherCard', p.data); } catch { el('pitcherCard').textContent = 'Pitcher intelligence unavailable'; }
  }
  if (batterId) {
    try { const b = await api(`/api/savant/batter/${batterId}`); renderCard('batterCard', b.data); } catch { el('batterCard').textContent = 'Batter intelligence unavailable'; }
  }

  el('pitcherVsBatter').innerHTML = matchup.pitcherVsBatter.notes.map((n) => `<div class="item">${explain(n)}</div>`).join('');
  el('simpleAngles').innerHTML = matchup.simpleAngles.map((a) => `<div class="item"><b>${a.angle}</b><br>${explain(a.why)}</div>`).join('');
  el('nextPitch').innerHTML = `<div>${levelCopy[state.level].nextPitch(matchup.nextPitchExpectation)}</div>`;
  el('gameBuzz').innerHTML = buzz.buzz.map((b) => `<div class="item"><b>${levelCopy[state.level].buzzPrefix}:</b> ${explain(b.text)}</div>`).join('');

  state.playStateToken = feed.playStateToken;
}

async function pollLive() {
  if (!state.selectedGamePk) return;
  const feed = await api(`/api/pitch-feed?gamePk=${state.selectedGamePk}`);
  if (state.playStateToken && state.playStateToken !== feed.playStateToken) await refreshGame();
}

el('knowledgeLevel').value = state.level;
el('knowledgeLevel').addEventListener('change', async (e) => {
  state.level = e.target.value;
  localStorage.setItem('knowledgeLevel', state.level);
  await refreshGame();
});
el('refreshSlate').addEventListener('click', loadSlate);

loadSlate();
setInterval(loadSlate, 60000);
setInterval(pollLive, 8000);
