import test from "node:test";
import assert from "node:assert/strict";

import { createRng, deriveRoundSeed, mulberry32 } from "../../js/rng.js";
import {
  analyzeRoundFairness,
  generateRound,
  generateRounds,
  validateConstraints,
} from "../../js/scheduler.js";

const WEIGHTS = {
  partnerRepeat: 10,
  opponentRepeat: 4,
  skillBalance: 3,
  courtRepeat: 2,
  crossCourtSpread: 1,
};

function fixture(playerCount, overrides = {}) {
  const activeIds = Array.from({ length: playerCount }, (_, index) => `p${index + 1}`);
  return {
    activeIds,
    ratingById: new Map(activeIds.map((id, index) => [id, 2.5 + (index % 7) * 0.5])),
    nameById: new Map(activeIds.map((id) => [id, id.toUpperCase()])),
    courtCount: 3,
    weights: WEIGHTS,
    mode: "random",
    constraints: { mustPair: [], mustNotPair: [] },
    seed: 1_837_462,
    priorRounds: [],
    restarts: 500,
    ...overrides,
  };
}

function assignments(round) {
  return {
    sitOutIds: round.sitOutIds,
    warnings: round.warnings,
    courts: round.courts.map(({ courtNumber, teamA, teamB, locked }) => ({ courtNumber, teamA, teamB, locked })),
  };
}

function assignedIds(round) {
  return round.courts.flatMap((court) => [...court.teamA, ...court.teamB]);
}

function sitOutSpread(rounds, ids) {
  const counts = new Map(ids.map((id) => [id, 0]));
  for (const round of rounds) {
    for (const id of round.sitOutIds) counts.set(id, counts.get(id) + 1);
  }
  const values = [...counts.values()];
  return Math.max(...values) - Math.min(...values);
}

test("seeded RNG is reproducible and bounded", () => {
  const first = mulberry32(1234);
  const second = mulberry32(1234);
  const a = Array.from({ length: 20 }, first);
  const b = Array.from({ length: 20 }, second);
  assert.deepEqual(a, b);
  assert.ok(a.every((value) => value >= 0 && value < 1));
  assert.deepEqual(createRng(99).shuffle([1, 2, 3, 4, 5]), createRng(99).shuffle([1, 2, 3, 4, 5]));
  assert.equal(deriveRoundSeed(42, 3), deriveRoundSeed(42, 3));
  assert.notEqual(deriveRoundSeed(42, 3), deriveRoundSeed(42, 4));
});

test("the same seed and history reproduce the same assignments", () => {
  const options = fixture(13);
  const first = generateRounds(options, 5);
  const second = generateRounds(options, 5);
  assert.equal(first.rounds.length, 5);
  assert.deepEqual(first.rounds.map(assignments), second.rounds.map(assignments));
});

test("court and sit-out counts are correct at key pool boundaries", () => {
  for (const [count, courts, sitOuts] of [
    [4, 1, 0],
    [8, 2, 0],
    [13, 3, 1],
    [15, 3, 3],
  ]) {
    const { rounds } = generateRounds(fixture(count), 3);
    assert.equal(rounds.length, 3, `${count} players should generate three rounds`);
    for (const round of rounds) {
      assert.equal(round.courts.length, courts);
      assert.equal(round.sitOutIds.length, sitOuts);
      assert.equal(new Set([...assignedIds(round), ...round.sitOutIds]).size, count);
    }
  }
});

test("players omitted from the active pool are never assigned", () => {
  const options = fixture(9);
  options.activeIds = options.activeIds.slice(0, 8);
  const excluded = "p9";
  const { rounds } = generateRounds(options, 4);
  assert.ok(rounds.every((round) => !assignedIds(round).includes(excluded) && !round.sitOutIds.includes(excluded)));
});

test("sit-outs remain fair across ten rounds", () => {
  const options = fixture(15);
  const { rounds } = generateRounds(options, 10);
  assert.equal(rounds.length, 10);
  assert.ok(sitOutSpread(rounds, options.activeIds) <= 1);
});

