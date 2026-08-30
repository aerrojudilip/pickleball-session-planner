// stats.js — aggregate statistics from session history (DOM-free, testable).
//
// All stats derive from completed courts (status "completed" with a score).
// Abandoned and pending courts are ignored. Sit-outs are counted from rounds.

function completedCourts(db, sessionFilter) {
  const out = [];
  for (const session of db.sessions) {
    if (sessionFilter && !sessionFilter(session)) continue;
    for (const round of session.rounds) {
      for (const court of round.courts) {
        if (court.status === "completed" && court.score) {
          out.push({ session, round, court });
        }
      }
    }
  }
  return out;
}

function blankLine() {
  return { games: 0, wins: 0, losses: 0, ties: 0, pointsFor: 0, pointsAgainst: 0, sitOuts: 0 };
}

function pairKey(left, right) {
  return left < right ? `${left}|${right}` : `${right}|${left}`;
}

/**
 * Partner and opponent counts across every generated court. Unlike result
 * stats, pending and abandoned games remain useful evidence of schedule mix.
 */
export function buildRepeatMatrix(db, sessionFilter) {
  const playerIds = [];
  const seenPlayers = new Set();
  const partnerCounts = new Map();
  const opponentCounts = new Map();
  const includePlayer = (id) => {
    if (id && !seenPlayers.has(id)) {
      seenPlayers.add(id);
      playerIds.push(id);
    }
  };
  const increment = (counts, left, right) => {
    const key = pairKey(left, right);
    counts.set(key, (counts.get(key) || 0) + 1);
  };

  for (const session of db.sessions) {
    if (sessionFilter && !sessionFilter(session)) continue;
    for (const id of session.playerIds || []) includePlayer(id);
    for (const round of session.rounds || []) {
      for (const id of round.sitOutIds || []) includePlayer(id);
      for (const court of round.courts || []) {
        const teamA = court.teamA || [];
        const teamB = court.teamB || [];
        for (const id of [...teamA, ...teamB]) includePlayer(id);
        if (teamA.length === 2) increment(partnerCounts, teamA[0], teamA[1]);
        if (teamB.length === 2) increment(partnerCounts, teamB[0], teamB[1]);
        for (const left of teamA) {
          for (const right of teamB) increment(opponentCounts, left, right);
        }
      }
    }
  }

  return {
    playerIds,
    partnerCounts,
    opponentCounts,
    maxPartner: Math.max(0, ...partnerCounts.values()),
    maxOpponent: Math.max(0, ...opponentCounts.values()),
  };
}

/**
 * Per-player aggregate stats keyed by player id.
 * @param {object} db
 * @param {(session)=>boolean} [sessionFilter]
 * @returns {Map<string, object>}
 */
export function computePlayerStats(db, sessionFilter) {
  const stats = new Map();
  const ensure = (id) => {
    if (!stats.has(id)) stats.set(id, { playerId: id, ...blankLine() });
    return stats.get(id);
  };

  for (const { court } of completedCourts(db, sessionFilter)) {
    const a = court.score.a;
    const b = court.score.b;
    const aWin = a > b;
    const bWin = b > a;
    for (const id of court.teamA) {
      const s = ensure(id);
      s.games += 1;
      s.pointsFor += a;
      s.pointsAgainst += b;
      if (aWin) s.wins += 1;
      else if (bWin) s.losses += 1;
      else s.ties += 1;
    }
    for (const id of court.teamB) {
      const s = ensure(id);
      s.games += 1;
      s.pointsFor += b;
      s.pointsAgainst += a;
      if (bWin) s.wins += 1;
      else if (aWin) s.losses += 1;
      else s.ties += 1;
    }
  }

  // Sit-outs
  for (const session of db.sessions) {
    if (sessionFilter && !sessionFilter(session)) continue;
    for (const round of session.rounds) {
      for (const id of round.sitOutIds || []) ensure(id).sitOuts += 1;
    }
  }

  // Derived fields
  for (const s of stats.values()) {
    s.diff = s.pointsFor - s.pointsAgainst;
    s.winPct = s.games ? s.wins / s.games : 0;
  }
  return stats;
}

