// scoring.js — score validation against configurable rules (DOM-free).
//
// Rules warn rather than block: unusual scores raise warnings but can still be
// saved. Only malformed/negative values are rejected outright.

/** Default hard cap when enabled but unspecified: target + 4. */
export function defaultHardCap(targetScore) {
  return Number(targetScore) + 4;
}

/**
 * Validate a score against rules.
 * @param {{a:number,b:number}} score
 * @param {{targetScore:number, winByTwo:boolean, hardCap:number|null}} rules
 * @returns {{ ok:boolean, errors:string[], warnings:string[], winner:('a'|'b'|null) }}
 */
export function validateScore(score, rules) {
  const errors = [];
  const warnings = [];
  const a = Number(score.a);
  const b = Number(score.b);

  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0) {
    return { ok: false, errors: ["Scores must be whole numbers of 0 or more."], warnings: [], winner: null };
  }

  const target = Number(rules.targetScore) || 11;
  const winByTwo = Boolean(rules.winByTwo);
  const hardCap = rules.hardCap == null ? null : Number(rules.hardCap);
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  const margin = hi - lo;
  const winner = a > b ? "a" : b > a ? "b" : null;

  if (winner === null) {
    warnings.push("This game is a tie \u2014 unusual for pickleball.");
    return { ok: true, errors, warnings, winner };
  }

  if (hi < target) {
    warnings.push(`Winning score ${hi} is below the target of ${target}.`);
  }
  if (winByTwo && margin < 2) {
    if (hardCap != null && hi >= hardCap) {
      // Win-by-two is waived at the hard cap.
    } else {
      warnings.push("Win-by-two is on but the margin is less than 2.");
    }
  }
  if (hardCap != null && hi > hardCap) {
    warnings.push(`Winning score ${hi} exceeds the hard cap of ${hardCap}.`);
  }
  if (hi > target + 15) {
    warnings.push("That score looks unusually high \u2014 double-check it.");
  }

  return { ok: true, errors, warnings, winner };
}

/** Resolve the effective rules for a session (snapshot > global settings). */
export function effectiveRules(session, settings) {
  if (session && session.rules) return session.rules;
  return {
    targetScore: settings.targetScore,
    winByTwo: settings.winByTwo,
    hardCap: settings.hardCap,
  };
}
