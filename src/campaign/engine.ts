/**
 * The campaign engine — "a third pure engine that owns neither battle"
 * (docs/CAMPAIGN.md).
 *
 * It holds a map of objectives, two sides' pools and treasuries, and a log of
 * its own; a battle is something it *launches* and then reads a result from.
 * Like the two battle engines it is a pure function of (state, command): no
 * DOM, no clock, no `Math.random` — the seed for every battle it launches
 * comes off the campaign's own generator, so a campaign is its seed plus its
 * command log, and every battle in it can be replayed years later from the
 * `{seed, log}` its result carries.
 *
 * ## A campaign turn
 *
 * docs/CAMPAIGN.md's four steps, as commands:
 *
 *  1. **Strategic.** Both sides spend production — `buyShips`, `buyGround`,
 *     `garrison` — and either may commit to one offensive: `launchOffensive`.
 *  2. **Space.** If the defender `intercept`s, the transfer is contested and
 *     the campaign hands out a Triplanetary `OrderOfBattle`; a `stand` lets
 *     the convoy through. Routine logistics between friendly ports is below
 *     the campaign's resolution — only *contested* transfers are fought,
 *     which is the doc's own phrase.
 *  3. **Ground.** Whatever tonnage got down becomes an Ogre order of battle
 *     against the site's garrison, through the conversion table in
 *     `convert.ts`. An unopposed landing against an empty site simply takes
 *     it — a battle with nobody on the other side is not a battle.
 *  4. **Consolidation.** `endTurn` pays each side its held production and
 *     checks the victory line.
 *
 * Battles resolve *outside* this engine — in this app for the space half, at
 * this keyboard or across an online table, and in OGRE-VTT for the ground
 * half — and come back through `reportBattle` as a `BattleResult`. The engine
 * cannot verify a result's die rolls (that is what the replay in the result
 * is for); it does verify that the result answers the battle it asked for.
 */

import type { CommandResult } from '@engine/commands.js';
import { type RngState, createRng, nextFloat } from '@engine/rng.js';
import type { BattleResult, OrderOfBattle } from './orders.js';
import {
  type CampaignSideId,
  CAMPAIGN_SIDES,
  OPENING_FLEET,
  OPENING_GROUND,
  OPENING_HOLDS,
  OPENING_PRODUCTION,
  SITES,
  VICTORY_PRODUCTION,
  groundEntry,
  shipEntry,
  siteDef,
} from './data.js';
import {
  type Force,
  armourUnitsOf,
  describeForce,
  forceIsEmpty,
  lotsOf,
  splitByLots,
} from './convert.js';

/** The engine's own result shape, minted locally: rejections carry a reason. */
const ok = (): CommandResult => ({ ok: true });
const fail = (reason: string): CommandResult => ({ ok: false, reason });

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface CampaignSideState {
  /** Production points banked and not yet spent. */
  readonly production: number;
  /** Hulls in the home yards, by Triplanetary ship class. */
  readonly fleet: Force;
  /** Ground forces awaiting shipping, in The Landing's vocabulary. */
  readonly ground: Force;
}

export interface SiteState {
  readonly id: string;
  readonly holder: CampaignSideId | null;
  readonly garrison: Force;
}

export type PendingStage = 'intercept' | 'space' | 'ground';

/**
 * The one operation in flight. One at a time, deliberately: a battle is
 * fought outside the campaign and reported back, and a queue of half-resolved
 * battles is a bookkeeping game nobody asked to play.
 */
export interface PendingOperation {
  readonly attacker: CampaignSideId;
  readonly site: string;
  readonly stage: PendingStage;
  /** The convoy and escort committed at launch. */
  readonly fleet: Force;
  /** The ground force aboard it. */
  readonly cargo: Force;
  /** The defending fleet, once committed. */
  readonly defenderFleet: Force | null;
  /** The order the current stage is fighting; null while awaiting interception. */
  readonly order: OrderOfBattle | null;
  /** What actually got ashore, once the space stage has resolved. */
  readonly landed: Force | null;
}

export interface CampaignLogEntry {
  readonly turn: number;
  readonly severity: 'info' | 'good' | 'warn' | 'bad';
  readonly text: string;
}

export interface BattleRecord {
  readonly battleId: string;
  readonly kind: 'space' | 'ground';
  readonly site: string;
  readonly attacker: CampaignSideId;
  readonly result: BattleResult;
}

