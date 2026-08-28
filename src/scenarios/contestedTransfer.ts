/**
 * **Contested Transfer** — the campaign's space battle, playable on its own.
 *
 * The campaign design (OGRE-VTT, docs/CAMPAIGN.md) resolves a campaign turn
 * in two battles: "Contested transfers are fought in Triplanetary. Who
 * arrives, and with how much fuel and cargo, is the output." This scenario is
 * that sentence made playable: a convoy sails from its home port with a
 * ground force in its holds, an interception fleet is waiting somewhere on
 * the route, and the only number that matters at the end is how many tons got
 * down on the target world.
 *
 * Built from an `OrderOfBattle` it fields exactly the hulls and freight the
 * campaign committed; built with no order at all it plays a printed default,
 * so it is also just a scenario — a convoy action for the scenario list.
 *
 * The ground force travels as `freight` (ten tons the lot, one armour unit of
 * fighting vehicles per lot — the campaign's conversion table). Freight is
 * *delivered* while it sits aboard a ship that is down on the target world:
 * land it and it is ashore, lift off again and it is not. There is no
 * planetary defence grid at the target — the campaign models the ground
 * defence with the garrison the landing force must then fight in Ogre, not
 * with the grid — and the fogged rules stay off, because the campaign's
 * orders are open.
 */

import { DEFAULT_MAP, type GameMap } from '@engine/map.js';
import { SHIP_CLASSES, type ShipClass, isEmplacement } from '@engine/ships.js';
import { createInitialState, makePlayer } from '@engine/state.js';
import {
  type GameState,
  type Player,
  type Ship,
  type VictoryState,
  activePlayer,
  controllerOf,
} from '@engine/types.js';
import { type OrderOfBattle, ORDER_KEY, orderOf } from '@campaign/orders.js';
import { deliveredLots } from '@campaign/result.js';
import {
  atAsteroidBase,
  baseSidesOf,
  buildBases,
  hold,
  inOrbit,
  landed,
  seedOf,
  victory,
} from './helpers.js';
import type { BuildOptions, ScenarioDef } from './types.js';

const TURN_LIMIT = 30;

/**
 * The printed default, for playing the scenario outside any campaign: four
 * lots of ground force under light escort, against a patrol of equal weight.
 */
export const DEFAULT_TRANSFER: OrderOfBattle = {
  battleId: 'transfer-default',
  seed: 0,
  scenarioId: 'contested-transfer',
  sides: [
    {
      player: 'combine',
      faction: 'North American Combine',
      forces: { transport: 2, corvette: 2, freight: 4 },
    },
    {
      player: 'paneuro',
      faction: 'Paneuropean Federation',
      forces: { corvette: 2, corsair: 1 },
    },
  ],
  terms: { origin: 'terra', target: 'mars', turnLimit: TURN_LIMIT, cargoLots: 4 },
};

/** The two factions keep the chart's blue-against-red convention. */
const colorFor = (faction: string): string => (/combine/i.test(faction) ? '#b83b3b' : '#3f7fd0');

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

interface Terms {
  readonly origin: string;
  readonly target: string;
  readonly turnLimit: number;
  readonly cargoLots: number;
}

const termsOf = (order: OrderOfBattle, map: GameMap): Terms => {
  const origin = order.terms['origin'];
  const target = order.terms['target'];
  if (typeof origin !== 'string' || !map.body(origin)) {
    throw new Error(`the order's origin "${String(origin)}" is not a body on the chart`);
  }
  if (typeof target !== 'string' || !map.body(target)) {
    throw new Error(`the order's target "${String(target)}" is not a body on the chart`);
  }
  const rawLimit = order.terms['turnLimit'];
  const freight = order.sides[0]?.forces['freight'] ?? 0;
  return {
    origin,
    target,
    turnLimit: typeof rawLimit === 'number' && rawLimit > 0 ? rawLimit : TURN_LIMIT,
    cargoLots: freight,
  };
};

/**
 * A side's hulls, hull by hull: class ids expanded and checked against the
 * ship table. An id the table does not know — or an emplacement, which
 * cannot sail — is a corrupt or mistyped order, and a battle silently
 * missing half a fleet is worse than no battle, so it throws.
 */
const hullsOf = (forces: Readonly<Record<string, number>>): ShipClass[] => {
  const out: ShipClass[] = [];
  for (const [id, count] of Object.entries(forces)) {
    if (id === 'freight' || count <= 0) continue;
    if (!(id in SHIP_CLASSES) || isEmplacement(id as ShipClass) || id === 'orbitalBase') {
      throw new Error(`the order asks for "${id}", which is not a hull that can sail in a convoy`);
    }
    for (let i = 0; i < count; i++) out.push(id as ShipClass);
  }
  // Largest hulls first, ties by name, so a fleet is the same fleet every build.
  return out.sort(
    (a, b) => SHIP_CLASSES[b].combatStrength - SHIP_CLASSES[a].combatStrength || a.localeCompare(b),
  );
};

