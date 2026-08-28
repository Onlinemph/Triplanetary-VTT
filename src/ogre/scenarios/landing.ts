/**
 * **The Landing** — the campaign's ground battle, playable on its own.
 *
 * This is step 2 of docs/CAMPAIGN.md's build list: "A scenario in each engine
 * that builds from an `OrderOfBattle`." Where every other scenario prices its
 * own forces, this one is handed them: the campaign decides what got through
 * the blockade, and this scenario decides what it was worth on the ground.
 * Built with no order at all it plays a printed default, so it is also just a
 * scenario — which is the point; docs/CAMPAIGN.md calls a force-list build
 * "exactly what a point-buy screen needs".
 *
 * The fiction is a hot landing on a colonial installation. The invader is down
 * on the western strip — the drop zone the fleet could clear — and the
 * garrison holds the settled country east of it, with the installation's
 * command dome as far from the beachhead as the map allows. The invader moves
 * first and is on the clock: a landing that has not taken the dome inside the
 * turn limit has been contained, and containment is a defender's win.
 *
 * It follows the general scenario rules (1.06-1.09) and invents no machinery:
 * forces arrive through the same `place` helpers, victory is read from the
 * board, and everything the victory check needs rides in `scenarioData`, so a
 * replay of the command log knows its own terms.
 */

import { type Hex, toOffset } from '../engine/hex.js';
import { type GameMap, allHexes, terrainAt } from '../engine/map.js';
import { GEV_MAP } from '../engine/mapdata.js';
import { type OgreTypeId, OGRE_TYPES, ogreType } from '../engine/ogres.js';
import { createRng, shuffle } from '../engine/rng.js';
import {
  type UnitClassId,
  SELECTABLE_CLASSES,
  UNIT_CLASSES,
  isInfantryClass,
  unitClass,
} from '../engine/units.js';
import { type GameState, type VictoryState, onBoard, surviving } from '../engine/types.js';
import { createGame, log, makeOgre, makePlayer, withUnit } from '../engine/state.js';
import { type OrderOfBattle, ORDER_KEY, orderOf } from '@campaign/orders.js';
import type { ScenarioBuildOptions, ScenarioDef } from './types.js';
import { type Deployer, attackStrengthOf, infantryCounters, isFree, place } from './helpers.js';

const TURN_LIMIT = 15;

/**
 * The printed default, for playing the scenario outside any campaign: a
 * cybertank with an armoured escort against a garrison that outnumbers it.
 */
export const DEFAULT_LANDING: OrderOfBattle = {
  battleId: 'landing-default',
  seed: 0,
  scenarioId: 'landing',
  sides: [
    {
      player: 'invader',
      faction: 'Paneuropean Federation',
      forces: { MK3: 1, HVY: 3, GEV: 4, INF: 9 },
    },
    {
      player: 'garrison',
      faction: 'North American Combine',
      forces: { HVY: 4, MSL: 3, GEV: 3, HWZ: 2, INF: 18 },
    },
  ],
  terms: { turnLimit: TURN_LIMIT },
};

/** The two factions keep their colours from the other scenarios. */
const colorFor = (faction: string): string => (/combine/i.test(faction) ? '#d94f4f' : '#5b9bd5');

// ---------------------------------------------------------------------------
// Deployment
// ---------------------------------------------------------------------------

/** Ground a counter may stand on at setup. */
const open = (map: GameMap, h: Hex): boolean => {
  const t = terrainAt(map, h);
  return t !== 'crater' && t !== 'water';
};

/** The drop zone: the western strip the fleet could sweep before the landing. */
const dropZone = (map: GameMap): Hex[] =>
  allHexes(map).filter(
    (h) => toOffset(h).col <= Math.max(2, Math.round(map.cols / 5)) && open(map, h),
  );

/** The garrison's ground: the eastern two thirds, same line The Crossing draws. */
const defenceGround = (map: GameMap): Hex[] =>
  allHexes(map).filter((h) => toOffset(h).col >= Math.round(map.cols / 3) && open(map, h));

/**
 * Expand one side's `forces` into counters on the board.
 *
 * The vocabulary is the engine's own: `OgreTypeId` keys land cybertanks,
 * infantry classes land squads (split into 3/2/1 counters the way the counter
 * mix splits, 3.02), and everything else must be a class a scenario may hand a
 * player — `SELECTABLE_CLASSES`, which is where "Crawlers cannot be chosen in
 * the initial setup" already lives. An id outside all three is a corrupt or
 * mistyped order, and a battle silently missing half a force is worse than no
 * battle, so it throws.
 */