test("feasible eight-player schedules avoid consecutive partner repeats", () => {
  const { rounds } = generateRounds(fixture(8, { courtCount: 2 }), 8);
  for (let index = 1; index < rounds.length; index += 1) {
    const fairness = analyzeRoundFairness(rounds[index], rounds.slice(0, index));
    assert.equal(fairness.immediatePartnerRepeats, 0, `round ${index + 1}`);
  }
});

test("14 players on 3 courts meet the eight-round acceptance criterion", () => {
  const options = fixture(14);
  const { rounds, warnings } = generateRounds(options, 8);
  assert.equal(rounds.length, 8);
  assert.deepEqual(warnings, []);
  for (let index = 1; index < rounds.length; index += 1) {
    assert.equal(analyzeRoundFairness(rounds[index], rounds.slice(0, index)).immediatePartnerRepeats, 0);
  }
  assert.ok(sitOutSpread(rounds, options.activeIds) <= 1);
});

test("must-pair and must-not-pair constraints are enforced", () => {
  const options = fixture(8, {
    courtCount: 2,
    constraints: { mustPair: [["p1", "p2"]], mustNotPair: [["p3", "p4"]] },
  });
  const { rounds } = generateRounds(options, 4);
  assert.equal(rounds.length, 4);
  for (const round of rounds) {
    const check = validateConstraints(round.courts, options.constraints, options.nameById);
    assert.equal(check.valid, true, check.violations.join(" "));
  }
});

test("must-pair relaxes with a warning while must-not-pair stays hard", () => {
  const relaxed = fixture(4, {
    courtCount: 1,
    constraints: {
      mustPair: [["p1", "p2"], ["p1", "p3"]],
      mustNotPair: [],
    },
  });
  const relaxedResult = generateRound({ ...relaxed, roundSeed: 77 });
  assert.ok(relaxedResult.round);
  assert.ok(relaxedResult.round.warnings.some((warning) => warning.includes("relaxed")));

  const impossible = fixture(4, {
    courtCount: 1,
    constraints: {
      mustPair: [],
      mustNotPair: [["p1", "p2"], ["p1", "p3"], ["p1", "p4"]],
    },
  });
  const impossibleResult = generateRound({ ...impossible, roundSeed: 77 });
  assert.equal(impossibleResult.round, null);
  assert.match(impossibleResult.error, /Could not build/);
});

test("fixed mode reports when impossible configured pairs are relaxed", () => {
  const options = fixture(4, {
    courtCount: 1,
    mode: "fixed",
    constraints: {
      mustPair: [["p1", "p2"], ["p1", "p3"]],
      mustNotPair: [],
    },
  });
  const result = generateRound({ ...options, roundSeed: 78 });
  assert.ok(result.round);
  assert.ok(result.round.warnings.some((warning) => warning.includes("relaxed")));
});

test("fixed partners stay together and tiered mode generates one round at a time", () => {
  const fixed = fixture(8, {
    courtCount: 2,
    mode: "fixed",
    constraints: { mustPair: [["p1", "p2"]], mustNotPair: [] },
  });
  const fixedRounds = generateRounds(fixed, 5).rounds;
  assert.equal(fixedRounds.length, 5);
  assert.ok(fixedRounds.every((round) => round.courts.some((court) => [court.teamA, court.teamB].some((team) => team.includes("p1") && team.includes("p2")))));

  const tiered = generateRounds(fixture(8, { courtCount: 2, mode: "tiered" }), 4);
  assert.equal(tiered.rounds.length, 1);
  assert.ok(tiered.warnings.some((warning) => warning.includes("one round at a time")));
});

test("tiered winners move up and losers move down", () => {
  const options = fixture(8, { courtCount: 2, mode: "tiered" });
  const first = generateRounds(options, 1).rounds[0];
  for (const court of first.courts) {
    court.score = { a: 11, b: 5 };
    court.status = "completed";
  }
  const next = generateRound({ ...options, priorRounds: [first], roundSeed: deriveRoundSeed(options.seed, 2) }).round;
  const courtOneTeams = next.courts.find((court) => court.courtNumber === 1);
  const expectedWinners = first.courts.flatMap((court) => court.teamA);
  assert.deepEqual(new Set([...courtOneTeams.teamA, ...courtOneTeams.teamB]), new Set(expectedWinners));
});

