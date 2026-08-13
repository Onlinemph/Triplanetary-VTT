/**
 * Prospecting — "A long multi-player scenario".
 *
 * Rulebook p. 13:
 *
 *   "In the farthest reaches of the Solar System, the asteroid belt is the new
 *    frontier... the source of untold riches and untold dangers.
 *
 *    Ships: Each player begins the scenario with MCr 25. With that, ships and
 *    equipment must be purchased (only freighters and packets are available; all
 *    new ships start with a full fuel load). New ships and equipment may be
 *    purchased on any world as soon as a player accumulates enough money.
 *
 *    Prospecting: Any ship may prospect by passing through an asteroid hex at a
 *    speed of 1. Two dice are rolled. On the first roll, a 6 indicates that ore
 *    is present... On the second roll, a 1 indicates the ship has encountered a
 *    CT (contraterrene) shard...
 *
 *    Ore may be sold at Ceres (MCr 2 per ton) or at Luna (MCr 3 per ton). CT
 *    shards sell for MCr 100 at Ceres or MCr 200 at Luna.
 *
 *    Fuel: MCr .5 per point of fuel, available at any friendly base.
 *
 *    Mining: A stationary ship on an ore hex may mine ore at .1 ton per turn...
 *
 *    Victory: Decide on a game length (perhaps 120 days) before the game. The
 *    miner with the most money wins, counting all property at full purchase value
 *    and unsold ore at MCr 2 per ton."
 */

import { FUEL_PRICE, MARKETS, logisticsData } from '@engine/logistics.js';
import { DEFAULT_MAP } from '@engine/map.js';
import { CARGO } from '@engine/ships.js';
import { createInitialState } from '@engine/state.js';
import type { GameState, PlayerId, Ship, VictoryState } from '@engine/types.js';
import {
  type PlayerSpec,
  ORE_VALUATION,
  atAsteroidBase,
  buildBases,
  buildPlayers,
  hold,
  netWorth,
  seatCount,
  seedOf,
  templatesOf,
  victory,
} from './helpers.js';
import type { BuildOptions, ScenarioDef } from './types.js';

/** "Each player begins the scenario with MCr 25." */
export const STARTING_CREDITS = 25;

/** "Decide on a game length (perhaps 120 days) before the game." */
export const DEFAULT_GAME_LENGTH = 120;

/** "only freighters and packets are available". */
const PURCHASABLE = ['transport', 'packet'] as const;

const PALETTE = ['#4fae7a', '#d1795a', '#5b9bd5', '#c9a227', '#9b6bd0', '#c04f7a'];

const specFor = (index: number): PlayerSpec => ({
  id: `prospector${index + 1}`,
  faction: 'Prospectors',
  color: PALETTE[index] ?? '#9c9384',
  name: `Prospector ${index + 1}`,
  // The starting outfit below spends MCr 15 of the MCr 25 allowance.
  megacredits: STARTING_CREDITS - 15,
});

const MAX_PLAYERS = PALETTE.length;
const ALL_SPECS: readonly PlayerSpec[] = PALETTE.map((_, i) => specFor(i));

const build = (opts: BuildOptions): GameState => {
  const map = DEFAULT_MAP;
  const ceres = map.body('ceres')!;
  const count = seatCount(opts, 2, MAX_PLAYERS, 3);
  const specs = ALL_SPECS.slice(0, count);

  // A legal opening spend of the MCr 25 allowance: one transport (MCr 10, "all
  // new ships start with a full fuel load") and one automated mine (MCr 5), which
  // leaves MCr 10 in hand for fuel at MCr 0.5 a point.
  const ships: Ship[] = specs.map((spec, i) =>
    atAsteroidBase(
      {
        id: `${spec.id}-transport`,
        owner: spec.id,
        shipClass: 'transport',
        number: i + 1,
        name: `${spec.name}'s freighter`,
        cargo: hold({ automatedMine: 1 }),
      },
      // Ceres is the frontier town: an asteroid base in the Belt that buys ore.
      ceres.hex,
    ),
  );

  return createInitialState({
    scenarioId: 'prospecting',
    seed: seedOf(opts),
    players: buildPlayers(specs, opts),
    ships,
    // "There is no law in the Belt": every base is a port of convenience, and
    // "New ships and equipment may be purchased on any world."
    bases: buildBases(map),
    options: opts.options ?? {},
    scenarioData: {
      // Turns on the prospecting rolls in the resupply phase.
      prospecting: true,
      purchasableClasses: [...PURCHASABLE],
      prospectingScenario: {
        startingCredits: STARTING_CREDITS,
        startingOutfit: { transport: 1, automatedMine: 1, cashLeft: STARTING_CREDITS - 15 },
        gameLengthTurns: DEFAULT_GAME_LENGTH,
        fuelPrice: FUEL_PRICE,
        markets: MARKETS,
        equipment: {
          pmGrapples: CARGO.pmGrapples.cost,
          automatedMine: CARGO.automatedMine.cost,
          robotGuards: CARGO.robotGuards.cost,
          scanners: CARGO.scanners.cost,
        },
        variants: [
          'Clandestine is available as a base, and buys ore at Ceres prices. The blue asteroids are treated as normal asteroids.',
          'Clandestine is available as a base, but only to ships which have purchased scanners. It buys ore at Ceres prices.',
        ],
      },
    },
  });
};