/**
 * Leaderboard rows joined with player records, sorted by wins then win% then diff.
 * @returns {Array<object>}
 */
export function computeLeaderboard(db, sessionFilter) {
  const stats = computePlayerStats(db, sessionFilter);
  const nameById = new Map(db.players.map((p) => [p.id, p]));
  const rows = [];
  for (const s of stats.values()) {
    const player = nameById.get(s.playerId);
    if (!player) continue; // orphan
    if (s.games === 0 && s.sitOuts === 0) continue;
    rows.push({ ...s, name: player.name, rating: player.rating, active: player.active });
  }
  rows.sort(compareLeaderboardRows);
  return rows;
}

function compareLeaderboardRows(left, right) {
  return right.wins - left.wins || right.winPct - left.winPct || right.diff - left.diff || left.name.localeCompare(right.name);
}

/**
 * Partner chemistry for one player: games/wins with each partner.
 * @returns {Array<{ partnerId, games, wins, winPct }>}
 */
export function partnerChemistry(db, playerId) {
  const map = new Map();
  for (const { court } of completedCourts(db)) {
    for (const team of [court.teamA, court.teamB]) {
      if (team.length === 2 && team.includes(playerId)) {
        const partner = team[0] === playerId ? team[1] : team[0];
        const isA = court.teamA.includes(playerId);
        const won = isA ? court.score.a > court.score.b : court.score.b > court.score.a;
        if (!map.has(partner)) map.set(partner, { partnerId: partner, games: 0, wins: 0 });
        const rec = map.get(partner);
        rec.games += 1;
        if (won) rec.wins += 1;
      }
    }
  }
  const out = [...map.values()].map((r) => ({ ...r, winPct: r.games ? r.wins / r.games : 0 }));
  out.sort((a, b) => b.games - a.games || b.winPct - a.winPct);
  return out;
}

/**
 * Head-to-head opponents for one player: games/wins against each opponent.
 * @returns {Array<{ opponentId, games, wins, losses, winPct }>}
 */
export function headToHead(db, playerId) {
  const map = new Map();
  for (const { court } of completedCourts(db)) {
    const inA = court.teamA.includes(playerId);
    const inB = court.teamB.includes(playerId);
    if (!inA && !inB) continue;
    const opponents = inA ? court.teamB : court.teamA;
    const won = inA ? court.score.a > court.score.b : court.score.b > court.score.a;
    const lost = inA ? court.score.a < court.score.b : court.score.b < court.score.a;
    for (const opp of opponents) {
      if (!map.has(opp)) map.set(opp, { opponentId: opp, games: 0, wins: 0, losses: 0 });
      const rec = map.get(opp);
      rec.games += 1;
      if (won) rec.wins += 1;
      else if (lost) rec.losses += 1;
    }
  }
  const out = [...map.values()].map((r) => ({ ...r, winPct: r.games ? r.wins / r.games : 0 }));
  out.sort((a, b) => b.games - a.games);
  return out;
}

/** Totals for a single session (for a session summary card). */
export function sessionSummary(db, sessionId) {
  const session = db.sessions.find((s) => s.id === sessionId);
  if (!session) return null;
  const filter = (s) => s.id === sessionId;
  const stats = computePlayerStats(db, filter);
  const leaderboard = computeLeaderboard(db, filter);
  const includedIds = new Set(leaderboard.map((row) => row.playerId));
  const playerById = new Map(db.players.map((player) => [player.id, player]));
  for (const playerId of session.playerIds) {
    const player = playerById.get(playerId);
    if (!player || includedIds.has(playerId)) continue;
    leaderboard.push({
      playerId,
      ...blankLine(),
      diff: 0,
      winPct: 0,
      name: player.name,
      rating: player.rating,
      active: player.active,
    });
    includedIds.add(playerId);
  }
  leaderboard.sort(compareLeaderboardRows);
  let gamesPlayed = 0;
  for (const round of session.rounds) {
    gamesPlayed += round.courts.filter((c) => c.status === "completed" && c.score).length;
  }
  return {
    sessionId,
    rounds: session.rounds.length,
    gamesPlayed,
    players: session.playerIds.length,
    leaderboard,
    stats,
  };
}