const deployForces = (
  d: Deployer,
  owner: string,
  forces: Readonly<Record<string, number>>,
  hexes: Hex[],
): void => {
  for (const [id, count] of Object.entries(forces)) {
    if (count <= 0) continue;
    if (id in OGRE_TYPES) {
      for (let i = 0; i < count; i++) {
        while (hexes.length > 0 && !isFree(d.state, hexes[0]!)) hexes.shift();
        const at = hexes.shift();
        if (!at) throw new Error('the drop zone is out of ground');
        d.state = withUnit(
          d.state,
          makeOgre(`${owner}-${id.toLowerCase()}-${d.serial++}`, owner, id as OgreTypeId, at),
        );
      }
    } else if (!(id in UNIT_CLASSES)) {
      throw new Error(`the order asks for "${id}", which is not a unit this game fields`);
    } else if (isInfantryClass(id as UnitClassId)) {
      for (const squads of infantryCounters(count)) {
        place(d, owner, id as UnitClassId, hexes, squads);
      }
    } else if (SELECTABLE_CLASSES.includes(id as UnitClassId)) {
      for (let i = 0; i < count; i++) place(d, owner, id as UnitClassId, hexes);
    } else {
      throw new Error(`the order asks for "${id}", which is not a unit this game fields`);
    }
  }
};

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

const build = (map: GameMap, opts: ScenarioBuildOptions): GameState => {
  const order = opts.order ?? { ...DEFAULT_LANDING, seed: opts.seed };
  const [invader, garrison] = order.sides;
  if (!invader || !garrison) throw new Error('a landing needs an invader and a garrison');

  const rawLimit = order.terms['turnLimit'];
  const turnLimit = typeof rawLimit === 'number' && rawLimit > 0 ? rawLimit : TURN_LIMIT;

  const base = createGame({
    scenarioId: 'landing',
    mapId: map.id,
    // The order's seed, always: the result's replay names it, so the game the
    // log replays must be the game that was played. With no order given the
    // default order was just built from `opts.seed`, and the two agree.
    seed: order.seed,
    // The invader is sides[0] and moves first — the campaign's convention, and
    // also the rulebook's shape: the attacker crosses the line of departure.
    players: [
      makePlayer(invader.player, invader.faction, invader.faction, colorFor(invader.faction)),
      makePlayer(garrison.player, garrison.faction, garrison.faction, colorFor(garrison.faction)),
    ],
    options: {
      // Settled country plays by the green-map rules: real stacking (5.02.2)
      // and overrun combat rather than ramming — one or the other, never both
      // (6.00).
      stackingLimit: 5,
      overrunCombat: true,
      ...opts.options,
    },
    scenarioData: { [ORDER_KEY]: order, turnLimit },
  });

  let rng = createRng(order.seed ^ 0x1a4d);
  const d: Deployer = { state: base, serial: 1 };

  // The invader comes down on the western strip.
  const lz = shuffle(rng, dropZone(map));
  rng = lz.state;
  deployForces(d, invader.player, invader.forces, lz.items);

  // The garrison holds the east, and the command dome sits as far from the
  // beachhead as the map allows — the farther east it is, the safer it is.
  const ground = shuffle(rng, defenceGround(map));
  rng = ground.state;
  const domeSites = [...ground.items].sort((a, b) => toOffset(b).col - toOffset(a).col);
  place(d, garrison.player, 'CP', domeSites);
  deployForces(d, garrison.player, garrison.forces, ground.items);

  // What the victory check compares half-strength against.
  d.state = {
    ...d.state,
    scenarioData: {
      ...d.state.scenarioData,
      garrisonStartStrength: attackStrengthOf(d.state, garrison.player),
    },
  };

  return log(
    d.state,
    'info',
    `The landing force is down on the western strip. It has ${turnLimit} turns to take ` +
      `the command dome; after that the beachhead is contained.`,
  );
};

// ---------------------------------------------------------------------------
// Victory
// ---------------------------------------------------------------------------

/**
 * Everything here is read from the state rather than a closure, because the
 * scenario table holds one `ScenarioDef` while every campaign battle builds a
 * different game: the order in `scenarioData` is the only copy of the terms
 * this check can trust.
 */