/**
 * "counting all property at full purchase value and unsold ore at MCr 2 per ton"
 * — hulls and holds, plus everything left out in the Belt: emplaced automated
 * mines, robot guards, ore stockpiled at a mine and shards set aside for later.
 */
export const prospectorWorth = (state: GameState, player: PlayerId): number => {
  let total = netWorth(state, player);
  const data = logisticsData(state);

  for (const [, site] of Object.entries(data.mines)) {
    if (site.owner !== player) continue;
    total += CARGO.automatedMine.cost ?? 0;
    total += site.stockpile * ORE_VALUATION;
  }
  for (const [, owner] of Object.entries(data.guards)) {
    if (owner === player) total += CARGO.robotGuards.cost ?? 0;
  }
  return Math.round(total * 100) / 100;
};

const checkVictory = (state: GameState): VictoryState | null => {
  const config = (state.scenarioData['prospectingScenario'] ?? {}) as {
    gameLengthTurns?: number;
  };
  const length = config.gameLengthTurns ?? DEFAULT_GAME_LENGTH;
  if (state.turn <= length) return null;

  const scores = state.playerOrder.map((id) => ({ id, worth: prospectorWorth(state, id) }));
  const best = Math.max(...scores.map((s) => s.worth));
  const winners = scores.filter((s) => s.worth === best).map((s) => s.id);
  return victory(
    winners,
    winners.length === 1 ? 'decisive' : 'marginal',
    `Day ${length} closes the claim office. Best net worth: MCr ${best}.`,
  );
};

export const prospecting: ScenarioDef = {
  id: 'prospecting',
  name: 'Prospecting',
  blurb: 'MCr 25 and a freighter. Dig the Belt, dodge the antimatter, get rich.',
  description:
    'In the farthest reaches of the Solar System, the asteroid belt is the new ' +
    'frontier — the source of untold riches and untold dangers. Each player begins ' +
    'with MCr 25, buys freighters and packets, and prospects asteroid hexes by ' +
    'crawling through them at one hex per turn. Ore sells at Ceres for MCr 2 a ton ' +
    'and at Luna for MCr 3; a contraterrene shard is worth MCr 100 or 200 — if you ' +
    'have the pseudo-magnetic grapples to carry it and not the crater it leaves ' +
    'if you do not.',
  players: { min: 2, max: MAX_PLAYERS },
  length: 'long',
  playerTemplates: templatesOf(ALL_SPECS),
  build,
  checkVictory,
  specialRules: [
    'Only freighters (transports) and packets are available. All new ships start with a full fuel load, and may be bought on any world as soon as a player accumulates the money.',
    'Any ship may prospect by passing through an asteroid hex at a speed of 1. Two dice are rolled: a 6 on the first means ore is present; a 1 on the second means a contraterrene shard. With PM grapples the shard may be picked up or left for later; without them it explodes and the ship suffers an attack as per asteroids. Each hex may only be prospected once, but any amount of ore may be recovered from a hex that has ore.',
    'Ore sells at Ceres for MCr 2 per ton and at Luna for MCr 3. CT shards sell for MCr 100 at Ceres or MCr 200 at Luna.',
    'Fuel costs MCr 0.5 per point, available at any friendly base.',
    'A stationary ship on an ore hex mines 0.1 ton per turn, in the movement phase instead of moving. Automated mines (MCr 5) extract 1 ton per turn; only one may be placed per asteroid hex, and placement requires the ship to stand still for a turn. Robot guards (MCr 50) protect mines and ore, defending at combat value 2 but never initiating combat.',
    'Players may raid each others’ mines, and even engage in combat, if they wish. There is no law in the Belt.',
    'Victory: decide on a game length — perhaps 120 days — before the game. The miner with the most money wins, counting all property at full purchase value and unsold ore at MCr 2 per ton.',
    'Variant: Clandestine is available as a base and buys ore at Ceres prices, with the blue asteroids treated as normal asteroids — or, harder, available only to ships which have purchased scanners.',
  ],
};
