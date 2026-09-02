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
import type { ScenarioDef } from '../scenarios/types.js';
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
): GameResult => {
  const maxTurns = opts.maxTurns ?? 40;
  const cap = opts.maxCommands ?? 20000;
  const start = def.build({ seed, setup: true });
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
      plan = { key: k, commands: aiPlan(s, def.map, who, weightsFor(who)) };
    }
    const cmd = plan.commands.shift();
    if (!cmd) throw new Error(`the AI had nothing to say at ${k} in ${def.id}`);
    const out = applyCommand(s, cmd, def.map, def.checkVictory);
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
  return {
    scenario: def.id,
    seed,
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
};

const victoryValueOf = (u: GameState['units'][string]): number => {
  // Cheap and local: the counter's printed value, treads included for an Ogre.
  if (u.kind === 'ogre') return 60;
  return u.kind === 'unit' ? 6 : 0;
};

/**
 * One game from one seat's point of view, in about [-1.3, 1.3]: the verdict
 * and its level, with the points margin as a tie-breaker so a candidate that
 * loses less, or wins bigger, is told apart from one that does not.
 */
export const scoreFor = (r: GameResult, player: PlayerId): number => {
  const level =
    r.level === 'complete' ? 1 : r.level === 'standard' ? 0.85 : r.level === 'marginal' ? 0.7 : 0;
  const others = Object.keys(r.points).filter((p) => p !== player);
  const theirs = others.length ? Math.max(...others.map((p) => r.points[p] ?? 0)) : 0;
  const margin = (r.points[player] ?? 0) - theirs;
  const marginTerm = Math.max(-0.3, Math.min(0.3, margin / 200));
  if (r.winners.includes(player)) return level + marginTerm;
  if (r.winners.length > 0) return -level + marginTerm;
  return marginTerm;
};