const checkVictory = (state: GameState): VictoryState | null => {
  const order = orderOf(state.scenarioData);
  if (!order) return null;
  const invader = order.sides[0]!.player;
  const garrison = order.sides[1]!.player;

  const units = Object.values(state.units);
  const invaderLeft = units.some((u) => u.owner === invader && onBoard(u));
  const garrisonLeft = units.some((u) => u.owner === garrison && onBoard(u));
  const dome = units.find((u) => u.kind === 'unit' && u.owner === garrison && u.classId === 'CP');
  const domeStands = !!dome && surviving(dome);

  if (!garrisonLeft) {
    return invaderLeft
      ? {
          winners: [invader],
          level: 'complete',
          reason: 'Nothing is left of the garrison. The colony is taken whole.',
        }
      : {
          winners: [invader],
          level: 'marginal',
          reason: 'Both forces are spent, but the garrison went first. A ruin changes hands.',
        };
  }

  if (!domeStands) {
    return invaderLeft
      ? {
          winners: [invader],
          level: 'standard',
          reason: 'The command dome is down and the beachhead holds. The colony falls.',
        }
      : {
          winners: [invader],
          level: 'marginal',
          reason: 'The command dome is down, but the landing force died taking it.',
        };
  }

  if (!invaderLeft) {
    const start = state.scenarioData['garrisonStartStrength'];
    const strength = attackStrengthOf(state, garrison);
    const strong = typeof start === 'number' && start > 0 && strength * 2 >= start;
    return {
      winners: [garrison],
      level: strong ? 'complete' : 'standard',
      reason: strong
        ? `The beachhead is wiped out and ${strength} points of attack strength still hold the line.`
        : 'The beachhead is wiped out. The colony holds.',
    };
  }

  const limit = state.scenarioData['turnLimit'];
  if (typeof limit === 'number' && state.turn > limit) {
    return {
      winners: [garrison],
      level: 'marginal',
      reason: `The landing is contained: ${limit} turns gone and the command dome stands.`,
    };
  }

  return null;
};

// ---------------------------------------------------------------------------
// The scenario
// ---------------------------------------------------------------------------

const defaultInvader = DEFAULT_LANDING.sides[0]!;
const defaultGarrison = DEFAULT_LANDING.sides[1]!;

const describeForce = (forces: Readonly<Record<string, number>>): string =>
  Object.entries(forces)
    .map(([id, n]) => {
      if (id in OGRE_TYPES)
        return n === 1
          ? ogreType(id as OgreTypeId).name
          : `${n} ${ogreType(id as OgreTypeId).name}s`;
      const cls = unitClass(id as UnitClassId);
      return cls.kind === 'infantry' ? `${n} squads` : `${n} ${cls.name}${n === 1 ? '' : 's'}`;
    })
    .join(', ');

export const LANDING: ScenarioDef = {
  id: 'landing',
  name: 'The Landing',
  mapId: GEV_MAP.id,
  players: 2,
  map: GEV_MAP,
  blurb: 'A landing force from orbit against the garrison of a colonial installation.',
  briefing:
    'The campaign scenario, playable on its own: what came down the gravity well against ' +
    'what was dug in waiting for it. When a campaign is running, the forces on both sides ' +
    'arrive in the order of battle — what survived the convoy action is what stands on the ' +
    'western strip. Played from the scenario list it uses the printed default below.\n\n' +
    `The invader (${describeForce(defaultInvader.forces)}) is down on the western strip and ` +
    `moves first. The garrison (${describeForce(defaultGarrison.forces)}) holds the eastern ` +
    'two thirds, and the installation’s command dome sits as far from the beachhead as the ' +
    `map allows.\n\n` +
    `The clock favours the defence: a landing that has not taken the dome inside ` +
    `${TURN_LIMIT} turns has been contained.\n\n` +
    'This scenario uses overrun combat and green-map stacking, like The Crossing.',
  victoryConditions: [
    'Garrison destroyed to the last unit: complete invader victory.',
    'Command dome destroyed, landing force still in the field: invader victory.',
    'Command dome destroyed, landing force also destroyed: marginal invader victory.',
    'Landing force destroyed with half the garrison’s strength still standing: complete garrison victory.',
    'Landing force destroyed: garrison victory.',
    `Command dome still standing after ${TURN_LIMIT} turns: marginal garrison victory.`,
  ],
  build: (opts) => build(GEV_MAP, opts),
  checkVictory,
};
