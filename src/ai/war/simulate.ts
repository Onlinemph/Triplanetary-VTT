/**
 * The war, played headless: the computer in every seat above the sky and
 * below it, as fast as the two engines allow.
 *
 * The loop is the shell's, minus the pixels. The fleet game runs through the
 * pilot and the staff (`src/ai`) until the sky freezes; the battle the freeze
 * minted is built from its order and fought by the ground game's own
 * computer (`src/ogre/ai`); the result goes back through
 * `resolveGroundBattle` exactly as a finished table's would; and the day
 * resumes. The tuner in `scripts/tune-war.ts` lives on this, and the tests
 * use it to check that a weight table still fights a war rather than
 * drifting for sixty days.
 */

import { DEFAULT_MAP, type GameMap } from '../../engine/map.js';
import { applyCommand } from '../../engine/reducer.js';
import { type GameState, type PlayerId, activePlayer } from '../../engine/types.js';
import { buildScenario, netWorth } from '../../scenarios/index.js';
import { dropData } from '../../scenarios/orbitalDrop.js';
import { readBattleResult } from '../../ogre/campaign/result.js';
import { scenarioById as groundScenarioById } from '../../ogre/scenarios/index.js';
import { playOrder, sameWeights, type WeightsFor } from '../../ogre/ai/simulate.js';
import { stepAi } from '../driver.js';
import { DEFAULT_WAR_WEIGHTS, type WarWeights } from './weights.js';
import { forceValue } from './staff.js';

export interface WarResult {
  readonly seed: number;
  /** The day the war stopped on. */
  readonly days: number;
  readonly commands: number;
  /** Ground battles fought. */
  readonly battles: number;
  /** Bases that changed hands. */
  readonly captures: number;
  readonly finished: boolean;
  readonly winners: readonly PlayerId[];
  /** §8.04 net worth per power at the end: purse, hulls, holds, bases, garrisons. */
  readonly worth: Readonly<Record<PlayerId, number>>;
  /** The same on day one, so a war is scored on what changed rather than on the map's head start. */
  readonly worthAtStart: Readonly<Record<PlayerId, number>>;
  readonly bases: Readonly<Record<PlayerId, number>>;
  /** Set when a seat gave an order the rules refused, which is a policy bug. */
  readonly refused?: string;
}

export type WarWeightsFor = (player: PlayerId) => WarWeights;

export const sameWarWeights =
  (w: WarWeights = DEFAULT_WAR_WEIGHTS): WarWeightsFor =>
  () =>
    w;

/** §8.04: a planetary base counts MCr 300, an asteroid base 150, garrisons at list. */
const BASE_WORTH = { planetary: 300, asteroid: 150, orbital: 0 } as const;

export const warWorth = (state: GameState, player: PlayerId): number => {
  let total = netWorth(state, player);
  const drop = dropData(state);
  for (const base of Object.values(state.bases)) {
    if (base.destroyed || base.owner !== player) continue;
    total += BASE_WORTH[base.kind];
    const g = drop.garrisons[base.id];
    if (g) total += forceValue(g.units) + forceValue(g.reaction);
  }
  return Math.round(total * 100) / 100;
};

/**
 * Play one war to its verdict, or to the day cap.
 *
 * `ground` is the weight table the ground game's computer fights the
 * battles with — the shipped one unless a caller says otherwise. Both seats
 * of every battle use it: the war's tuner is searching the staff, not the
 * ground tactics, so the battles must be the same test for every candidate.
 */
