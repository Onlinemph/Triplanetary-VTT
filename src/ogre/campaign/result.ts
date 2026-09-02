/**
 * Reading a finished battle back into the campaign's vocabulary.
 *
 * This is step 1 of docs/CAMPAIGN.md's build list: "A `BattleResult` reader
 * for each engine — small, pure, testable." Everything it reports was already
 * in `GameState` — the victory, the points, the survivors — so this is a
 * projection, not a judgement; the one judgement (who won, at what level) was
 * the scenario's, and it is passed through untouched because Ogre's victory
 * levels are the boundary's own three words.
 */

import { isInfantryClass } from '../engine/units.js';
import { type GameState, type OgreUnit, isOgre, surviving } from '../engine/types.js';
import { type BattleResult, type OgreRecord, orderOf } from '../../campaign/orders.js';

/**
 * Count what a player still has, in the same vocabulary an `OrderOfBattle`
 * speaks: `UnitClassId` and `OgreTypeId` keys, infantry in squads.
 *
 * `surviving` rather than `onBoard`, deliberately: a unit that escaped off a
 * map edge is out of the battle but not out of the war, and several Ogre
 * scenarios turn on exactly that difference. The command post is left out —
 * it is the objective, not a combatant, and the landing scenario issues it
 * rather than the campaign shipping it.
 */
const survivorsOf = (state: GameState, player: string): Record<string, number> => {
  const out: Record<string, number> = {};
  const add = (id: string, n: number): void => {
    if (n > 0) out[id] = (out[id] ?? 0) + n;
  };
  for (const u of Object.values(state.units)) {
    if (u.owner !== player || !surviving(u)) continue;
    if (isOgre(u)) add(u.typeId, 1);
    else if (u.classId === 'CP') continue;
    else add(u.classId, isInfantryClass(u.classId) ? u.squads : 1);
  }
  return out;
};

/** A surviving cybertank's wear, for the campaign to carry (Orbital Drop §7). */
export const ogreRecordOf = (u: OgreUnit): OgreRecord => {
  const lost: Record<string, number> = {};
  let missilesSpent = 0;
  for (const w of u.weapons) {
    if (w.destroyed) lost[w.kind] = (lost[w.kind] ?? 0) + 1;
    else if (w.kind === 'missile' && w.fired) missilesSpent += 1;
  }
  return {
    type: u.typeId,
    treads: u.treads,
    lost,
    missilesSpent,
    internalMissiles: u.internalMissiles,
  };
};

const ogresOf = (state: GameState, player: string): OgreRecord[] =>
  Object.values(state.units)
    .filter((u): u is OgreUnit => isOgre(u) && u.owner === player && surviving(u))
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(ogreRecordOf);

/**
 * The battle's result, or `null` while it is still undecided.
 *
 * The state must have been built from an `OrderOfBattle` (the landing scenario
 * stows it in `scenarioData`); a state that was not is a programming error,
 * not a battle that ended strangely, so it throws rather than inventing a
 * battle id.
 */
export const readBattleResult = (
  state: GameState,
  log: readonly unknown[],
): BattleResult | null => {
  const order = orderOf(state.scenarioData);
  if (!order) throw new Error('this game was not built from an order of battle');
  if (!state.victory) return null;

  const survivors: Record<string, Readonly<Record<string, number>>> = {};
  const victoryPoints: Record<string, number> = {};
  const ogres: Record<string, readonly OgreRecord[]> = {};
  for (const side of order.sides) {
    survivors[side.player] = survivorsOf(state, side.player);
    victoryPoints[side.player] = state.players[side.player]?.victoryPoints ?? 0;
    const records = ogresOf(state, side.player);
    if (records.length > 0) ogres[side.player] = records;
  }

  return {
    battleId: order.battleId,
    winners: state.victory.winners,
    level: state.victory.level,
    survivors,
    victoryPoints,
    ...(Object.keys(ogres).length > 0 ? { ogres } : {}),
    replay: { seed: order.seed, log },
  };
};
