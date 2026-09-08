/**
 * Headless games: the computer playing every seat, as fast as the engine
 * allows. The tuning harness lives on this; the tests use it to check that
 * a weight table still finishes what it starts.
 */

import { applyCommand } from '../engine/reducer.js';
import {
  type GameState,
  type PlayerId,
  type VictoryLevel,
  activePlayer,
  setupActor,
} from '../engine/types.js';
import { overrunActor } from '../engine/overrun.js';
import { type ScenarioDef, mapOf } from '../scenarios/types.js';
import type { OrderOfBattle } from '../../campaign/orders.js';
import { aiPlan, decisionKey } from './player.js';
import { DEFAULT_WEIGHTS, type Weights } from './weights.js';

export interface GameResult {
  readonly scenario: string;
  readonly seed: number;
  readonly turns: number;
  readonly commands: number;
  readonly refused: number;
  readonly finished: boolean;
  readonly winners: readonly PlayerId[];
  readonly level: VictoryLevel | null;
  readonly reason: string;
  readonly points: Readonly<Record<PlayerId, number>>;
  /** Counters each side lost, by victory value. */
  readonly lost: Readonly<Record<PlayerId, number>>;
}

/** Which weights each seat plays with. */
export type WeightsFor = (player: PlayerId) => Weights;

export const sameWeights =
  (w: Weights = DEFAULT_WEIGHTS): WeightsFor =>
  () =>
    w;

/**
 * Play one game to its verdict, or to the command cap. The loop is the
 * shell's: plan for the decision the state is waiting on, dispatch one
 * order at a time, skip what the engine refuses, re-plan when the phase
 * changes.
 */
export const playGame = (
  def: ScenarioDef,
  seed: number,
  weightsFor: WeightsFor = sameWeights(),
  opts: { readonly maxTurns?: number; readonly maxCommands?: number } = {},
): GameResult => playFrom(def, def.build({ seed, setup: true }), weightsFor, opts).result;

/**
 * A campaign's battle, fought headless from the order that minted it — the
 * seed, the forces and the terms the freeze wrote down — with the computer
 * in every seat. The war's simulator lives on this; the state comes back
 * with the result so the campaign can read the record sheets off it.
 */
export const playOrder = (
  def: ScenarioDef,
  order: OrderOfBattle,
  weightsFor: WeightsFor = sameWeights(),
  opts: { readonly maxTurns?: number; readonly maxCommands?: number } = {},
): { readonly state: GameState; readonly result: GameResult } =>
  playFrom(def, def.build({ seed: order.seed, order, setup: true }), weightsFor, opts);

/** The loop itself, from any starting board. */
export const playFrom = (
  def: ScenarioDef,
  start: GameState,
  weightsFor: WeightsFor = sameWeights(),
  opts: { readonly maxTurns?: number; readonly maxCommands?: number } = {},
): { readonly state: GameState; readonly result: GameResult } => {
  const maxTurns = opts.maxTurns ?? 40;
  const cap = opts.maxCommands ?? 20000;
  let s: GameState = start;
  let plan: { key: string; commands: ReturnType<typeof aiPlan> } | null = null;
  let commands = 0;
  let refused = 0;
  // A game nobody is winning is stopped at the turn cap and scored on
  // points: a table that will not fight is told apart from one that loses.
  for (let i = 0; i < cap && !s.victory && s.turn <= maxTurns; i++) {
    const who = setupActor(s) ?? overrunActor(s) ?? activePlayer(s);
    const k = decisionKey(s);
    if (!plan || plan.key !== k) {
      plan = { key: k, commands: aiPlan(s, mapOf(def, s), who, weightsFor(who)) };
    }
    const cmd = plan.commands.shift();
    if (!cmd) throw new Error(`the AI had nothing to say at ${k} in ${def.id}`);
    const out = applyCommand(s, cmd, mapOf(def, s), def.checkVictory);
    commands++;
    if (!out.result.ok) {
      refused++;
      continue;
    }
    s = out.state;
  }
  const points: Record<PlayerId, number> = {};
  const lost: Record<PlayerId, number> = {};
  for (const p of s.playerOrder) {
    points[p] = s.players[p]?.victoryPoints ?? 0;
    lost[p] = 0;
  }
  for (const u of Object.values(s.units)) {
    if (u.destroyed) lost[u.owner] = (lost[u.owner] ?? 0) + victoryValueOf(u);
  }
  const result: GameResult = {
    scenario: def.id,
    seed: seedOf(start),
    turns: s.turn,
    commands,
    refused,
    finished: s.victory !== null,
    winners: s.victory?.winners ?? [],
    level: s.victory?.level ?? null,
    reason: s.victory?.reason ?? '',
    points,
    lost,
  };
  return { state: s, result };
};

/** The seed a board was built from, for the record; the rng carries it. */
const seedOf = (state: GameState): number => {
  const seed = (state.rng as { readonly seed?: unknown }).seed;
  return typeof seed === 'number' ? seed : 0;
};

const victoryValueOf = (u: GameState['units'][string]): number => {
  // Cheap and local: the counter's printed value, treads included for an Ogre.
  if (u.kind === 'ogre') return 60;
  return u.kind === 'unit' ? 6 : 0;
};

/**
 * One game from one seat's point of view, in about [-1.5, 1.5]: the verdict
 * and its level, with the points margin as a tie-breaker so a candidate that
 * loses less, or wins bigger, is told apart from one that does not.
 */
export const scoreFor = (r: GameResult, player: PlayerId): number => {
  const level =
    r.level === 'complete' ? 1 : r.level === 'standard' ? 0.85 : r.level === 'marginal' ? 0.7 : 0;
  const others = Object.keys(r.points).filter((p) => p !== player);
  const theirs = others.length ? Math.max(...others.map((p) => r.points[p] ?? 0)) : 0;
  const margin = (r.points[player] ?? 0) - theirs;
  // A GEV kept alive is six points the other side did not score: enough to
  // tell two tables apart that reach the same verdict.
  const marginTerm = Math.max(-0.5, Math.min(0.5, margin / 80));
  if (r.winners.includes(player)) return level + marginTerm;
  if (r.winners.length > 0) return -level + marginTerm;
  return marginTerm;
};
