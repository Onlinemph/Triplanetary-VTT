/**
 * Deterministic random number generation.
 *
 * Every die roll in the game goes through here. The generator's entire state is
 * a single 32-bit integer carried inside `GameState`, which means:
 *
 *  - a replay of the same command log produces byte-identical results;
 *  - a multiplayer server and its clients can agree on outcomes without the
 *    server having to ship every roll over the wire;
 *  - a game can be seeded from a scenario for reproducible testing.
 *
 * The algorithm is mulberry32 — small, fast, and good enough for dice.
 */

export interface RngState {
  readonly seed: number;
}

export const createRng = (seed: number): RngState => ({ seed: seed >>> 0 });

/** Advance the generator, returning the next state and a float in [0, 1). */
export const nextFloat = (state: RngState): { state: RngState; value: number } => {
  let a = (state.seed + 0x6d2b79f5) >>> 0;
  let t = a;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { state: { seed: a }, value };
};

/** Roll one six-sided die. Triplanetary uses nothing else. */
export const rollDie = (state: RngState): { state: RngState; value: number } => {
  const { state: next, value } = nextFloat(state);
  return { state: next, value: Math.floor(value * 6) + 1 };
};

/** Roll `n` six-sided dice, returning them in order. */
export const rollDice = (
  state: RngState,
  n: number,
): { state: RngState; values: number[] } => {
  let s = state;
  const values: number[] = [];
  for (let i = 0; i < n; i++) {
    const res = rollDie(s);
    s = res.state;
    values.push(res.value);
  }
  return { state: s, values };
};

/** Deterministic shuffle — used for "randomly chosen order" torpedo targeting. */
export const shuffle = <T>(state: RngState, items: readonly T[]): { state: RngState; items: T[] } => {
  const out = items.slice();
  let s = state;
  for (let i = out.length - 1; i > 0; i--) {
    const res = nextFloat(s);
    s = res.state;
    const j = Math.floor(res.value * (i + 1));
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return { state: s, items: out };
};
