/**
 * **The Train** — an original scenario, not one of the published ones.
 *
 * Section 9 puts a train on the rails and says how it moves; it does not say
 * where. This scenario gives it somewhere to go: across the green map from the
 * west end of the line to the east, with six squads aboard and an escort
 * alongside, through country where raiders have had time to set up.
 *
 * It follows the general scenario rules (1.06-1.09) — a unit allowance a side,
 * a turn limit, a verdict — and adds nothing to the engine. The train is the
 * whole game: it wins by leaving, it loses by dying, and everything else on
 * the board is there to make one of those happen.
 */

import { type Hex, toOffset } from '../engine/hex.js';
import { type GameMap, allHexes, hasRoute, terrainAt } from '../engine/map.js';
import { GEV_MAP } from '../engine/mapdata.js';
import { createRng, shuffle } from '../engine/rng.js';
import { type UnitClassId, unitClass } from '../engine/units.js';
import {
  type ConventionalUnit,
  type GameState,
  type PlayerId,
  type Unit,
  type VictoryState,
  isOgre,
  onBoard,
} from '../engine/types.js';
import { createGame, log, makePlayer, makeUnit, withUnit } from '../engine/state.js';
import type { ScenarioBuildOptions, ScenarioDef } from './types.js';
import {
  type Deployer,
  buyArmor,
  infantryCounters,
  isFree,
  place,
  withSetup,
  zone,
} from './helpers.js';

export const ESCORT_PLAYER: PlayerId = 'escort';
export const RAIDER_PLAYER: PlayerId = 'raiders';

/** The escort, hand-picked: fast enough to keep up with a train. */
const ESCORT: readonly UnitClassId[] = [
  'GEV',
  'GEV',
  'GEV',
  'GEV',
  'LGEV',
  'LGEV',
  'HVY',
  'HVY',
  'MSL',
  'MSL',
  'LT',
  'LT',
];
/** Squads riding the train (its capacity, 3.03 by analogy). */
const ABOARD = 6;
/** The raiders: an armour allowance in the usual mix, plus infantry dug in ahead. */
const RAIDER_ARMOR = 12;
const RAIDER_SQUADS = 12;
/** Two turns of slack over a clean run at full speed. */
const TURN_LIMIT = 12;
/** The train is already rolling when the game opens. */
const OPENING_SPEED = 2;

/** The rail hexes, west to east. */
export const railLine = (map: GameMap): Hex[] =>
  allHexes(map)
    .filter((h) => hasRoute(map, h, 'rail'))
    .sort((a, b) => toOffset(a).col - toOffset(b).col || toOffset(a).row - toOffset(b).row);

const ground = (map: GameMap, h: Hex): boolean => {
  const t = terrainAt(map, h);
  return t !== 'crater' && t !== 'water';
};

/** What a side's counters are worth in armour units, for the verdict. */
const armourValue = (units: readonly Unit[]): number =>
  units.reduce((n, u) => {
    if (isOgre(u)) return n;
    const cls = unitClass(u.classId);
    if (cls.id === 'TRAIN') return n;
    return n + (cls.kind === 'infantry' ? cls.armorUnits * u.squads : cls.armorUnits);
  }, 0);

const build = (map: GameMap, opts: ScenarioBuildOptions): GameState => {
  const line = railLine(map);
  const westEnd = line[0];
  if (!westEnd) throw new Error('the train needs a map with a railway on it');

  const base = createGame({
    scenarioId: 'train',
    mapId: map.id,
    seed: opts.seed,
    players: [
      makePlayer(ESCORT_PLAYER, 'Escort', 'Paneuropean Federation', '#5b9bd5'),
      makePlayer(RAIDER_PLAYER, 'Raiders', 'North American Combine', '#d94f4f'),
    ],
    options: {
      // The green map: real stacking and overrun combat, as in The Crossing.
      stackingLimit: 5,
      overrunCombat: true,
      ...opts.options,
    },
    scenarioData: { turnLimit: TURN_LIMIT },
  });

  let rng = createRng(opts.seed ^ 0x7ae1);
  const d: Deployer = { state: base, serial: 1 };

  // The train, at the west end of the line, with the infantry aboard.
  const trainId = `${ESCORT_PLAYER}-train`;
  const train: ConventionalUnit = {
    ...makeUnit(trainId, ESCORT_PLAYER, 'TRAIN', westEnd),
    trainSpeed: OPENING_SPEED,
  };
  d.state = withUnit(d.state, train);
  for (const squads of infantryCounters(ABOARD)) {
    const rider: ConventionalUnit = {
      ...makeUnit(`${ESCORT_PLAYER}-inf-${d.serial++}`, ESCORT_PLAYER, 'INF', westEnd, squads),
      ridingOn: trainId,
    };
    d.state = withUnit(d.state, rider);
  }

  // The escort forms up around the train, in the western quarter.
  const westQuarter = allHexes(map).filter(
    (h) => toOffset(h).col <= Math.max(2, Math.round(map.cols / 4)) && ground(map, h),
  );
  const nearTrain = [...westQuarter].sort((a, b) => {
    const da = Math.abs(toOffset(a).row - toOffset(westEnd).row) + toOffset(a).col;
    const db = Math.abs(toOffset(b).row - toOffset(westEnd).row) + toOffset(b).col;
    return da - db;
  });
  const escortHexes = nearTrain.filter((h) => isFree(d.state, h));
  for (const cls of ESCORT) place(d, ESCORT_PLAYER, cls, escortHexes);

  // The raiders have had time: anywhere in the eastern half.
  const eastHalf = allHexes(map).filter(
    (h) => toOffset(h).col >= Math.round(map.cols / 2) && ground(map, h),
  );
  const order = shuffle(rng, eastHalf);
  rng = order.state;
  const raiderHexes = order.items.filter((h) => isFree(d.state, h));
  const buy = buyArmor(rng, RAIDER_ARMOR);
  rng = buy.rng;
  for (const cls of buy.units) place(d, RAIDER_PLAYER, cls, raiderHexes);
  for (const squads of infantryCounters(RAIDER_SQUADS)) {
    place(d, RAIDER_PLAYER, 'INF', raiderHexes, squads);
  }

  const escortWorth = armourValue(
    Object.values(d.state.units).filter((u) => u.owner === ESCORT_PLAYER),
  );
  const raiderWorth = armourValue(
    Object.values(d.state.units).filter((u) => u.owner === RAIDER_PLAYER),
  );

  const built = log(
    {
      ...d.state,
      scenarioData: {
        ...d.state.scenarioData,
        // The computer reads these: who is leaving, by which edge, and which
        // counter it is that has to get there.
        exitEdge: 'east',
        exitSide: ESCORT_PLAYER,
        exitUnits: [trainId],
        escortValue: escortWorth,
        raiderValue: raiderWorth,
      },
    },
    'info',
    `The train comes on at the west end of the line with ${ABOARD} squads aboard. It has ${TURN_LIMIT} turns to leave by the east edge.`,
    [westEnd],
  );
  return withSetup(built, opts.setup, [RAIDER_PLAYER, ESCORT_PLAYER], {
    [RAIDER_PLAYER]: zone(eastHalf, 'the eastern half'),
    [ESCORT_PLAYER]: zone(westQuarter, 'the western quarter'),
  });
};