/**
 * Load the freight: biggest holds first, each hull up to its lot capacity,
 * mirroring the campaign's own loading doctrine. A convoy that cannot lift
 * its cargo is refused here for the same reason an unknown hull is.
 */
const loadFreight = (hulls: readonly ShipClass[], lots: number): number[] => {
  const capacity = hulls.map((h) => {
    const c = SHIP_CLASSES[h].cargoCapacity;
    return Number.isFinite(c) ? Math.floor(c / 10) : Math.max(0, Math.floor(lots));
  });
  const loads = hulls.map(() => 0);
  const order = capacity.map((cap, i) => ({ cap, i })).sort((a, b) => b.cap - a.cap || a.i - b.i);
  let left = lots;
  for (const { cap, i } of order) {
    const take = Math.min(cap, left);
    loads[i] = take;
    left -= take;
  }
  if (left > 0) {
    throw new Error(`the convoy lifts ${lots - left} lots and the order ships ${lots}`);
  }
  return loads;
};

/**
 * Put a fleet on (or over) its home body: warships take up orbit, commercial
 * hulls sit on the ground at the base sites — and at an asteroid base, where
 * there is no hexside to land on, everything simply stops in the hex.
 */
const stationFleet = (
  map: GameMap,
  owner: string,
  hulls: readonly ShipClass[],
  loads: readonly number[],
  bodyId: string,
  firstNumber: number,
): Ship[] => {
  const sides = baseSidesOf(map, bodyId);
  const body = map.body(bodyId)!;
  const ships: Ship[] = [];
  let orbitDir = 0;

  hulls.forEach((shipClass, i) => {
    const opts = {
      id: `${owner}-${shipClass}-${i + 1}`,
      owner,
      shipClass,
      number: firstNumber + i,
      cargo: hold({ freight: loads[i] ?? 0 }),
    };
    if (sides.length === 0) {
      ships.push(atAsteroidBase(opts, body.hex));
    } else if (SHIP_CLASSES[shipClass].warship) {
      ships.push(inOrbit(opts, map, bodyId, sides[orbitDir++ % sides.length]!.dir));
    } else {
      ships.push(landed(opts, sides[i % sides.length]!));
    }
  });
  return ships;
};

const build = (opts: BuildOptions): GameState => {
  const map = DEFAULT_MAP;
  const order = opts.order ?? { ...DEFAULT_TRANSFER, seed: seedOf(opts) };
  const [convoy, patrol] = order.sides;
  if (!convoy || !patrol) throw new Error('a transfer needs a convoy and a patrol');
  const terms = termsOf(order, map);
  if (terms.cargoLots < 1)
    throw new Error('a transfer with no freight aboard has nothing to decide');

  const convoyHulls = hullsOf(convoy.forces);
  const patrolHulls = hullsOf(patrol.forces);
  const loads = loadFreight(convoyHulls, terms.cargoLots);

  const players: Player[] = [
    makePlayer(convoy.player, convoy.faction, convoy.faction, colorFor(convoy.faction)),
    makePlayer(patrol.player, patrol.faction, patrol.faction, colorFor(patrol.faction)),
  ];

  return createInitialState({
    scenarioId: 'contested-transfer',
    seed: order.seed,
    players,
    ships: [
      ...stationFleet(map, convoy.player, convoyHulls, loads, terms.origin, 1),
      ...stationFleet(
        map,
        patrol.player,
        patrolHulls,
        patrolHulls.map(() => 0),
        terms.target,
        101,
      ),
    ],
    bases: buildBases(map, {
      owners: { [terms.origin]: convoy.player, [terms.target]: patrol.player },
      defaultOwner: null,
      // The campaign models the target's ground defence with the garrison the
      // landing force must fight in Ogre, not with a defence grid.
      defences: 'none',
    }),
    options: opts.options ?? {},
    scenarioData: {
      [ORDER_KEY]: order,
      // The computer's briefing: fly the convoy to the target world and land.
      targets: { [convoy.player]: terms.target },
      turnLimit: terms.turnLimit,
    },
  });
};

// ---------------------------------------------------------------------------
// Scoring and victory
// ---------------------------------------------------------------------------

/**
 * Freight still in play but not yet ashore: aboard an undestroyed convoy
 * ship that is anywhere except down on the target. While any exists and the
 * clock has not run out, the battle is not over — the convoy may still get
 * it down, and the patrol may still stop it.
 */