test("tiered mode never returns a round that violates hard pair constraints", () => {
  const forbiddenOptions = fixture(8, {
    courtCount: 2,
    mode: "tiered",
    constraints: {
      mustPair: [],
      mustNotPair: [["p7", "p4"]],
    },
  });
  const forbidden = generateRounds(forbiddenOptions, 1);
  assert.equal(forbidden.rounds.length, 1);
  assert.equal(validateConstraints(forbidden.rounds[0].courts, forbiddenOptions.constraints, forbiddenOptions.nameById).valid, true);
  assert.ok(forbidden.rounds[0].warnings.some((warning) => warning.includes("adjusted")));

  const requiredOptions = fixture(8, {
    courtCount: 2,
    mode: "tiered",
    constraints: {
      mustPair: [["p1", "p7"]],
      mustNotPair: [],
    },
  });
  const required = generateRounds(requiredOptions, 1);
  assert.equal(required.rounds.length, 1);
  const check = validateConstraints(required.rounds[0].courts, requiredOptions.constraints, requiredOptions.nameById);
  assert.equal(check.valid, true, check.violations.join(" "));
});

test("locked courts are preserved exactly while remaining slots regenerate", () => {
  const options = fixture(8, { courtCount: 2 });
  const original = generateRounds(options, 1).rounds[0];
  const locked = { ...original.courts[0], locked: true, teamA: original.courts[0].teamA.slice(), teamB: original.courts[0].teamB.slice() };
  const regenerated = generateRound({ ...options, roundSeed: 999, lockedCourts: [locked] }).round;
  assert.deepEqual(regenerated.courts.find((court) => court.courtNumber === locked.courtNumber), locked);
  assert.equal(new Set(assignedIds(regenerated)).size, 8);
});

test("locked courts cannot retain inactive players or forbidden partners", () => {
  const options = fixture(8, { courtCount: 2 });
  const original = generateRounds(options, 1).rounds[0];
  const locked = { ...original.courts[0], locked: true, teamA: original.courts[0].teamA.slice(), teamB: original.courts[0].teamB.slice() };
  const inactiveId = locked.teamA[0];
  const inactive = generateRound({
    ...options,
    activeIds: options.activeIds.filter((id) => id !== inactiveId),
    roundSeed: 1001,
    lockedCourts: [locked],
  });
  assert.equal(inactive.round, null);
  assert.match(inactive.error, /Unlock court .*no longer active/);

  const forbidden = generateRound({
    ...options,
    constraints: { mustPair: [], mustNotPair: [[...locked.teamA]] },
    roundSeed: 1002,
    lockedCourts: [locked],
  });
  assert.equal(forbidden.round, null);
  assert.match(forbidden.error, /Unlock court .*must not be partners/);
});

test("locked courts report cross-court must-pair relaxation", () => {
  const options = fixture(8, { courtCount: 2 });
  const original = generateRounds(options, 1).rounds[0];
  const locked = { ...original.courts[0], locked: true, teamA: original.courts[0].teamA.slice(), teamB: original.courts[0].teamB.slice() };
  const lockedIds = new Set([...locked.teamA, ...locked.teamB]);
  const lockedId = locked.teamA[0];
  const unlockedId = options.activeIds.find((id) => !lockedIds.has(id));
  const result = generateRound({
    ...options,
    constraints: { mustPair: [[lockedId, unlockedId]], mustNotPair: [] },
    roundSeed: 1003,
    lockedCourts: [locked],
  });
  assert.ok(result.round);
  assert.deepEqual(result.round.courts.find((court) => court.courtNumber === locked.courtNumber), locked);
  assert.ok(result.round.warnings.some((warning) => warning.includes("relaxed") && warning.includes(lockedId.toUpperCase()) && warning.includes(unlockedId.toUpperCase())));
});