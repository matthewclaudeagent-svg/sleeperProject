// Builds data.json for the SoFi Finance league dashboard.
// Run: node build.js   (Node 20+, no dependencies)

const fs = require('fs');

const LEAGUE_ID = '1390786042679812096';
const REGULAR_SEASON_WEEKS = 14;
const PLAYOFF_TEAMS = 6;
const TRADE_DEADLINE_WEEK = 11;
const SIMULATIONS = 10000;

// Lineup: QB RB RB WR WR TE FLEX K DEF. FLEX is RB/WR/TE.
const STARTER_SLOTS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DEF'];
const FLEX_POSITIONS = ['RB', 'WR', 'TE'];

const api = (path) => `https://api.sleeper.app/v1${path}`;

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} from ${url}`);
  return res.json();
}

// Sleeper asks that /players/nfl (~5MB) be called at most once a day, so we
// keep a slimmed copy on disk and only refresh it when the date changes.
async function loadPlayers() {
  const today = new Date().toISOString().slice(0, 10);
  if (fs.existsSync('players.json')) {
    const cached = JSON.parse(fs.readFileSync('players.json', 'utf8'));
    if (cached.fetched === today) return cached.players;
  }
  const all = await getJson(api('/players/nfl'));
  const players = {};
  for (const [id, p] of Object.entries(all)) {
    players[id] = {
      name: p.full_name || p.last_name || id,
      pos: p.position || (p.fantasy_positions && p.fantasy_positions[0]) || null,
      team: p.team || null,
    };
  }
  fs.writeFileSync('players.json', JSON.stringify({ fetched: today, players }));
  return players;
}

function bestLineup(playerIds, pointsByPlayer, players) {
  // Greedy is optimal for this roster shape: fill dedicated slots with the top
  // scorer at each position, then take the best leftover for the single FLEX.
  const pool = playerIds
    .map((id) => ({
      id,
      pos: players[id] ? players[id].pos : null,
      pts: pointsByPlayer[id] || 0,
    }))
    .filter((p) => p.pos)
    .sort((a, b) => b.pts - a.pts);

  const used = new Set();
  const lineup = [];

  for (const slot of STARTER_SLOTS) {
    if (slot === 'FLEX') continue;
    const pick = pool.find((p) => !used.has(p.id) && p.pos === slot);
    if (pick) {
      used.add(pick.id);
      lineup.push(pick);
    }
  }
  const flex = pool.find((p) => !used.has(p.id) && FLEX_POSITIONS.includes(p.pos));
  if (flex) {
    used.add(flex.id);
    lineup.push(flex);
  }

  return {
    points: lineup.reduce((sum, p) => sum + p.pts, 0),
    players: lineup.map((p) => ({ id: p.id, pos: p.pos, pts: round(p.pts) })),
  };
}

const round = (n) => Math.round(n * 100) / 100;

function gaussian() {
  // Box-Muller
  let u = 0;
  while (u === 0) u = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random());
}

function simulatePlayoffs(teams, remainingGames) {
  const odds = {};
  const seeds = {};
  for (const t of teams) {
    odds[t.rosterId] = 0;
    seeds[t.rosterId] = 0;
  }

  for (let sim = 0; sim < SIMULATIONS; sim++) {
    const wins = {};
    const points = {};
    for (const t of teams) {
      wins[t.rosterId] = t.wins;
      points[t.rosterId] = t.pointsFor;
    }

    for (const [a, b] of remainingGames) {
      const ta = teams.find((t) => t.rosterId === a);
      const tb = teams.find((t) => t.rosterId === b);
      const scoreA = ta.mean + ta.stdev * gaussian();
      const scoreB = tb.mean + tb.stdev * gaussian();
      points[a] += scoreA;
      points[b] += scoreB;
      if (scoreA >= scoreB) wins[a]++;
      else wins[b]++;
    }

    const standings = teams
      .slice()
      .sort((x, y) => {
        const byWins = wins[y.rosterId] - wins[x.rosterId];
        return byWins !== 0 ? byWins : points[y.rosterId] - points[x.rosterId];
      });

    standings.slice(0, PLAYOFF_TEAMS).forEach((t) => odds[t.rosterId]++);
    if (standings.length) seeds[standings[0].rosterId]++;
  }

  return { odds, seeds };
}

async function main() {
  const state = await getJson(api('/state/nfl'));
  const season = state.season;
  const currentWeek = Math.min(Math.max(state.week, 1), REGULAR_SEASON_WEEKS);

  const [league, users, rosters, players] = await Promise.all([
    getJson(api(`/league/${LEAGUE_ID}`)),
    getJson(api(`/league/${LEAGUE_ID}/users`)),
    getJson(api(`/league/${LEAGUE_ID}/rosters`)),
    loadPlayers(),
  ]);

  const userById = {};
  for (const u of users) userById[u.user_id] = u;

  const teams = rosters.map((r) => {
    const u = userById[r.owner_id] || {};
    return {
      rosterId: r.roster_id,
      name: (u.metadata && u.metadata.team_name) || u.display_name || `Team ${r.roster_id}`,
      manager: u.display_name || 'Unknown',
      avatar: u.avatar || null,
      playerIds: r.players || [],
      wins: 0,
      losses: 0,
      ties: 0,
      pointsFor: 0,
      pointsAgainst: 0,
      allPlayWins: 0,
      allPlayLosses: 0,
      actualPoints: 0,
      optimalPoints: 0,
      weekly: [],
    };
  });
  const teamBy = {};
  for (const t of teams) teamBy[t.rosterId] = t;

  // Pull every week of the regular season. Future weeks come back with the
  // matchup pairings already set but no points, which is what the sim needs.
  const weeks = [];
  for (let w = 1; w <= REGULAR_SEASON_WEEKS; w++) {
    weeks.push(getJson(api(`/league/${LEAGUE_ID}/matchups/${w}`)));
  }
  const allMatchups = await Promise.all(weeks);

  const weeklyAwards = [];
  const h2h = {};
  const remainingGames = [];

  allMatchups.forEach((matchups, idx) => {
    const week = idx + 1;
    const played = matchups.some((m) => m.points > 0);

    // Group the flat matchup list into pairs by matchup_id.
    const pairs = {};
    for (const m of matchups) {
      if (m.matchup_id == null) continue;
      (pairs[m.matchup_id] = pairs[m.matchup_id] || []).push(m);
    }

    if (!played) {
      for (const pair of Object.values(pairs)) {
        if (pair.length === 2) remainingGames.push([pair[0].roster_id, pair[1].roster_id]);
      }
      return;
    }

    // All-play: you "beat" everyone you outscored this week.
    const scores = matchups
      .map((m) => ({ rosterId: m.roster_id, pts: m.points || 0 }))
      .sort((a, b) => b.pts - a.pts);
    scores.forEach((s, rank) => {
      const t = teamBy[s.rosterId];
      if (!t) return;
      t.allPlayWins += scores.length - 1 - rank;
      t.allPlayLosses += rank;
    });

    for (const m of matchups) {
      const t = teamBy[m.roster_id];
      if (!t) continue;
      const optimal = bestLineup(
        (m.players || []).slice(),
        m.players_points || {},
        players
      );
      t.actualPoints += m.points || 0;
      t.optimalPoints += optimal.points;
      t.weekly.push({
        week,
        points: round(m.points || 0),
        optimal: round(optimal.points),
        benchPoints: round(Math.max(0, optimal.points - (m.points || 0))),
      });
    }

    const results = [];
    for (const pair of Object.values(pairs)) {
      if (pair.length !== 2) continue;
      const [a, b] = pair;
      const ta = teamBy[a.roster_id];
      const tb = teamBy[b.roster_id];
      if (!ta || !tb) continue;

      ta.pointsFor += a.points || 0;
      ta.pointsAgainst += b.points || 0;
      tb.pointsFor += b.points || 0;
      tb.pointsAgainst += a.points || 0;

      if (a.points > b.points) {
        ta.wins++;
        tb.losses++;
      } else if (b.points > a.points) {
        tb.wins++;
        ta.losses++;
      } else {
        ta.ties++;
        tb.ties++;
      }

      const key = (x, y) => `${x}v${y}`;
      h2h[key(a.roster_id, b.roster_id)] = (h2h[key(a.roster_id, b.roster_id)] || 0) + (a.points > b.points ? 1 : 0);
      h2h[key(b.roster_id, a.roster_id)] = (h2h[key(b.roster_id, a.roster_id)] || 0) + (b.points > a.points ? 1 : 0);

      results.push({ a, b, margin: Math.abs((a.points || 0) - (b.points || 0)) });
    }

    const winners = results.map((r) => (r.a.points > r.b.points ? r.a : r.b));
    const losers = results.map((r) => (r.a.points > r.b.points ? r.b : r.a));
    const low = scores[scores.length - 1];
    const high = scores[0];
    const unlucky = losers.slice().sort((x, y) => (y.points || 0) - (x.points || 0))[0];
    const lucky = winners.slice().sort((x, y) => (x.points || 0) - (y.points || 0))[0];
    const blowout = results.slice().sort((x, y) => y.margin - x.margin)[0];
    const nailbiter = results.slice().sort((x, y) => x.margin - y.margin)[0];

    const named = (rosterId) => (teamBy[rosterId] ? teamBy[rosterId].name : `Team ${rosterId}`);

    weeklyAwards.push({
      week,
      lowScore: { team: named(low.rosterId), rosterId: low.rosterId, points: round(low.pts) },
      highScore: { team: named(high.rosterId), rosterId: high.rosterId, points: round(high.pts) },
      unluckiest: unlucky
        ? { team: named(unlucky.roster_id), rosterId: unlucky.roster_id, points: round(unlucky.points) }
        : null,
      luckiest: lucky
        ? { team: named(lucky.roster_id), rosterId: lucky.roster_id, points: round(lucky.points) }
        : null,
      blowout: blowout
        ? {
            winner: named((blowout.a.points > blowout.b.points ? blowout.a : blowout.b).roster_id),
            loser: named((blowout.a.points > blowout.b.points ? blowout.b : blowout.a).roster_id),
            margin: round(blowout.margin),
          }
        : null,
      nailbiter: nailbiter
        ? {
            winner: named((nailbiter.a.points > nailbiter.b.points ? nailbiter.a : nailbiter.b).roster_id),
            loser: named((nailbiter.a.points > nailbiter.b.points ? nailbiter.b : nailbiter.a).roster_id),
            margin: round(nailbiter.margin),
          }
        : null,
    });
  });

  // Wall of shame: how many times each team has collected each award.
  const wallOfShame = {};
  for (const t of teams) {
    wallOfShame[t.rosterId] = { team: t.name, lowScore: 0, unluckiest: 0, luckiest: 0, blownOut: 0 };
  }
  for (const a of weeklyAwards) {
    if (a.lowScore && wallOfShame[a.lowScore.rosterId]) wallOfShame[a.lowScore.rosterId].lowScore++;
    if (a.unluckiest && wallOfShame[a.unluckiest.rosterId]) wallOfShame[a.unluckiest.rosterId].unluckiest++;
    if (a.luckiest && wallOfShame[a.luckiest.rosterId]) wallOfShame[a.luckiest.rosterId].luckiest++;
  }

  // Scoring distribution drives the simulation.
  for (const t of teams) {
    const scores = t.weekly.map((w) => w.points);
    const mean = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 100;
    const variance = scores.length > 1
      ? scores.reduce((sum, s) => sum + (s - mean) ** 2, 0) / (scores.length - 1)
      : 400;
    t.mean = mean;
    t.stdev = Math.sqrt(variance);
    t.efficiency = t.optimalPoints > 0 ? round((t.actualPoints / t.optimalPoints) * 100) : null;
    t.benchPoints = round(t.optimalPoints - t.actualPoints);
  }

  const { odds, seeds } = simulatePlayoffs(teams, remainingGames);
  for (const t of teams) {
    t.playoffOdds = round((odds[t.rosterId] / SIMULATIONS) * 100);
    t.topSeedOdds = round((seeds[t.rosterId] / SIMULATIONS) * 100);
  }

  // Waiver / free agent ROI: points a pickup scored in the weeks after arrival.
  const txWeeks = [];
  for (let w = 1; w <= currentWeek; w++) {
    txWeeks.push(getJson(api(`/league/${LEAGUE_ID}/transactions/${w}`)));
  }
  const allTx = (await Promise.all(txWeeks)).flat();

  const pickups = [];
  const trades = [];
  for (const tx of allTx) {
    if (tx.status !== 'complete') continue;
    if (tx.type === 'trade') {
      trades.push({
        week: tx.leg,
        rosterIds: tx.roster_ids,
        adds: tx.adds || {},
        drops: tx.drops || {},
      });
      continue;
    }
    for (const [playerId, rosterId] of Object.entries(tx.adds || {})) {
      pickups.push({ playerId, rosterId, week: tx.leg, type: tx.type });
    }
  }

  const pointsAfter = (playerId, rosterId, fromWeek) => {
    let total = 0;
    allMatchups.forEach((matchups, idx) => {
      if (idx + 1 <= fromWeek) return;
      const m = matchups.find((x) => x.roster_id === rosterId);
      if (m && m.players_points && m.players_points[playerId]) total += m.players_points[playerId];
    });
    return total;
  };

  const waiverRoi = pickups
    .map((p) => ({
      player: players[p.playerId] ? players[p.playerId].name : p.playerId,
      pos: players[p.playerId] ? players[p.playerId].pos : null,
      team: teamBy[p.rosterId] ? teamBy[p.rosterId].name : `Team ${p.rosterId}`,
      rosterId: p.rosterId,
      week: p.week,
      points: round(pointsAfter(p.playerId, p.rosterId, p.week)),
    }))
    .sort((a, b) => b.points - a.points)
    .slice(0, 25);

  // Trade suggestions. FantasyCalc only prices QB/RB/WR/TE, so K and DEF
  // come back as zero and any trade involving them will look lopsided.
  let tradeSuggestions = [];
  let values = {};
  if (currentWeek <= TRADE_DEADLINE_WEEK) {
    try {
      const fc = await getJson(
        'https://api.fantasycalc.com/values/current?isDynasty=false&numQbs=1&numTeams=12&ppr=1'
      );
      for (const entry of fc) {
        if (entry.player && entry.player.sleeperId) values[entry.player.sleeperId] = entry.value;
      }
      tradeSuggestions = suggestTrades(teams, values, players);
    } catch (err) {
      console.error('FantasyCalc unavailable, skipping trade suggestions:', err.message);
    }
  }

  const recaps = await buildRecaps(weeklyAwards, teams, currentWeek);

  const data = {
    generatedAt: new Date().toISOString(),
    season,
    currentWeek,
    league: {
      name: league.name,
      teams: league.total_rosters,
      playoffTeams: PLAYOFF_TEAMS,
      regularSeasonWeeks: REGULAR_SEASON_WEEKS,
      tradeDeadlineWeek: TRADE_DEADLINE_WEEK,
      tradeDeadlinePassed: currentWeek > TRADE_DEADLINE_WEEK,
    },
    teams: teams
      .map((t) => ({
        rosterId: t.rosterId,
        name: t.name,
        manager: t.manager,
        avatar: t.avatar,
        wins: t.wins,
        losses: t.losses,
        ties: t.ties,
        pointsFor: round(t.pointsFor),
        pointsAgainst: round(t.pointsAgainst),
        allPlayWins: t.allPlayWins,
        allPlayLosses: t.allPlayLosses,
        efficiency: t.efficiency,
        benchPoints: t.benchPoints,
        playoffOdds: t.playoffOdds,
        topSeedOdds: t.topSeedOdds,
        avgPoints: round(t.mean),
        weekly: t.weekly,
      }))
      .sort((a, b) => b.wins - a.wins || b.pointsFor - a.pointsFor),
    awards: { weekly: weeklyAwards, wallOfShame: Object.values(wallOfShame) },
    h2h,
    transactions: trades.map((t) => ({
      ...t,
      addNames: Object.fromEntries(
        Object.entries(t.adds).map(([pid, rid]) => [
          players[pid] ? players[pid].name : pid,
          teamBy[rid] ? teamBy[rid].name : rid,
        ])
      ),
    })),
    tradeSuggestions,
    waiverRoi,
    recaps,
  };

  fs.writeFileSync('data.json', JSON.stringify(data, null, 2));
  console.log(`Wrote data.json — week ${currentWeek}, ${teams.length} teams`);
}

function suggestTrades(teams, values, players) {
  const rosterValue = (t) =>
    t.playerIds.map((id) => ({
      id,
      name: players[id] ? players[id].name : id,
      pos: players[id] ? players[id].pos : null,
      value: values[id] || 0,
    }));

  const suggestions = [];
  for (let i = 0; i < teams.length; i++) {
    for (let j = i + 1; j < teams.length; j++) {
      const a = rosterValue(teams[i]).filter((p) => p.value > 0);
      const b = rosterValue(teams[j]).filter((p) => p.value > 0);

      const needA = positionalNeed(a);
      const needB = positionalNeed(b);
      if (!needA || !needB) continue;

      // A wants needA, B wants needB: find a pair that's close in value and
      // sends each side the position it's short at.
      const fromB = b.filter((p) => p.pos === needA).sort((x, y) => y.value - x.value)[0];
      const fromA = a.filter((p) => p.pos === needB).sort((x, y) => y.value - x.value)[0];
      if (!fromA || !fromB) continue;

      const gap = Math.abs(fromA.value - fromB.value);
      const avg = (fromA.value + fromB.value) / 2;
      if (avg === 0 || gap / avg > 0.15) continue;

      suggestions.push({
        teamA: teams[i].name,
        teamB: teams[j].name,
        aSends: { name: fromA.name, pos: fromA.pos, value: fromA.value },
        bSends: { name: fromB.name, pos: fromB.pos, value: fromB.value },
        fairness: round(100 - (gap / avg) * 100),
      });
    }
  }
  return suggestions.sort((x, y) => y.fairness - x.fairness).slice(0, 12);
}

function positionalNeed(roster) {
  // Weakest starting position by total value at that spot.
  const need = ['RB', 'WR', 'TE', 'QB'].map((pos) => {
    const top = roster.filter((p) => p.pos === pos).sort((a, b) => b.value - a.value);
    const starters = pos === 'RB' || pos === 'WR' ? 2 : 1;
    const total = top.slice(0, starters).reduce((s, p) => s + p.value, 0);
    return { pos, total: total / starters };
  });
  need.sort((a, b) => a.total - b.total);
  return need[0] ? need[0].pos : null;
}

async function buildRecaps(weeklyAwards, teams, currentWeek) {
  // Recaps are cached per week: once written, never regenerated. Keeps the
  // hourly cron from burning API calls and churning the file.
  let existing = {};
  if (fs.existsSync('data.json')) {
    try {
      existing = JSON.parse(fs.readFileSync('data.json', 'utf8')).recaps || {};
    } catch (err) {
      existing = {};
    }
  }
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return existing;

  const lastComplete = weeklyAwards.length ? weeklyAwards[weeklyAwards.length - 1].week : 0;
  if (!lastComplete || existing[lastComplete]) return existing;

  const awards = weeklyAwards[weeklyAwards.length - 1];
  const standings = teams
    .slice()
    .sort((a, b) => b.wins - a.wins || b.pointsFor - a.pointsFor)
    .map((t, i) => `${i + 1}. ${t.name} (${t.wins}-${t.losses}, ${round(t.pointsFor)} PF)`)
    .join('\n');

  const prompt = `Write a fantasy football weekly recap for a 12-team full-PPR league called SoFi Finance, played among coworkers. This is week ${lastComplete}.

Awards this week:
${JSON.stringify(awards, null, 2)}

Standings:
${standings}

Three or four short paragraphs. Be funny and a little mean, but keep it good-natured — these people work together. Name specific teams and scores. No headers, no bullet points, just prose.`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const body = await res.json();
    const text = (body.content || [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n');
    if (text) existing[lastComplete] = text;
  } catch (err) {
    console.error('Recap generation failed:', err.message);
  }
  return existing;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { bestLineup, positionalNeed, suggestTrades };