export interface CampaignVictory {
  readonly winner: CampaignSideId;
  readonly level: 'complete' | 'standard';
  readonly reason: string;
}

export interface CampaignState {
  readonly turn: number;
  readonly rng: RngState;
  readonly sides: Readonly<Record<CampaignSideId, CampaignSideState>>;
  readonly sites: Readonly<Record<string, SiteState>>;
  readonly pending: PendingOperation | null;
  /** One offensive per side per turn — a transfer window, not a floodgate. */
  readonly launched: Readonly<Record<CampaignSideId, boolean>>;
  readonly battleSerial: number;
  /** Every battle fought, with its result — each result carries its replay. */
  readonly battles: readonly BattleRecord[];
  readonly log: readonly CampaignLogEntry[];
  readonly victory: CampaignVictory | null;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export type CampaignCommand =
  | {
      readonly type: 'buyShips';
      readonly by: CampaignSideId;
      readonly ship: string;
      readonly count: number;
    }
  | {
      readonly type: 'buyGround';
      readonly by: CampaignSideId;
      readonly unit: string;
      readonly count: number;
    }
  | {
      readonly type: 'garrison';
      readonly by: CampaignSideId;
      readonly site: string;
      readonly unit: string;
      readonly count: number;
    }
  | {
      readonly type: 'launchOffensive';
      readonly by: CampaignSideId;
      readonly site: string;
      readonly fleet: Force;
      readonly cargo: Force;
    }
  | { readonly type: 'intercept'; readonly by: CampaignSideId; readonly fleet: Force }
  | { readonly type: 'stand'; readonly by: CampaignSideId }
  | { readonly type: 'reportBattle'; readonly result: BattleResult }
  | { readonly type: 'endTurn' };

export interface CampaignApplyResult {
  readonly state: CampaignState;
  readonly result: CommandResult;
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

export const createCampaign = (seed: number): CampaignState => {
  const sites: Record<string, SiteState> = {};
  for (const site of SITES) {
    const opening = OPENING_HOLDS[site.id];
    sites[site.id] = {
      id: site.id,
      holder: opening?.holder ?? null,
      garrison: opening?.garrison ?? {},
    };
  }
  const side = (): CampaignSideState => ({
    production: OPENING_PRODUCTION,
    fleet: { ...OPENING_FLEET },
    ground: { ...OPENING_GROUND },
  });
  return {
    turn: 1,
    rng: createRng(seed),
    sides: { combine: side(), paneuro: side() },
    sites,
    pending: null,
    launched: { combine: false, paneuro: false },
    battleSerial: 0,
    battles: [],
    log: [
      {
        turn: 1,
        severity: 'info',
        text: 'The war goes interplanetary. Two thirds of the off-world production wins it.',
      },
    ],
    victory: null,
  };
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const log = (
  state: CampaignState,
  severity: CampaignLogEntry['severity'],
  text: string,
): CampaignState => ({
  ...state,
  log: [...state.log, { turn: state.turn, severity, text }],
});

const withSide = (
  state: CampaignState,
  id: CampaignSideId,
  patch: Partial<CampaignSideState>,
): CampaignState => ({
  ...state,
  sides: { ...state.sides, [id]: { ...state.sides[id], ...patch } },
});

const withSite = (state: CampaignState, site: SiteState): CampaignState => ({
  ...state,
  sites: { ...state.sites, [site.id]: site },
});

const addForce = (base: Force, extra: Force): Force => {
  const out: Record<string, number> = { ...base };
  for (const [id, n] of Object.entries(extra)) {
    if (n > 0) out[id] = (out[id] ?? 0) + n;
  }
  return out;
};

/** Remove `taken` from `base`, or say what is missing. */
const takeForce = (base: Force, taken: Force): { force: Force } | { missing: string } => {
  const out: Record<string, number> = { ...base };
  for (const [id, n] of Object.entries(taken)) {
    if (n <= 0) continue;
    if (!Number.isInteger(n)) return { missing: `${id} in whole numbers` };
    const have = out[id] ?? 0;
    if (have < n) return { missing: `${n} ${id} (the pool holds ${have})` };
    out[id] = have - n;
    if (out[id] === 0) delete out[id];
  }
  return { force: out };
};

const fleetLift = (fleet: Force): number => {
  let lots = 0;
  for (const [id, n] of Object.entries(fleet)) lots += (shipEntry(id)?.lots ?? 0) * n;
  return lots;
};

const drawSeed = (state: CampaignState): { state: CampaignState; seed: number } => {
  const draw = nextFloat(state.rng);
  return { state: { ...state, rng: draw.state }, seed: Math.floor(draw.value * 0x7ffffffe) + 1 };
};

const battleId = (state: CampaignState, site: string, kind: 'space' | 'ground'): string =>
  `b${state.battleSerial}-${site}-${kind}`;

const productionHeld = (state: CampaignState, side: CampaignSideId): number =>
  Object.values(state.sites)
    .filter((s) => s.holder === side)
    .reduce((n, s) => n + (siteDef(s.id)?.production ?? 0), 0);

// ---------------------------------------------------------------------------
// Orders of battle
// ---------------------------------------------------------------------------

/** How long each kind of battle gets before it counts as decided against the attacker. */
const SPACE_TURN_LIMIT = 30;
const GROUND_TURN_LIMIT = 15;

const spaceOrder = (
  state: CampaignState,
  pending: PendingOperation,
  defenderFleet: Force,
): { state: CampaignState; order: OrderOfBattle } => {
  const drawn = drawSeed(state);
  const serial = { ...drawn.state, battleSerial: drawn.state.battleSerial + 1 };
  const attacker = CAMPAIGN_SIDES[pending.attacker];
  const defender = CAMPAIGN_SIDES[state.sites[pending.site]!.holder!];
  return {
    state: serial,
    order: {
      battleId: battleId(serial, pending.site, 'space'),
      seed: drawn.seed,
      scenarioId: 'contested-transfer',
      sides: [
        {
          player: attacker.id,
          faction: attacker.faction,
          // The convoy's hulls, plus the landing force restated as freight:
          // one lot per armour unit, which is the conversion table at work.
          forces: { ...pending.fleet, freight: lotsOf(pending.cargo) },
        },
        { player: defender.id, faction: defender.faction, forces: defenderFleet },
      ],
      terms: {
        origin: 'terra',
        target: pending.site,
        turnLimit: SPACE_TURN_LIMIT,
        cargoLots: lotsOf(pending.cargo),
      },
    },
  };
};

const groundOrder = (
  state: CampaignState,
  pending: PendingOperation,
  landed: Force,
): { state: CampaignState; order: OrderOfBattle } => {
  const drawn = drawSeed(state);
  const serial = { ...drawn.state, battleSerial: drawn.state.battleSerial + 1 };
  const attacker = CAMPAIGN_SIDES[pending.attacker];
  const holder = state.sites[pending.site]!.holder;
  const defender = holder ? CAMPAIGN_SIDES[holder] : null;
  return {
    state: serial,
    order: {
      battleId: battleId(serial, pending.site, 'ground'),
      seed: drawn.seed,
      scenarioId: 'landing',
      sides: [
        { player: attacker.id, faction: attacker.faction, forces: landed },
        {
          player: defender?.id ?? 'garrison',
          faction: defender?.faction ?? 'Garrison',
          forces: state.sites[pending.site]!.garrison,
        },
      ],
      terms: { site: pending.site, turnLimit: GROUND_TURN_LIMIT },
    },
  };
};

// ---------------------------------------------------------------------------
// Resolution steps shared by more than one command
// ---------------------------------------------------------------------------

/**
 * The convoy arrives with nobody contesting the crossing: the fleet turns for
 * home, the cargo lands whole, and the only question left is the garrison.
 */
const arriveUnopposed = (state: CampaignState): CampaignApplyResult => {
  const pending = state.pending!;
  let next = withSide(state, pending.attacker, {
    fleet: addForce(state.sides[pending.attacker].fleet, pending.fleet),
  });
  next = log(
    next,
    'info',
    `The transfer to ${siteDef(pending.site)?.name ?? pending.site} goes uncontested.`,
  );
  return landCargo(next, pending.cargo);
};

/**
 * Put a landed force on the ground at the pending site: against an empty
 * site the landing takes it; against a garrison it becomes a ground battle.
 */
const landCargo = (state: CampaignState, landed: Force): CampaignApplyResult => {
  const pending = state.pending!;
  const site = state.sites[pending.site]!;
  const name = siteDef(site.id)?.name ?? site.id;

  if (forceIsEmpty(landed)) {
    const next = log(
      { ...state, pending: null },
      'bad',
      `Nothing of the landing force reached ${name}. The offensive is over.`,
    );
    return { state: next, result: ok() };
  }

  if (forceIsEmpty(site.garrison)) {
    let next = withSite(state, { ...site, holder: pending.attacker, garrison: landed });
    next = log(
      { ...next, pending: null },
      'good',
      `${CAMPAIGN_SIDES[pending.attacker].name} lands unopposed and takes ${name} ` +
        `(${describeForce(landed)} now garrisons it).`,
    );
    return { state: next, result: ok() };
  }

  const built = groundOrder(state, pending, landed);
  const next = log(
    {
      ...built.state,
      pending: { ...pending, stage: 'ground', order: built.order, landed },
    },
    'warn',
    `${describeForce(landed)} is ashore on ${name} against a garrison of ` +
      `${describeForce(site.garrison)}. Fight the landing in Ogre.`,
  );
  return { state: next, result: ok() };
};

// ---------------------------------------------------------------------------
// The two battle reports
// ---------------------------------------------------------------------------

const reportSpace = (state: CampaignState, result: BattleResult): CampaignApplyResult => {
  const pending = state.pending!;
  const defenderId = state.sites[pending.site]!.holder!;
  const record: BattleRecord = {
    battleId: result.battleId,
    kind: 'space',
    site: pending.site,
    attacker: pending.attacker,
    result,
  };

  const shipped = lotsOf(pending.cargo);
  const delivered = Math.max(
    0,
    Math.min(shipped, Math.round(result.victoryPoints[pending.attacker] ?? 0)),
  );

  // Surviving hulls fly home to their pools; the freight entry is not a hull.
  const attackerShips: Record<string, number> = { ...(result.survivors[pending.attacker] ?? {}) };
  const freightAboard = attackerShips['freight'] ?? 0;
  delete attackerShips['freight'];
  const defenderShips: Record<string, number> = { ...(result.survivors[defenderId] ?? {}) };
  delete defenderShips['freight'];

  let next: CampaignState = { ...state, battles: [...state.battles, record] };
  next = withSide(next, pending.attacker, {
    fleet: addForce(next.sides[pending.attacker].fleet, attackerShips),
  });
  next = withSide(next, defenderId, {
    fleet: addForce(next.sides[defenderId].fleet, defenderShips),
  });

  // The tonnage that got down becomes the landing force; tonnage still aboard
  // surviving hulls turned back with them; the rest is on the bottom of the
  // long dark. Delivered freight is still "aboard" the hulls that landed it,
  // so the returned share is what floats *beyond* what landed.
  const ashore = splitByLots(pending.cargo, delivered);
  const returned = splitByLots(ashore.remainder, Math.max(0, freightAboard - delivered));
  if (!forceIsEmpty(returned.loaded)) {
    next = withSide(next, pending.attacker, {
      ground: addForce(next.sides[pending.attacker].ground, returned.loaded),
    });
    next = log(next, 'info', `${describeForce(returned.loaded)} turned back with the convoy.`);
  }
  if (!forceIsEmpty(returned.remainder)) {
    next = log(next, 'bad', `${describeForce(returned.remainder)} went down with the ships.`);
  }

  return landCargo(next, ashore.loaded);
};

const reportGround = (state: CampaignState, result: BattleResult): CampaignApplyResult => {
  const pending = state.pending!;
  const site = state.sites[pending.site]!;
  const name = siteDef(site.id)?.name ?? site.id;
  const attacker = CAMPAIGN_SIDES[pending.attacker];
  const record: BattleRecord = {
    battleId: result.battleId,
    kind: 'ground',
    site: pending.site,
    attacker: pending.attacker,
    result,
  };

  const defenderId = pending.order!.sides[1]!.player;
  const attackerWon = result.winners.includes(pending.attacker);
  const attackerSurvivors = result.survivors[pending.attacker] ?? {};
  const defenderSurvivors = result.survivors[defenderId] ?? {};

  let next: CampaignState = { ...state, battles: [...state.battles, record], pending: null };

  if (attackerWon) {
    next = withSite(next, { ...site, holder: pending.attacker, garrison: attackerSurvivors });
    next = log(
      next,
      'good',
      `${attacker.name} takes ${name} (a ${result.level} victory). ` +
        `${describeForce(attackerSurvivors)} garrisons it.`,
    );
  } else {
    next = withSite(next, { ...site, garrison: defenderSurvivors });
    // Whatever the landing force has left is stranded on a hostile world with
    // nothing to come home in; the campaign writes it off.
    next = log(
      next,
      'bad',
      `The landing on ${name} is defeated (a ${result.level} defence). ` +
        (forceIsEmpty(attackerSurvivors)
          ? 'Nothing of the landing force survives.'
          : `${describeForce(attackerSurvivors)} is stranded and lost.`),
    );
  }
  return { state: next, result: ok() };
};

// ---------------------------------------------------------------------------
// The reducer
// ---------------------------------------------------------------------------

export const applyCampaignCommand = (
  state: CampaignState,
  cmd: CampaignCommand,
): CampaignApplyResult => {
  if (state.victory) return { state, result: fail('the war is over') };

  switch (cmd.type) {
    case 'buyShips': {
      const entry = shipEntry(cmd.ship);
      if (!entry) return { state, result: fail(`"${cmd.ship}" is not a hull the yards sell`) };
      if (!Number.isInteger(cmd.count) || cmd.count < 1) {
        return { state, result: fail('buy at least one, in whole numbers') };
      }
      const cost = entry.pp * cmd.count;
      const side = state.sides[cmd.by];
      if (cost > side.production) {
        return {
          state,
          result: fail(
            `${entry.name} ×${cmd.count} costs ${cost} PP; ${cmd.by} has ${side.production}`,
          ),
        };
      }
      const next = withSide(state, cmd.by, {
        production: side.production - cost,
        fleet: addForce(side.fleet, { [entry.id]: cmd.count }),
      });
      return { state: next, result: ok() };
    }

    case 'buyGround': {
      const entry = groundEntry(cmd.unit);
      if (!entry) return { state, result: fail(`"${cmd.unit}" is not in the ground catalogue`) };
      if (!Number.isInteger(cmd.count) || cmd.count < 1) {
        return { state, result: fail('buy at least one, in whole numbers') };
      }
      const cost = entry.pp * cmd.count;
      const side = state.sides[cmd.by];
      if (cost > side.production) {
        return {
          state,
          result: fail(
            `${entry.name} ×${cmd.count} costs ${cost} PP; ${cmd.by} has ${side.production}`,
          ),
        };
      }
      const next = withSide(state, cmd.by, {
        production: side.production - cost,
        ground: addForce(side.ground, { [entry.id]: cmd.count }),
      });
      return { state: next, result: ok() };
    }

    case 'garrison': {
      const site = state.sites[cmd.site];
      if (!site) return { state, result: fail(`there is no site called "${cmd.site}"`) };
      if (site.holder !== cmd.by) {
        return {
          state,
          result: fail(`${cmd.by} does not hold ${siteDef(cmd.site)?.name ?? cmd.site}`),
        };
      }
      const taken = takeForce(state.sides[cmd.by].ground, { [cmd.unit]: cmd.count });
      if ('missing' in taken) return { state, result: fail(`the pool is short: ${taken.missing}`) };
      let next = withSide(state, cmd.by, { ground: taken.force });
      next = withSite(next, {
        ...site,
        garrison: addForce(site.garrison, { [cmd.unit]: cmd.count }),
      });
      return { state: next, result: ok() };
    }

    case 'launchOffensive': {
      if (state.pending) return { state, result: fail('an operation is already under way') };
      if (state.launched[cmd.by]) {
        return { state, result: fail('one offensive per side per turn; consolidate first') };
      }
      const site = state.sites[cmd.site];
      if (!site) return { state, result: fail(`there is no site called "${cmd.site}"`) };
      if (site.holder === cmd.by) {
        return {
          state,
          result: fail(`${cmd.by} already holds ${siteDef(cmd.site)?.name ?? cmd.site}`),
        };
      }
      if (forceIsEmpty(cmd.fleet)) return { state, result: fail('a transfer needs ships') };
      if (armourUnitsOf(cmd.cargo) <= 0) {
        return { state, result: fail('a landing needs a landing force aboard') };
      }
      const lift = fleetLift(cmd.fleet);
      const need = lotsOf(cmd.cargo);
      if (lift < need) {
        return { state, result: fail(`the convoy lifts ${lift} lots and the force needs ${need}`) };
      }
      const fleetTaken = takeForce(state.sides[cmd.by].fleet, cmd.fleet);
      if ('missing' in fleetTaken) {
        return { state, result: fail(`the fleet pool is short: ${fleetTaken.missing}`) };
      }
      const cargoTaken = takeForce(state.sides[cmd.by].ground, cmd.cargo);
      if ('missing' in cargoTaken) {
        return { state, result: fail(`the ground pool is short: ${cargoTaken.missing}`) };
      }

      let next = withSide(state, cmd.by, { fleet: fleetTaken.force, ground: cargoTaken.force });
      next = { ...next, launched: { ...next.launched, [cmd.by]: true } };
      const pending: PendingOperation = {
        attacker: cmd.by,
        site: cmd.site,
        stage: 'intercept',
        fleet: cmd.fleet,
        cargo: cmd.cargo,
        defenderFleet: null,
        order: null,
        landed: null,
      };
      next = { ...next, pending };
      next = log(
        next,
        'info',
        `${CAMPAIGN_SIDES[cmd.by].name} sails for ${siteDef(cmd.site)?.name ?? cmd.site}: ` +
          `${describeForce(cmd.cargo)} aboard, escort of ${Object.entries(cmd.fleet)
            .map(([id, n]) => `${id} ×${n}`)
            .join(', ')}.`,
      );

      const holder = site.holder;
      if (holder === null || forceIsEmpty(next.sides[holder].fleet)) {
        // Nobody can come out to meet it.
        return arriveUnopposed(next);
      }
      return { state: next, result: ok() };
    }

    case 'intercept': {
      const pending = state.pending;
      if (!pending || pending.stage !== 'intercept') {
        return { state, result: fail('there is no transfer to intercept') };
      }
      const defenderId = state.sites[pending.site]!.holder;
      if (cmd.by !== defenderId) {
        return { state, result: fail('only the holder of the site may intercept') };
      }
      if (forceIsEmpty(cmd.fleet)) return { state, result: fail('an interception needs ships') };
      const taken = takeForce(state.sides[cmd.by].fleet, cmd.fleet);
      if ('missing' in taken)
        return { state, result: fail(`the fleet pool is short: ${taken.missing}`) };

      let next = withSide(state, cmd.by, { fleet: taken.force });
      const built = spaceOrder(next, pending, cmd.fleet);
      next = {
        ...built.state,
        pending: { ...pending, stage: 'space', defenderFleet: cmd.fleet, order: built.order },
      };
      next = log(
        next,
        'warn',
        `${CAMPAIGN_SIDES[cmd.by].name} comes out to meet the convoy off ` +
          `${siteDef(pending.site)?.name ?? pending.site}. Fight the transfer here, or host it as an online table.`,
      );
      return { state: next, result: ok() };
    }

    case 'stand': {
      const pending = state.pending;
      if (!pending || pending.stage !== 'intercept') {
        return { state, result: fail('there is no transfer to stand down from') };
      }
      if (cmd.by !== state.sites[pending.site]!.holder) {
        return { state, result: fail('only the holder of the site may stand down') };
      }
      return arriveUnopposed(state);
    }

    case 'reportBattle': {
      const pending = state.pending;
      if (!pending || !pending.order)
        return { state, result: fail('no battle is waiting for a result') };
      if (cmd.result.battleId !== pending.order.battleId) {
        return {
          state,
          result: fail(
            `this result is for "${cmd.result.battleId}"; the campaign is waiting on "${pending.order.battleId}"`,
          ),
        };
      }
      return pending.stage === 'space'
        ? reportSpace(state, cmd.result)
        : reportGround(state, cmd.result);
    }

    case 'endTurn': {
      if (state.pending) {
        return { state, result: fail('a battle is being fought; report its result first') };
      }
      let next = state;
      for (const id of ['combine', 'paneuro'] as const) {
        const income = productionHeld(next, id);
        next = withSide(next, id, { production: next.sides[id].production + income });
      }
      next = {
        ...next,
        turn: next.turn + 1,
        launched: { combine: false, paneuro: false },
      };
      next = log(next, 'info', `Turn ${next.turn}. Production is in.`);

      for (const id of ['combine', 'paneuro'] as const) {
        const held = productionHeld(next, id);
        if (held >= VICTORY_PRODUCTION) {
          const everything = Object.values(next.sites).every((s) => s.holder === id);
          const victory: CampaignVictory = {
            winner: id,
            level: everything ? 'complete' : 'standard',
            reason: everything
              ? `${CAMPAIGN_SIDES[id].name} holds every site off Earth.`
              : `${CAMPAIGN_SIDES[id].name} holds ${held} of the map's production — past the victory line of ${VICTORY_PRODUCTION}.`,
          };
          next = log({ ...next, victory }, 'good', victory.reason);
          break;
        }
      }
      return { state: next, result: ok() };
    }
  }
};
