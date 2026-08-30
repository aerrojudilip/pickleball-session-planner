// scheduler.js — constrained randomized round generation (DOM-free, testable).
//
// The scheduler does NOT use a naive shuffle. For each round it:
//   1. Chooses sit-outs fairly (lowest prior sit-out count sits first).
//   2. Generates K random restart candidates for the playing pool.
//   3. Scores each candidate with a weighted cost function (lower is better).
//   4. Rejects candidates that violate hard constraints (mustPair/mustNotPair).
//   5. Picks the lowest-cost surviving candidate.
//
// Modes:
//   random  — maximum mixing, no skill terms.
//   balanced— adds team-skill-balance and cross-court-spread terms.
//   fixed   — configured pairs (and existing dynamic pairs) stay together;
//             only opponents rotate.
//   tiered  — king-of-the-court: rating-seed court 1 downward, then winners
//             move up and losers move down after scored rounds.
//
// All randomness flows from an injected seeded RNG so a seed reproduces a
// schedule byte-for-byte.

import { createRng, deriveRoundSeed } from "./rng.js";
import { DEFAULT_RATING } from "./schema.js";

const DEFAULT_RESTARTS = 500;

/** unordered pair key */
function pk(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Build lookup tables from prior rounds for the cost function.
 * @param {Array} priorRounds
 */
export function buildHistory(priorRounds) {
  const partnerCount = new Map();
  const partnerLast = new Map();
  const opponentCount = new Map();
  const opponentLast = new Map();
  const playerLastCourt = new Map();
  const sitOutCount = new Map();

  priorRounds.forEach((round, idx) => {
    for (const id of round.sitOutIds || []) {
      sitOutCount.set(id, (sitOutCount.get(id) || 0) + 1);
    }
    for (const court of round.courts || []) {
      const { teamA = [], teamB = [] } = court;
      // partners
      for (const team of [teamA, teamB]) {
        if (team.length === 2) {
          const key = pk(team[0], team[1]);
          partnerCount.set(key, (partnerCount.get(key) || 0) + 1);
          partnerLast.set(key, idx);
        }
      }
      // opponents (every A vs every B)
      for (const a of teamA) {
        for (const b of teamB) {
          const key = pk(a, b);
          opponentCount.set(key, (opponentCount.get(key) || 0) + 1);
          opponentLast.set(key, idx);
        }
      }
      // court occupancy
      for (const id of [...teamA, ...teamB]) {
        playerLastCourt.set(id, court.courtNumber);
      }
    }
  });

  return {
    lastRoundIndex: priorRounds.length - 1,
    partnerCount,
    partnerLast,
    opponentCount,
    opponentLast,
    playerLastCourt,
    sitOutCount,
  };
}

/**
 * Choose which players sit out this round.
 * Ranks active players by prior sit-out count ascending (fewest sit-outs sit
 * first), breaking ties with the seeded RNG. Guarantees a max spread of 1
 * while the active pool is stable.
 *
 * @returns {{ sitOutIds: string[], playingIds: string[], courtsUsed: number }}
 */
export function chooseSitOuts(activeIds, history, courtCount, rng) {
  const activeCount = activeIds.length;
  const courtsUsed = Math.min(courtCount, Math.floor(activeCount / 4));
  const playingCount = courtsUsed * 4;
  const sitOutNeeded = activeCount - playingCount;

  if (sitOutNeeded <= 0) {
    return { sitOutIds: [], playingIds: activeIds.slice(), courtsUsed };
  }

  // Sort by sit-out count ascending, random tie-break.
  const decorated = activeIds.map((id) => ({
    id,
    count: history.sitOutCount.get(id) || 0,
    r: rng.next(),
  }));
  decorated.sort((a, b) => a.count - b.count || a.r - b.r);

  const sitOutIds = decorated.slice(0, sitOutNeeded).map((d) => d.id);
  const sitOutSet = new Set(sitOutIds);
  const playingIds = activeIds.filter((id) => !sitOutSet.has(id));
  return { sitOutIds, playingIds, courtsUsed };
}

/** average team rating (sum of two ratings) using fallback for unrated. */
function ratingOf(player, meanRating) {
  if (player && player.rating != null) return player.rating;
  return meanRating;
}

/**
 * Score a candidate list of courts. Lower is better.
 * @returns {number}
 */
export function scoreCandidate(courts, ctx) {
  const { history, weights, mode, ratingById, meanRating } = ctx;
  const last = history.lastRoundIndex;
  let cost = 0;

  const courtAvgs = [];

  for (const court of courts) {
    const { teamA, teamB, courtNumber } = court;

    // Partner repeats
    for (const team of [teamA, teamB]) {
      if (team.length === 2) {
        const key = pk(team[0], team[1]);
        const count = history.partnerCount.get(key) || 0;
        if (count > 0) {
          const inLast = history.partnerLast.get(key) === last;
          cost += weights.partnerRepeat * (inLast ? 10 : 1) * (inLast ? 1 : count);
        }
      }
    }

    // Opponent repeats
    for (const a of teamA) {
      for (const b of teamB) {
        const key = pk(a, b);
        const count = history.opponentCount.get(key) || 0;
        if (count > 0) {
          const inLast = history.opponentLast.get(key) === last;
          cost += weights.opponentRepeat * (inLast ? 10 : 1) * (inLast ? 1 : count);
        }
      }
    }

    // Court repeat (stuck on the same court as last round)
    for (const id of [...teamA, ...teamB]) {
      if (history.playerLastCourt.get(id) === courtNumber) {
        cost += weights.courtRepeat;
      }
    }

    // Skill terms (balanced/tiered only)
    if (mode === "balanced" || mode === "tiered") {
      const aSum = teamSum(teamA, ratingById, meanRating);
      const bSum = teamSum(teamB, ratingById, meanRating);
      cost += weights.skillBalance * Math.abs(aSum - bSum);
      courtAvgs.push((aSum + bSum) / 4);
    }
  }

  if ((mode === "balanced" || mode === "tiered") && courtAvgs.length > 1) {
    const spread = Math.max(...courtAvgs) - Math.min(...courtAvgs);
    cost += weights.crossCourtSpread * spread;
  }

  return cost;
}

function teamSum(team, ratingById, meanRating) {
  let sum = 0;
  for (const id of team) {
    const r = ratingById.get(id);
    sum += r == null ? meanRating : r;
  }
  return sum;
}

/**
 * Validate hard constraints against a set of courts.
 * @returns {{ valid: boolean, violations: string[] }}
 */
export function validateConstraints(courts, constraints, playerNameById = new Map()) {
  const violations = [];
  const mustNot = constraints.mustNotPair || [];
  const mustPair = constraints.mustPair || [];

  // Map each player to their partner in this candidate.
  const partnerOf = new Map();
  const presentIds = new Set();
  for (const court of courts) {
    for (const team of [court.teamA, court.teamB]) {
      if (team.length === 2) {
        partnerOf.set(team[0], team[1]);
        partnerOf.set(team[1], team[0]);
      }
      for (const id of team) presentIds.add(id);
    }
  }

  const nm = (id) => playerNameById.get(id) || id;

  for (const [a, b] of mustNot) {
    if (partnerOf.get(a) === b) {
      violations.push(`${nm(a)} and ${nm(b)} must not be partners.`);
    }
  }
  for (const [a, b] of mustPair) {
    // Only enforced if BOTH are present (playing) this round.
    if (presentIds.has(a) && presentIds.has(b) && partnerOf.get(a) !== b) {
      violations.push(`${nm(a)} and ${nm(b)} must be partners.`);
    }
  }
  return { valid: violations.length === 0, violations };
}

/**
 * Generate one round.
 *
 * @param {object} opts
 * @param {string[]} opts.activeIds - active player ids in this session
 * @param {Map} opts.ratingById - id -> rating|null
 * @param {Map} [opts.nameById] - id -> name (for warnings)
 * @param {number} opts.courtCount
 * @param {Array} opts.priorRounds
 * @param {object} opts.weights
 * @param {string} opts.mode
 * @param {object} opts.constraints - { mustPair, mustNotPair }
 * @param {number} opts.roundSeed
 * @param {Array} [opts.lockedCourts] - courts to keep fixed
 * @param {number} [opts.restarts]
 * @returns {{ round: object|null, error?: string }}
 */
export function generateRound(opts) {
  const {
    activeIds,
    ratingById,
    nameById = new Map(),
    courtCount,
    priorRounds = [],
    weights,
    mode = "random",
    constraints = { mustPair: [], mustNotPair: [] },
    roundSeed,
    lockedCourts = [],
    restarts = DEFAULT_RESTARTS,
  } = opts;

  if (activeIds.length < 4) {
    return { round: null, error: "Need at least 4 active players to generate a round." };
  }

  const rng = createRng(roundSeed >>> 0);
  const history = buildHistory(priorRounds);
  const meanRating = computeMeanRating(activeIds, ratingById);

  // Players locked into fixed courts are removed from the pool.
  const lockedPlayerIds = new Set();
  const activeIdSet = new Set(activeIds);
  for (const c of lockedCourts) {
    for (const id of [...c.teamA, ...c.teamB]) lockedPlayerIds.add(id);
    const inactiveIds = [...c.teamA, ...c.teamB].filter((id) => !activeIdSet.has(id));
    if (inactiveIds.length) {
      const names = inactiveIds.map((id) => nameById.get(id) || id).join(", ");
      return { round: null, error: `Unlock court ${c.courtNumber}: ${names} is no longer active.` };
    }
    const lockedCheck = validateConstraints([c], { mustPair: [], mustNotPair: constraints.mustNotPair }, nameById);
    if (!lockedCheck.valid) {
      return { round: null, error: `Unlock court ${c.courtNumber}: ${lockedCheck.violations.join(" ")}` };
    }
  }

  const poolIds = activeIds.filter((id) => !lockedPlayerIds.has(id));
  const lockedCourtNumbers = new Set(lockedCourts.map((c) => c.courtNumber));
  const availableCourtCount = courtCount - lockedCourts.length;

  // Sit-outs are chosen from the unlocked pool.
  const { sitOutIds, playingIds, courtsUsed } = chooseSitOuts(poolIds, history, availableCourtCount, rng);

  const warnings = [];
  let courts;

  if (mode === "tiered") {
    const result = generateTieredCourts({ playingIds, ratingById, priorRounds, meanRating, courtsUsed, lockedCourtNumbers, warnings });
    courts = result.courts;
    const tieredCheck = validateConstraints(courts, constraints, nameById);
    if (!tieredCheck.valid) {
      const adjusted = generateOptimizedRound({ playingIds, constraints, ratingById, meanRating, weights, history, mode, courtsUsed, rng, nameById, restarts, lockedCourtNumbers });
      courts = adjusted.courts;
      warnings.push("King-of-the-court placement was adjusted to honor pair constraints.");
      warnings.push(...adjusted.warnings);
    }
  } else if (mode === "fixed") {
    const result = generateFixedRound({ playingIds, constraints, priorRounds, ratingById, meanRating, weights, history, mode, courtsUsed, rng, nameById, lockedCourtNumbers });
    courts = result.courts;
    warnings.push(...result.warnings);
    const fixedCheck = courts ? validateConstraints(courts, constraints, nameById) : { valid: false };
    if (!fixedCheck.valid) {
      const adjusted = generateOptimizedRound({ playingIds, constraints, ratingById, meanRating, weights, history, mode, courtsUsed, rng, nameById, restarts, lockedCourtNumbers });
      courts = adjusted.courts;
      warnings.push("Fixed-partner placement was adjusted to honor pair constraints.");
      warnings.push(...adjusted.warnings);
    }
  } else {
    const result = generateOptimizedRound({ playingIds, constraints, ratingById, meanRating, weights, history, mode, courtsUsed, rng, nameById, restarts, lockedCourtNumbers });
    courts = result.courts;
    warnings.push(...result.warnings);
  }

  if (!courts) {
    return { round: null, error: "Could not build a valid round with the current constraints." };
  }

  // Merge locked courts back in, preserving their numbers.
  const allCourts = [...lockedCourts.map(cloneCourt), ...courts].sort((a, b) => a.courtNumber - b.courtNumber);
  const forbiddenPairCheck = validateConstraints(allCourts, { mustPair: [], mustNotPair: constraints.mustNotPair }, nameById);
  if (!forbiddenPairCheck.valid) {
    return { round: null, error: `Could not build a valid round. ${forbiddenPairCheck.violations.join(" ")}` };
  }
  const mergedConstraintCheck = validateConstraints(allCourts, constraints, nameById);
  if (!mergedConstraintCheck.valid) {
    const details = mergedConstraintCheck.violations.join(" ");
    if (!warnings.some((warning) => warning.includes(details))) {
      warnings.push(`Fixed-pair constraints were relaxed: ${details}`);
    }
  }

  const round = {
    roundNumber: priorRounds.length + 1,
    startedAt: new Date().toISOString(),
    status: "draft",
    sitOutIds,
    warnings,
    courts: allCourts,
  };

  return { round };
}

function computeMeanRating(ids, ratingById) {
  let sum = 0;
  let n = 0;
  for (const id of ids) {
    const r = ratingById.get(id);
    if (r != null) {
      sum += r;
      n += 1;
    }
  }
  return n ? sum / n : DEFAULT_RATING;
}

function cloneCourt(c) {
  return {
    courtNumber: c.courtNumber,
    teamA: c.teamA.slice(),
    teamB: c.teamB.slice(),
    score: c.score ? { ...c.score } : null,
    status: c.status || "pending",
    locked: Boolean(c.locked),
    timerEndsAt: c.timerEndsAt || null,
  };
}

/**
 * Random / balanced generation with K restarts and hard-constraint rejection.
 * Falls back to relaxing mustPair if no candidate survives.
 */
function generateOptimizedRound(args) {
  const { playingIds, constraints, ratingById, meanRating, weights, history, mode, courtsUsed, rng, nameById, restarts, lockedCourtNumbers } = args;
  const courtNumbers = courtNumbersFor(courtsUsed, lockedCourtNumbers);
  const ctx = { history, weights, mode, ratingById, meanRating };

  // Forced teams from mustPair (both playing).
  const playingSet = new Set(playingIds);
  const forcedTeams = (constraints.mustPair || [])
    .filter(([a, b]) => playingSet.has(a) && playingSet.has(b))
    .map(([a, b]) => [a, b]);

  const warnings = [];
  // Detect mustPair whose partner is sitting/absent.
  for (const [a, b] of constraints.mustPair || []) {
    const aIn = playingSet.has(a);
    const bIn = playingSet.has(b);
    if (aIn !== bIn) {
      const present = aIn ? a : b;
      warnings.push(`Fixed pair split: ${nameById.get(present) || present}'s partner isn't playing this round.`);
    }
  }

  const best = runRestarts({ restarts, forcedTeams, playingIds, courtsUsed, courtNumbers, rng, ctx, constraints, nameById, respectMustPair: true });
  if (best.courts) return { courts: best.courts, warnings };

  // Relax mustPair and retry.
  const relaxed = runRestarts({ restarts, forcedTeams: [], playingIds, courtsUsed, courtNumbers, rng, ctx, constraints, nameById, respectMustPair: false });
  if (relaxed.courts) {
    warnings.push("Fixed-pair constraints were relaxed to build a valid round.");
    return { courts: relaxed.courts, warnings };
  }
  return { courts: null, warnings };
}

function runRestarts(args) {
  const { restarts, forcedTeams, playingIds, courtsUsed, courtNumbers, rng, ctx, constraints, nameById, respectMustPair } = args;
  const forcedMembers = new Set(forcedTeams.flat());
  const singles = playingIds.filter((id) => !forcedMembers.has(id));

  let bestCourts = null;
  let bestCost = Infinity;

  for (let k = 0; k < restarts; k += 1) {
    const shuffledSingles = rng.shuffle(singles);
    const teams = forcedTeams.map((t) => t.slice());
    for (let i = 0; i + 1 < shuffledSingles.length; i += 2) {
      teams.push([shuffledSingles[i], shuffledSingles[i + 1]]);
    }
    if (teams.length !== courtsUsed * 2) continue; // shouldn't happen
    const shuffledTeams = rng.shuffle(teams);
    const courts = [];
    for (let c = 0; c < courtsUsed; c += 1) {
      courts.push({
        courtNumber: courtNumbers[c],
        teamA: shuffledTeams[2 * c],
        teamB: shuffledTeams[2 * c + 1],
        score: null,
        status: "pending",
        locked: false,
        timerEndsAt: null,
      });
    }

    const check = validateConstraints(courts, respectMustPair ? constraints : { mustPair: [], mustNotPair: constraints.mustNotPair }, nameById);
    if (!check.valid) continue;

    const cost = scoreCandidate(courts, ctx);
    if (cost < bestCost) {
      bestCost = cost;
      bestCourts = courts;
      if (cost === 0) break; // perfect
    }
  }
  return { courts: bestCourts, cost: bestCost };
}

/**
 * Fixed-partner mode: keep configured pairs and any existing dynamic pairs
 * together; only rotate opponents. Unpaired players are dynamically paired.
 */
function generateFixedRound(args) {
  const { playingIds, constraints, priorRounds, ratingById, meanRating, weights, history, mode, courtsUsed, rng, nameById, lockedCourtNumbers } = args;
  const playingSet = new Set(playingIds);
  const used = new Set();
  const teams = [];
  const warnings = [];

  // 1. Configured pairs first.
  for (const [a, b] of constraints.mustPair || []) {
    if (playingSet.has(a) && playingSet.has(b) && !used.has(a) && !used.has(b)) {
      teams.push([a, b]);
      used.add(a);
      used.add(b);
    }
  }

  // 2. Preserve dynamic pairs from the previous round when both are playing.
  const prev = priorRounds[priorRounds.length - 1];
  if (prev) {
    for (const court of prev.courts) {
      for (const team of [court.teamA, court.teamB]) {
        if (team.length === 2 && playingSet.has(team[0]) && playingSet.has(team[1]) && !used.has(team[0]) && !used.has(team[1])) {
          teams.push([team[0], team[1]]);
          used.add(team[0]);
          used.add(team[1]);
        }
      }
    }
  }

  // 3. Pair remaining singles.
  const singles = rng.shuffle(playingIds.filter((id) => !used.has(id)));
  for (let i = 0; i + 1 < singles.length; i += 2) {
    teams.push([singles[i], singles[i + 1]]);
  }

  if (teams.length !== courtsUsed * 2) {
    return { courts: null, warnings };
  }

  // 4. Assign teams to courts to minimize opponent/court repeats (restarts).
  const courtNumbers = courtNumbersFor(courtsUsed, lockedCourtNumbers);
  const ctx = { history, weights, mode, ratingById, meanRating };
  let bestCourts = null;
  let bestCost = Infinity;
  for (let k = 0; k < 300; k += 1) {
    const shuffled = rng.shuffle(teams);
    const courts = [];
    for (let c = 0; c < courtsUsed; c += 1) {
      courts.push({
        courtNumber: courtNumbers[c],
        teamA: shuffled[2 * c],
        teamB: shuffled[2 * c + 1],
        score: null,
        status: "pending",
        locked: false,
        timerEndsAt: null,
      });
    }
    const check = validateConstraints(courts, { mustPair: [], mustNotPair: constraints.mustNotPair }, nameById);
    if (!check.valid) continue;
    const cost = scoreCandidate(courts, ctx);
    if (cost < bestCost) {
      bestCost = cost;
      bestCourts = courts;
      if (cost === 0) break;
    }
  }
  return { courts: bestCourts, warnings };
}

/**
 * Tiered / king-of-the-court generation.
 * Round 1 (no scored prior round): rating-seed courts, balanced teams per tier.
 * Later rounds: winners move up a court, losers move down; boundary teams stay.
 * If sit-outs/absences break a movement, affected slots are re-formed by rating.
 */
function generateTieredCourts(args) {
  const { playingIds, ratingById, priorRounds, meanRating, courtsUsed, lockedCourtNumbers, warnings } = args;
  const courtNumbers = courtNumbersFor(courtsUsed, lockedCourtNumbers);
  const prev = priorRounds[priorRounds.length - 1];
  const prevScored = prev && prev.courts.length && prev.courts.every((c) => c.status !== "pending");

  const playingSet = new Set(playingIds);

  if (prevScored) {
    // Build ordered list of teams by their new court after movement.
    const movingTeams = [];
    for (const court of prev.courts) {
      const winnerIsA = court.score && court.score.a > court.score.b;
      const winnerIsB = court.score && court.score.b > court.score.a;
      const decisive = winnerIsA || winnerIsB;
      const winner = winnerIsA ? court.teamA : court.teamB;
      const loser = winnerIsA ? court.teamB : court.teamA;
      if (!decisive) {
        // Tie/abandoned: teams keep their court.
        movingTeams.push({ team: court.teamA, target: court.courtNumber });
        movingTeams.push({ team: court.teamB, target: court.courtNumber });
        warnings.push(`Court ${court.courtNumber} was not decisive; teams kept their court.`);
      } else {
        movingTeams.push({ team: winner, target: Math.max(1, court.courtNumber - 1) });
        movingTeams.push({ team: loser, target: Math.min(courtNumbers.length, court.courtNumber + 1) });
      }
    }

    // Keep only teams whose members are all still playing; collect broken players.
    const brokenPlayers = [];
    const intact = [];
    for (const mt of movingTeams) {
      if (mt.team.length === 2 && mt.team.every((id) => playingSet.has(id))) {
        intact.push(mt);
      } else {
        for (const id of mt.team) if (playingSet.has(id)) brokenPlayers.push(id);
      }
    }
    if (brokenPlayers.length) {
      warnings.push("Some king-of-the-court moves were re-formed because players changed.");
    }
    // Re-pair broken players by rating into replacement teams.
    brokenPlayers.sort((a, b) => (ratingById.get(b) ?? meanRating) - (ratingById.get(a) ?? meanRating));
    for (let i = 0; i + 1 < brokenPlayers.length; i += 2) {
      intact.push({ team: [brokenPlayers[i], brokenPlayers[i + 1]], target: courtNumbers[Math.floor(i / 2) % courtNumbers.length] });
    }

    // Also include any playing players not represented at all (new arrivals).
    const seen = new Set(intact.flatMap((mt) => mt.team));
    const extras = playingIds.filter((id) => !seen.has(id));
    extras.sort((a, b) => (ratingById.get(b) ?? meanRating) - (ratingById.get(a) ?? meanRating));
    for (let i = 0; i + 1 < extras.length; i += 2) {
      intact.push({ team: [extras[i], extras[i + 1]], target: courtNumbers[courtNumbers.length - 1] });
    }

    // Distribute teams to courts: 2 per court, respecting target order.
    intact.sort((a, b) => a.target - b.target);
    const courts = [];
    for (let c = 0; c < courtsUsed; c += 1) {
      const teamA = intact[2 * c] ? intact[2 * c].team : [];
      const teamB = intact[2 * c + 1] ? intact[2 * c + 1].team : [];
      courts.push({ courtNumber: courtNumbers[c], teamA, teamB, score: null, status: "pending", locked: false, timerEndsAt: null });
    }
    return { courts };
  }

  // Seed by rating: sort desc, chunk into courts of 4, balanced teams (1&4 vs 2&3).
  const ranked = playingIds.slice().sort((a, b) => (ratingById.get(b) ?? meanRating) - (ratingById.get(a) ?? meanRating));
  const courts = [];
  for (let c = 0; c < courtsUsed; c += 1) {
    const four = ranked.slice(c * 4, c * 4 + 4);
    courts.push({
      courtNumber: courtNumbers[c],
      teamA: [four[0], four[3]].filter(Boolean),
      teamB: [four[1], four[2]].filter(Boolean),
      score: null,
      status: "pending",
      locked: false,
      timerEndsAt: null,
    });
  }
  return { courts };
}

/** Court numbers to fill, skipping any that are locked. */
function courtNumbersFor(courtsUsed, lockedCourtNumbers) {
  const numbers = [];
  let n = 1;
  while (numbers.length < courtsUsed) {
    if (!lockedCourtNumbers.has(n)) numbers.push(n);
    n += 1;
  }
  return numbers;
}

/**
 * Analyze a round vs its history, for UI fairness indicators and tests.
 * @returns {{ partnerRepeats: number, opponentRepeats: number, immediatePartnerRepeats: number }}
 */
export function analyzeRoundFairness(round, priorRounds) {
  const history = buildHistory(priorRounds);
  const last = history.lastRoundIndex;
  let partnerRepeats = 0;
  let opponentRepeats = 0;
  let immediatePartnerRepeats = 0;
  for (const court of round.courts) {
    for (const team of [court.teamA, court.teamB]) {
      if (team.length === 2) {
        const key = pk(team[0], team[1]);
        if (history.partnerCount.get(key)) {
          partnerRepeats += 1;
          if (history.partnerLast.get(key) === last) immediatePartnerRepeats += 1;
        }
      }
    }
    for (const a of court.teamA) {
      for (const b of court.teamB) {
        if (history.opponentCount.get(pk(a, b))) opponentRepeats += 1;
      }
    }
  }
  return { partnerRepeats, opponentRepeats, immediatePartnerRepeats };
}

/**
 * Generate multiple draft rounds in sequence (each scores against the prior
 * drafts). Tiered mode only generates the next round because movement needs
 * scores.
 *
 * @returns {{ rounds: Array, warnings: string[] }}
 */
export function generateRounds(opts, count) {
  const rounds = [];
  const warnings = [];
  const priorRounds = (opts.priorRounds || []).slice();
  const total = opts.mode === "tiered" ? 1 : Math.max(1, count);

  for (let i = 0; i < total; i += 1) {
    const roundSeed = deriveRoundSeed(opts.seed >>> 0, priorRounds.length + 1);
    const { round, error } = generateRound({ ...opts, priorRounds, roundSeed });
    if (!round) {
      warnings.push(error || "Round generation failed.");
      break;
    }
    rounds.push(round);
    priorRounds.push(round);
  }
  if (opts.mode === "tiered" && count > 1) {
    warnings.push("King-of-the-court generates one round at a time because it depends on results.");
  }
  return { rounds, warnings };
}