export const playWar = (
  seed: number,
  weightsFor: WarWeightsFor = sameWarWeights(),
  opts: {
    readonly maxDays?: number;
    readonly maxCommands?: number;
    readonly ground?: WeightsFor;
    readonly map?: GameMap;
  } = {},
): WarResult => {
  const maxDays = opts.maxDays ?? 60;
  const cap = opts.maxCommands ?? 40000;
  const ground = opts.ground ?? sameWeights();
  const map = opts.map ?? DEFAULT_MAP;
  let s = buildScenario('orbital-drop', { seed });
  const seats = new Set(s.playerOrder);
  const worthAtStart: Record<PlayerId, number> = {};
  for (const p of s.playerOrder) worthAtStart[p] = warWorth(s, p);
  const owners = () =>
    Object.values(s.bases)
      .map((b) => `${b.id}:${b.owner ?? ''}`)
      .join('|');
  let before = owners();

  let commands = 0;
  let battles = 0;
  let captures = 0;
  let refused: string | undefined;

  while (!s.victory && s.turn <= maxDays && commands < cap) {
    const pending = dropData(s).pendingGround;
    if (pending) {
      const def = groundScenarioById(pending.scenarioId);
      if (!def) throw new Error(`no ground scenario "${pending.scenarioId}"`);
      const fought = playOrder(def, pending, ground, { maxTurns: 40 });
      // A battle still undecided at the ground game's cap is called for the
      // defence: an attacker that has not taken the base by then has not
      // taken it, and §6.02's "holding the map" was never reached.
      const decided = fought.state.victory
        ? fought.state
        : {
            ...fought.state,
            victory: {
              winners: [pending.sides[1]!.player],
              level: 'standard' as const,
              reason: 'The landing never took the base; the battle is called for the defence.',
            },
          };
      const result = readBattleResult(decided, []);
      if (result === null) {
        refused = `ground battle ${pending.battleId} produced no result`;
        break;
      }
      const out = applyCommand(
        s,
        { type: 'resolveGroundBattle', by: activePlayer(s), result },
        map,
      );
      if (!out.result.ok) {
        refused = `resolveGroundBattle: ${out.result.reason ?? 'refused'}`;
        break;
      }
      s = out.state;
      battles += 1;
      commands += 1;
      const after = owners();
      if (after !== before) captures += 1;
      before = after;
      continue;
    }
    const step = stepAi(s, seats, map, weightsFor);
    if (step.refused !== undefined) {
      refused = `${step.command?.type ?? '?'} by ${step.by ?? '?'}: ${step.refused}`;
      break;
    }
    if (step.command === null) break; // nobody owes anything and nothing is frozen: stuck
    s = step.state;
    commands += 1;
  }

  const worth: Record<PlayerId, number> = {};
  const bases: Record<PlayerId, number> = {};
  for (const p of s.playerOrder) {
    worth[p] = warWorth(s, p);
    bases[p] = Object.values(s.bases).filter((b) => !b.destroyed && b.owner === p).length;
  }
  return {
    seed,
    days: s.turn,
    commands,
    battles,
    captures,
    finished: s.victory !== null,
    winners: s.victory?.winners ?? [],
    worth,
    worthAtStart,
    bases,
    ...(refused !== undefined ? { refused } : {}),
  };
};

/**
 * One war from one power's point of view, in about [-1.5, 1.5]: the verdict
 * when there is one, and otherwise how the net-worth margin — which is what
 * §8.04 counts — moved over the war. Moved, not stood: the map hands the
 * Combine twice the bases on day one, and a score that counted that would
 * teach nothing but which seat to sit in.
 */
export const scoreWar = (r: WarResult, player: PlayerId): number => {
  const gained = (p: PlayerId): number => (r.worth[p] ?? 0) - (r.worthAtStart[p] ?? 0);
  const others = Object.keys(r.worth).filter((p) => p !== player);
  const theirs = others.length ? Math.max(...others.map(gained)) : 0;
  const margin = gained(player) - theirs;
  // Six hundred MegaCredits — two planetary bases — is a decisive margin.
  const marginTerm = Math.max(-1, Math.min(1, margin / 600));
  if (r.winners.includes(player)) return 1 + marginTerm * 0.5;
  if (r.winners.length > 0) return -1 + marginTerm * 0.5;
  return marginTerm;
};