const undeliveredInPlay = (state: GameState, map: GameMap, order: OrderOfBattle): boolean => {
  const convoy = order.sides[0]!.player;
  const target = order.terms['target'] as string;
  const ashore = deliveredLots(state, map, convoy, target);
  let aboard = 0;
  for (const ship of Object.values(state.ships)) {
    if (ship.destroyed || controllerOf(ship) !== convoy) continue;
    for (const item of ship.cargo) if (item.kind === 'freight') aboard += item.quantity;
  }
  return aboard - ashore > 0;
};

/** The scoreboard: the convoy's points are the lots it has ashore right now. */
const endPlayerTurn = (state: GameState, map: GameMap): GameState => {
  const order = orderOf(state.scenarioData);
  if (!order) return state;
  const convoy = order.sides[0]!.player;
  if (activePlayer(state) !== convoy) return state;
  const target = order.terms['target'];
  if (typeof target !== 'string') return state;
  const points = deliveredLots(state, map, convoy, target);
  const player = state.players[convoy];
  if (!player || player.points === points) return state;
  return { ...state, players: { ...state.players, [convoy]: { ...player, points } } };
};

const checkVictory = (state: GameState): VictoryState | null => {
  const map = DEFAULT_MAP;
  const order = orderOf(state.scenarioData);
  if (!order) return null;
  const convoy = order.sides[0]!.player;
  const patrol = order.sides[1]!.player;
  const target = order.terms['target'] as string;
  const targetName = map.body(target)?.name ?? target;
  const shipped = order.sides[0]!.forces['freight'] ?? 0;
  if (shipped <= 0) return null;

  const limit = state.scenarioData['turnLimit'];
  const outOfTime = typeof limit === 'number' && state.turn > limit;
  if (!outOfTime && undeliveredInPlay(state, map, order)) return null;

  // Every lot is now down, sunk, or out of time; the transfer is decided.
  const down = deliveredLots(state, map, convoy, target);
  if (down >= shipped) {
    return victory(
      [convoy],
      'decisive',
      `Every lot of the landing force is down on ${targetName}.`,
    );
  }
  if (down * 2 >= shipped) {
    return victory(
      [convoy],
      'marginal',
      `${down} of ${shipped} lots are down on ${targetName} — a beachhead worth the name.`,
    );
  }
  if (down > 0) {
    return victory(
      [patrol],
      'marginal',
      `Only ${down} of ${shipped} lots reached ${targetName}; the landing is broken up on the way in.`,
    );
  }
  return victory([patrol], 'decisive', `Nothing of the landing force reached ${targetName}.`);
};

// ---------------------------------------------------------------------------
// The scenario
// ---------------------------------------------------------------------------

export const contestedTransfer: ScenarioDef = {
  id: 'contested-transfer',
  name: 'Contested Transfer',
  blurb: 'A convoy with an invasion in its holds, against the fleet that knows it is coming.',
  description:
    'The campaign scenario, playable on its own: a convoy sails from Terra with a ground ' +
    'force in its holds, and the defending fleet comes out from the target world to meet ' +
    'it. When a campaign is running the hulls and the freight on both sides arrive in the ' +
    'order of battle; from the scenario list it uses the printed default — four lots of ' +
    'freight in two transports under corvette escort, against two corvettes and a corsair.\n\n' +
    'Freight counts only while it sits aboard a ship that is down on the target world. ' +
    'The convoy wins by getting at least half its lots ashore before the clock runs out; ' +
    'everything the patrol sinks, and everything still aboard when time expires, is lost. ' +
    'What lands becomes the landing force of an Ogre battle — see the campaign in the ' +
    'companion app.',
  players: { min: 2, max: 2 },
  length: 'medium',
  playerTemplates: [
    { faction: 'North American Combine', color: '#b83b3b', name: 'Convoy Commander' },
    { faction: 'Paneuropean Federation', color: '#3f7fd0', name: 'Patrol Commander' },
  ],
  build,
  checkVictory,
  endPlayerTurn,
  specialRules: [
    'The convoy moves first and carries the campaign’s ground force as freight, ten tons the lot. Freight is delivered while it is aboard a ship that is down on the target world — lift off again and it is not.',
    'Warships start in orbit over their home body; commercial hulls start on the ground at its bases. The target has no planetary defence grid: the campaign models the ground defence with the garrison the landing force must then fight.',
    `The transfer is decided when every lot is down, sunk, or out of time (${TURN_LIMIT} turns). All lots ashore is a decisive convoy win; half or more, marginal; less than half, the patrol has broken up the landing.`,
  ],
};
