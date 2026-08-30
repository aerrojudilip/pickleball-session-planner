// rng.js — deterministic, seedable pseudo-random number generation.
//
// Every stochastic decision in the scheduler (shuffles, tie-breaks, restart
// order) draws from one of these generators so that a given seed always
// reproduces the same schedule. This is critical both for debugging and for
// the "regenerate a session identically" requirement.
//
// This module is DOM-free and importable in Node for unit testing.

/**
 * mulberry32 — a fast, well-distributed 32-bit seeded PRNG.
 * Returns a function that yields floats in the half-open interval [0, 1).
 *
 * @param {number} seed - Any integer. Coerced to uint32.
 * @returns {() => number}
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Create a seeded RNG bundle with helpers built on top of a base float stream.
 *
 * @param {number} seed
 */
export function createRng(seed) {
  const next = mulberry32(seed);
  const rng = {
    /** Float in [0, 1). */
    next,
    /** Integer in [0, max). */
    int(max) {
      return Math.floor(next() * max);
    },
    /** Integer in [min, max] inclusive. */
    range(min, max) {
      return min + Math.floor(next() * (max - min + 1));
    },
    /** Pick a random element from an array. */
    pick(arr) {
      return arr[Math.floor(next() * arr.length)];
    },
    /**
     * Return a new array that is a Fisher-Yates shuffle of the input.
     * Does not mutate the source array.
     */
    shuffle(arr) {
      const out = arr.slice();
      for (let i = out.length - 1; i > 0; i -= 1) {
        const j = Math.floor(next() * (i + 1));
        const tmp = out[i];
        out[i] = out[j];
        out[j] = tmp;
      }
      return out;
    },
  };
  return rng;
}

/**
 * Derive a stable per-round seed from a session seed and round number.
 * Uses a simple integer hash so round 1 of a session is always identical.
 *
 * @param {number} sessionSeed
 * @param {number} roundNumber
 * @returns {number} uint32 seed
 */
export function deriveRoundSeed(sessionSeed, roundNumber) {
  let h = (sessionSeed >>> 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (roundNumber + 0x85ebca6b), 0xc2b2ae35);
  h ^= h >>> 13;
  h = Math.imul(h, 0x27d4eb2f);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * Generate a fresh random uint32 seed for a new session. Uses crypto when
 * available (browser + modern Node) and falls back to Math.random.
 *
 * @returns {number}
 */
export function randomSeed() {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.getRandomValues === "function") {
    const buf = new Uint32Array(1);
    cryptoObj.getRandomValues(buf);
    return buf[0] >>> 0;
  }
  return Math.floor(Math.random() * 0xffffffff) >>> 0;
}