const checkVictory = (state: GameState): VictoryState | null => {
  const train = Object.values(state.units).find(
    (u) => u.kind === 'unit' && u.classId === 'TRAIN' && u.owner === ESCORT_PLAYER,
  );
  if (!train) return null;
  const units = Object.values(state.units);
  const escortLeft = armourValue(units.filter((u) => u.owner === ESCORT_PLAYER && !u.destroyed));
  const raidersLeft = armourValue(units.filter((u) => u.owner === RAIDER_PLAYER && !u.destroyed));
  const escortWorth = (state.scenarioData['escortValue'] as number | undefined) ?? escortLeft;
  const raiderWorth = (state.scenarioData['raiderValue'] as number | undefined) ?? raidersLeft;

  if (!train.destroyed && train.offMap === 'east') {
    const kept = escortWorth > 0 ? escortLeft / escortWorth : 1;
    return {
      winners: [ESCORT_PLAYER],
      level: kept >= 0.5 ? 'complete' : 'standard',
      reason:
        kept >= 0.5
          ? 'The train is through and away east, and most of its escort with it.'
          : 'The train is through and away east. The escort paid for it.',
    };
  }
  if (train.destroyed) {
    const kept = raiderWorth > 0 ? raidersLeft / raiderWorth : 1;
    return {
      winners: [RAIDER_PLAYER],
      level: kept >= 0.5 ? 'complete' : 'standard',
      reason:
        kept >= 0.5
          ? 'The train is a wreck on the line.'
          : 'The train is a wreck on the line, and half the raiders with it.',
    };
  }
  const limit = (state.scenarioData['turnLimit'] as number | undefined) ?? TURN_LIMIT;
  if (state.turn > limit) {
    return {
      winners: [RAIDER_PLAYER],
      level: 'standard',
      reason: `The train never cleared the line inside ${limit} turns.`,
    };
  }
  if (!units.some((u) => u.owner === RAIDER_PLAYER && onBoard(u))) {
    return {
      winners: [ESCORT_PLAYER],
      level: 'complete',
      reason: 'Nothing is left of the raiders; the line is open.',
    };
  }
  return null;
};

export const TRAIN: ScenarioDef = {
  id: 'train',
  name: 'The Train',
  mapId: GEV_MAP.id,
  players: 2,
  map: GEV_MAP,
  blurb:
    'A train must cross the green map along the line, through country the raiders got to first.',
  briefing:
    'An original scenario for Section 9, which puts a train on the rails and says how it ' +
    'moves but not where.\n\n' +
    `The train comes on at the west end of the line with ${ABOARD} squads of infantry aboard ` +
    `and an escort of ${ESCORT.length} counters formed up around it in the western quarter. ` +
    `The raiders have ${RAIDER_ARMOR} armour units and ${RAIDER_SQUADS} squads set up anywhere ` +
    'in the eastern half. The train wins by leaving the map at the east end of the line ' +
    `inside ${TURN_LIMIT} turns.\n\n` +
    'The train moves only along the rails, at its speed marker, and the marker changes by one ' +
    'step a turn before it moves — so a driver who sees trouble ahead has as many turns to ' +
    'brake as the marker has steps. It cannot enter a hex the enemy holds: a counter parked on ' +
    'the line stops it dead until the escort clears the way. A "D" result does nothing to it; ' +
    'only an "X" derails it. Ramming it is resolved on the Size Table’s train column, which ' +
    'is kind to cybertanks and unkind to everything else.\n\n' +
    'This scenario uses overrun combat rather than ramming, and the green map’s stacking.',
  victoryConditions: [
    'The train leaves by the east edge: escort victory — complete if half the escort’s value survives.',
    'The train destroyed: raider victory — complete if half the raiders’ value survives.',
    `The train still on the map after ${TURN_LIMIT} turns: raider victory.`,
    'All raiding units destroyed: escort victory.',
  ],
  build: (opts) => build(GEV_MAP, opts),
  checkVictory,
};
