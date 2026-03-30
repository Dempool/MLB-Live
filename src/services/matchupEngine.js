function countBucket(balls, strikes) {
  if (strikes >= 2) return 'ahead';
  if (balls >= 3) return 'behind';
  return 'even';
}

function normalizeDistribution(dist) {
  const entries = Object.entries(dist);
  const total = entries.reduce((acc, [, v]) => acc + v, 0) || 1;
  return Object.fromEntries(entries.map(([k, v]) => [k, Math.round((v / total) * 100)]));
}

function buildNextPitchExpectation({ pitcherIntel, batterIntel, count, previousPitch, batterSide }) {
  const balls = count?.balls ?? 0;
  const strikes = count?.strikes ?? 0;
  const key = `${balls}-${strikes}_vs${batterSide || 'R'}`;
  const bucket = countBucket(balls, strikes);

  let base = pitcherIntel?.nextPitchByCountAndSide?.[key] || pitcherIntel?.usageByCount?.[bucket] || {
    Fastball: 56,
    Slider: 24,
    Changeup: 14,
    Other: 6
  };

  base = { ...base };

  if (previousPitch?.includes('Fastball')) base.Slider = (base.Slider || 0) + 4;
  if (previousPitch?.includes('Slider')) base.Fastball = (base.Fastball || 0) + 4;

  if ((batterIntel?.damageByPitchType?.Fastball || 0) > 0.31) {
    base.Fastball = Math.max(10, (base.Fastball || 0) - 6);
    base.Slider = (base.Slider || 0) + 4;
    base.Changeup = (base.Changeup || 0) + 2;
  }

  const probs = normalizeDistribution(base);
  const sorted = Object.entries(probs).sort((a, b) => b[1] - a[1]);

  return {
    probabilities: sorted.map(([pitchType, pct]) => ({ pitchType, pct })),
    explanation: `With a ${balls}-${strikes} count, this pitcher usually leans ${sorted[0][0]}. The prior pitch and this hitter's pitch-type profile nudge usage toward ${sorted[0][0]} and ${sorted[1]?.[0] || 'off-speed'} to avoid the batter's best damage zone.`
  };
}

function buildPitcherVsBatter({ pitcherIntel, batterIntel, pitcherHand, batterSide }) {
  const handedness = `${pitcherHand || 'RHP'} vs ${batterSide || 'RHB'}`;
  const notes = [];
  if ((batterIntel?.damageByPitchType?.Fastball || 0) > 0.3) notes.push('Hitter handles fastballs well when he gets one in the zone.');
  if ((batterIntel?.chaseTendency || 0) > 31) notes.push('Hitter can chase sliders away, especially with two strikes.');
  if ((pitcherIntel?.whiffRate || 0) > 29) notes.push('Pitcher misses bats consistently, so strikeout upside is live.');
  if ((pitcherIntel?.usageByCount?.ahead?.Changeup || 0) > 14) notes.push('Pitcher goes to the changeup when ahead to finish at-bats.');

  const angles = [
    {
      title: 'K upside angle',
      why: 'This matchup profile supports swing-and-miss outcomes, which can help pitcher strikeout markets.'
    },
    {
      title: 'First-pitch strike angle',
      why: 'Pitcher tends to attack early, which helps quick outs and keeps innings efficient.'
    },
    {
      title: 'Damage-control angle',
      why: 'If off-speed command is sharp, hard contact risk can drop versus this hitter style.'
    }
  ].slice(0, 2 + Math.floor(Math.random() * 2));

  return { handedness, notes: notes.slice(0, 4), angles };
}

function buildSimpleAngles({ liveSummary, matchup }) {
  const angles = [];
  if ((liveSummary?.count?.strikes ?? 0) === 2) {
    angles.push({
      title: 'Two-strike pressure',
      summary: 'Pitcher can expand the zone now.',
      bettorWhy: 'Two-strike counts often favor strikeouts or weak contact.'
    });
  }
  if ((liveSummary?.runnersOn?.length || 0) >= 2) {
    angles.push({
      title: 'Traffic on base',
      summary: 'One swing can change the game quickly.',
      bettorWhy: 'Run-scoring and RBI outcomes become more likely with multiple runners on.'
    });
  }
  angles.push({
    title: 'Handedness edge',
    summary: matchup.handedness,
    bettorWhy: 'Some hitters perform very differently based on pitcher handedness.'
  });
  return angles.slice(0, 4);
}

module.exports = {
  buildNextPitchExpectation,
  buildPitcherVsBatter,
  buildSimpleAngles
};
