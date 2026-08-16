/**
 * Gun combat.
 *
 * Everything here is a pure function of `(state, command, map)`; every die goes
 * through `state.rng`, so a replay of the command log reproduces every result.
 *
 * ## The counterattack handshake
 *
 * The rulebook makes return fire simultaneous with the attack that provoked it:
 *
 *   "Ships which are attacked may return fire against any or all of their
 *    attackers during the combat phase, *before any damage is implemented*."
 *
 * That means a ship which is about to be destroyed still shoots back at full
 * strength, so damage cannot be applied at the moment it is rolled. The flow is:
 *
 *   1. `resolveAttack` validates the attack, rolls it, marks the attackers as
 *      having fired and the targets as having been attacked, and *stores* the
 *      damage it rolled in `state.scenarioData['_pendingAttack']`.
 *      If nobody is able to return fire, it applies the damage immediately and
 *      stores nothing — a pending record only ever exists when a live decision
 *      is genuinely owed.
 *   2. The reducer calls `pendingCounterattack(state)`. A non-null answer means
 *      the defender owes a decision; `attackers` lists the ships eligible to
 *      return fire and `targets` lists the ships they may shoot at (the original
 *      attackers, and only those).
 *   3. The defender answers with either
 *        - `resolveCounterattack(state, cmd, map)` — rolls the return fire
 *          against the *undamaged* attackers, then applies both results; or
 *        - `declineCounterattack(state)` — applies the stored damage untouched.
 *      `resolvePendingDamage(state)` is the low-level applier both use, exposed
 *      so a phase-end sweep can flush a record the defender never answered.
 *
 * Both damage sets are computed against the pre-damage state, so the order in
 * which they are finally written back is immaterial.
 */

import { closestApproach, traceSegment } from './geometry.js';
import { type Hex, type HexSide, distance, eq, sideGravityHex, sideKey, sub } from './hex.js';
import type { GameMap } from './map.js';
import { rollDie } from './rng.js';
import { SHIP_CLASSES } from './ships.js';
import {
  type DamageResult,
  type OddsColumn,
  DESTRUCTION_THRESHOLD,
  gunDamage,
  gunToHit,
  hitLocation,
  oddsColumn,
  rangeModifier,
  velocityModifier,
} from './crt.js';
import type {
  Attack,
  CommandResult,
  Counterattack,
  FirePlanetaryDefence,
  SuppressHexside,
} from './commands.js';
import {
  type AttackModifiers,
  type AttackResolution,
  type GameState,
  type PlayerId,
  type Ship,
  type ShipId,
  activePlayer,
  areAllied,
  controllerOf,
} from './types.js';
import { log, updateShip, withBase } from './state.js';

// ---------------------------------------------------------------------------
// Small shared predicates
// ---------------------------------------------------------------------------

/**
 * A ship's combat strength: "represents both the high-velocity guns it carries
 * and the structural ability of the ship to withstand damage." One number does
 * both jobs, so nothing here scales it down for damage already taken.
 */
export const combatStrength = (ship: Ship): number => SHIP_CLASSES[ship.shipClass].combatStrength;

export const shipLabel = (ship: Ship): string =>
  ship.name ?? `${SHIP_CLASSES[ship.shipClass].name} ${ship.number}`;

/** The advanced system loses a track once it reaches D6. */
export const ADVANCED_TRACK_LIMIT = 6;

/** Non-warships. The weapon-damage rules single them out. */
const isCivilian = (ship: Ship): boolean => !SHIP_CLASSES[ship.shipClass].warship;

/**
 * Advanced system only: "A ship with any weapon damage cannot fire guns or drop
 * ordnance. Exception: A dreadnaught can still fire if its weapon damage status
 * is D1 through D3." — and "Weapon hits on civilian ships have no effect except
 * to prevent their launching mines", which we read literally: a packet's
 * railguns keep working, only its ordnance rack is wrecked (ordnance.ts owns
 * that half of the rule).
 */
const weaponsOperational = (ship: Ship, advancedCombat: boolean): boolean => {
  if (!advancedCombat) return true;
  const w = ship.advancedDamage.weapon;
  if (w <= 0) return true;
  if (isCivilian(ship)) return true;
  if (ship.shipClass === 'dreadnaught') return w <= 3;
  return false;
};

/**
 * May this ship fire its guns at all?
 *
 * This is a *capability* predicate — it deliberately ignores the once-per-phase
 * rule, which is phase bookkeeping rather than a property of the ship.
 *
 * The exceptions the rulebook lists for disabled ships live here:
 * "Dreadnaughts may still fire their guns (only) even though disabled. An
 * orbital base may launch torpedoes, fire guns, and resupply friendly ships
 * while the base itself is slightly (D1) damaged."
 */
export const canFire = (ship: Ship, advancedCombat = false): boolean => {
  if (ship.destroyed) return false;
  // "Ships with a D after their combat strength may not attack or counterattack."
  if (SHIP_CLASSES[ship.shipClass].defensiveOnly) return false;
  // A captured ship "may not fire, or return fire if fired upon."
  if (ship.capturedBy !== undefined) return false;
  // "Ships landed at planetary bases may not fire guns or launch ordnance."
  if (ship.location.kind === 'landed') return false;
  // "No ship may fire its guns or launch ordnance during a player-turn in which
  // it resupplies." Resupply is a whole-turn maintenance stopover in this model,
  // so the flag gates the ship for the rest of the game turn, return fire
  // included. (A strict reading would free it during the *enemy's* player-turn.)
  if (ship.resuppliedThisTurn) return false;
  if (!weaponsOperational(ship, advancedCombat)) return false;
  if (ship.disabled > 0) {
    if (ship.shipClass === 'dreadnaught') return true;
    if (ship.shipClass === 'orbitalBase') return ship.disabled <= 1;
    return false;
  }
  return true;
};

/**
 * A ship with any drive damage cannot manoeuvre; in the basic system any
 * disablement does the same ("A disabled ship cannot maneuver, launch ordnance,
 * or attack. It may only drift on its current course.").
 */
export const canManeuver = (ship: Ship, advancedCombat = false): boolean => {
  if (ship.destroyed) return false;
  if (advancedCombat) return ship.advancedDamage.drive <= 0 && ship.disabled <= 0;
  return ship.disabled <= 0;
};

/**
 * Advanced system: "A ship whose drive reaches D6 or below may not be repaired;
 * it will be lost when it reaches the edge of the map." We only *mark* the ship
 * here; movement.ts is what notices the map edge.
 */
export const driveDoomed = (ship: Ship): boolean =>
  ship.advancedDamage.drive >= ADVANCED_TRACK_LIMIT;

/** Advanced system: a wrecked weapon track can only be fixed at a base. */
export const weaponsUnrepairable = (ship: Ship): boolean =>
  ship.advancedDamage.weapon >= ADVANCED_TRACK_LIMIT;

/**
 * Lootable / capturable status.
 *
 * Basic: any disablement. Advanced: "A ship is considered 'disabled' and
 * lootable/capturable only if it can neither maneuver nor fire. Structure damage
 * does not make a ship any more or less lootable."
 */
export const isDisabled = (ship: Ship, advancedCombat = false): boolean => {
  if (ship.destroyed) return false;
  if (!advancedCombat) return ship.disabled > 0;
  // A wrecked weapon track is not the only way to be unable to fire. A ship that
  // never had guns can never fire either: "Commercial ships have a suffix D in
  // their combat strengths and may not attack or counterattack", and a prize
  // "may not fire, or return fire if fired upon". Without this a crippled
  // freighter can neither manoeuvre nor fire and yet is never lootable, which
  // is the opposite of "lootable/capturable only if it can neither maneuver nor
  // fire".
  const gunless = SHIP_CLASSES[ship.shipClass].defensiveOnly || ship.capturedBy !== undefined;
  const cannotFire = gunless || !weaponsOperational(ship, true) || ship.disabled > 0;
  const cannotMove = ship.advancedDamage.drive > 0 || ship.disabled > 0;
  return cannotFire && cannotMove;
};

/**
 * "Once landed at a planetary base, a ship is immune from gunfire, mines,
 * torpedoes, and ramming, but not from nukes." Ships stopped at an *asteroid*
 * base get no such protection: "Ships at asteroid bases may attack and be
 * attacked normally."
 */
export const immuneToGunfire = (ship: Ship): boolean => ship.location.kind === 'landed';

/**
 * Whose side is this ship on, for the purpose of shooting at it?
 *
 * `controllerOf`, not `owner`. A prize flies for its captor until it is redeemed
 * at his base, and every other module already agrees on that — movement, supply,
 * detection, looting. Deciding it by `owner` here would put a captured hull on
 * the books of the fleet that just lost it: for the length of the transit its
 * captor could not shoot at his own escort's attackers without the prize
 * counting as a friend, and the side that lost it could not shoot at it at all.
 *
 * p. 8 says a captured ship "may not fire, or return fire if fired upon", which
 * only makes sense if somebody is firing on it — and the somebody is the fleet
 * trying to get it back. That prohibition is enforced separately (`canFire`
 * refuses any ship with `capturedBy` set), so a prize remains a legal *target*
 * and an illegal *shooter*, which is precisely the printed rule.
 */
const enemyOf = (state: GameState, side: PlayerId, ship: Ship): boolean =>
  !areAllied(state, side, controllerOf(ship));

const listNames = (ships: readonly Ship[]): string => {
  const names = ships.map(shipLabel);
  if (names.length <= 1) return names[0] ?? 'nobody';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]!}`;
};

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

export interface AttackPreview {
  legal: boolean;
  reason?: string;
  attackStrength: number;
  defenceStrength: number;
  column: OddsColumn | null;
  /** Range in hexes (the *greatest* over every attacker/target pair). */
  range: number;
  /** Velocity difference in hexes (again the greatest applicable). */
  relativeVelocity: number;
  /** The same two numbers converted into die modifiers, plus heroism. */
  modifiers: AttackModifiers;
  blockedBy?: string;
}

/**
 * Counterattacks relax exactly one restriction: their targets need not share a
 * hex, because a victim "may return fire against any or all of their attackers"
 * and those attackers may have fired "in the same or different hexes".
 */
export type AttackMode = 'attack' | 'counterattack';

const NO_MODIFIERS: AttackModifiers = {
  range: 0,
  relativeVelocity: 0,
  heroic: false,
  total: 0,
};

const illegal = (reason: string, extra: Partial<AttackPreview> = {}): AttackPreview => ({
  legal: false,
  reason,
  attackStrength: 0,
  defenceStrength: 0,
  column: null,
  range: 0,
  relativeVelocity: 0,
  modifiers: NO_MODIFIERS,
  ...extra,
});

/**
 * Work out whether an attack is legal and, if so, exactly how it will be rolled.
 *
 * `strength` implements limited attacks: "A ship may always attack or
 * counterattack with less than its rated combat strength, if it hopes to disable
 * a target without destroying it."
 */
export function previewAttack(
  state: GameState,
  attackers: readonly ShipId[],
  targets: readonly ShipId[],
  map: GameMap,
  strength?: number,
  mode: AttackMode = 'attack',
): AttackPreview {
  const advanced = state.options.advancedCombat;

  if (attackers.length === 0) return illegal('no attacking ships were named');
  if (targets.length === 0) return illegal('no targets were named');

  const atk: Ship[] = [];
  for (const id of attackers) {
    const ship = state.ships[id];
    if (!ship) return illegal(`unknown ship ${id}`);
    if (atk.some((s) => s.id === ship.id)) return illegal(`${shipLabel(ship)} was listed twice`);
    atk.push(ship);
  }

  const tgt: Ship[] = [];
  for (const id of targets) {
    const ship = state.ships[id];
    if (!ship) return illegal(`unknown ship ${id}`);
    if (tgt.some((s) => s.id === ship.id)) return illegal(`${shipLabel(ship)} was listed twice`);
    tgt.push(ship);
  }

  const side = controllerOf(atk[0]!);

  for (const a of atk) {
    if (!areAllied(state, side, controllerOf(a))) {
      return illegal('attacking ships must belong to the same side');
    }
    if (a.destroyed) return illegal(`${shipLabel(a)} has been destroyed`);
    if (SHIP_CLASSES[a.shipClass].defensiveOnly) {
      // "Commercial ships have a suffix D in their combat strengths and may not
      // attack or counterattack."
      return illegal(`${shipLabel(a)} has a defensive-only strength and may not attack`);
    }
    if (mode === 'attack' && SHIP_CLASSES[a.shipClass].counterattackOnly === true) {
      // Robot guards are rated "only for defense and counterattacks": they hold
      // a claim against whoever comes, but they never start it.
      return illegal(`${shipLabel(a)} may only return fire, never open it`);
    }
    if (a.capturedBy !== undefined) {
      return illegal(`${shipLabel(a)} is a prize crew and may not fire`);
    }
    if (a.location.kind === 'landed') {
      return illegal(`${shipLabel(a)} is landed and may not fire guns`);
    }
    if (a.resuppliedThisTurn) {
      return illegal(`${shipLabel(a)} resupplied this turn and may not fire`);
    }
    if (!weaponsOperational(a, advanced)) {
      return illegal(`${shipLabel(a)} has weapon damage and may not fire`);
    }
    if (!canFire(a, advanced)) {
      return illegal(`${shipLabel(a)} is disabled and may not fire`);
    }
    // "No ship may attack or be attacked more than once per combat phase."
    if (a.firedThisPhase) {
      return illegal(`${shipLabel(a)} has already fired this combat phase`);
    }
  }

  // "If more than one ship occupies a hex, the attacker may attack one, some, or
  // all of them in one attack." A target *group* is therefore one hex's worth of
  // ships — except when returning fire, where the rules name the attackers
  // individually and those may be spread over several hexes.
  if (mode === 'attack') {
    const home = tgt[0]!.pos;
    for (const t of tgt) {
      if (!eq(t.pos, home)) {
        return illegal('ships attacked together must occupy the same hex');
      }
    }
  }

  for (const t of tgt) {
    if (t.destroyed) return illegal(`${shipLabel(t)} has been destroyed`);
    if (!enemyOf(state, side, t)) return illegal(`${shipLabel(t)} is not an enemy`);
    if (t.attackedThisPhase) {
      return illegal(`${shipLabel(t)} has already been attacked this combat phase`);
    }
    if (immuneToGunfire(t)) {
      return illegal(`${shipLabel(t)} is landed at a planetary base and immune to gunfire`);
    }
    // "Surrender is a binding bargain. Both parties agree not to attack the
    // other specific ship." Only the two signatories are bound: the rest of
    // either fleet may fire freely, so a merchant cannot buy immunity from a
    // whole pirate squadron by surrendering to its weakest ship.
    for (const a of atk) {
      if (t.surrenderedTo.includes(a.id)) {
        return illegal(
          `${shipLabel(t)} has surrendered to ${shipLabel(a)} and may not be attacked by it`,
        );
      }
      if (a.surrenderedTo.includes(t.id)) {
        return illegal(`${shipLabel(a)} has surrendered to ${shipLabel(t)} and may not attack it`);
      }
    }
  }

  // "Attacks may be made 'through' other ships, ordnance, and asteroids, but not
  // through moons, planets, or Sol."
  for (const a of atk) {
    for (const t of tgt) {
      const blocker = map.lineOfSightBlockedBy(a.pos, t.pos);
      if (blocker) {
        return illegal(
          `${blocker.name} blocks the line of sight from ${shipLabel(a)} to ${shipLabel(t)}`,
          { blockedBy: blocker.name },
        );
      }
    }
  }

  // Range: "always measured from the attacker's closest approach to the target's
  // final position", over the course actually flown this turn. Relative velocity:
  // "plotting both ships' course vectors from a common point and counting the
  // hexes separating the two course end points."
  // "In any combat with multiple targets or attackers, use the greatest possible
  // penalties for range and relative velocity."
  let range = 0;
  let relativeVelocity = 0;
  for (const a of atk) {
    const path = traceSegment(sub(a.pos, a.velocity), a.pos).entered;
    for (const t of tgt) {
      range = Math.max(range, closestApproach(path, t.pos));
      relativeVelocity = Math.max(relativeVelocity, distance(a.velocity, t.velocity));
    }
  }

  const fullStrength = atk.reduce((n, s) => n + combatStrength(s), 0);
  const attackStrength =
    strength === undefined ? fullStrength : Math.min(Math.floor(strength), fullStrength);
  if (attackStrength <= 0) return illegal('an attack must be made at a strength of at least 1');

  // "Any combination of ships attacked together defends with the sum of their
  // combat strengths."
  const defenceStrength = tgt.reduce((n, s) => n + combatStrength(s), 0);
  const column = oddsColumn(attackStrength, defenceStrength);

  // "Heroic ships always add +1 to the die roll for gun combat when attacking."
  // The bonus is a flat +1, not +1 per veteran, so a mixed group gets one.
  const heroic = atk.some((a) => a.heroic);
  const rangeMod = rangeModifier(range);
  const velocityMod = velocityModifier(relativeVelocity);
  const modifiers: AttackModifiers = {
    range: rangeMod,
    relativeVelocity: velocityMod,
    heroic,
    total: rangeMod + velocityMod + (heroic ? 1 : 0),
  };

  return {
    legal: true,
    attackStrength,
    defenceStrength,
    column,
    range,
    relativeVelocity,
    modifiers,
  };
}

// ---------------------------------------------------------------------------
// Damage application
// ---------------------------------------------------------------------------

const destroy = (state: GameState, ship: Ship, cause: string, by?: PlayerId): GameState => {
  const next = updateShip(state, ship.id, {
    destroyed: true,
    destroyedBy: cause,
    ...(by !== undefined ? { destroyedByPlayer: by } : {}),
  });
  return log(next, `${shipLabel(ship)} destroyed by ${cause}.`, {
    severity: 'bad',
    focus: [ship.pos],
  });
};

/**
 * Apply one basic-system damage result.
 *
 * "Damage is cumulative; if a ship is already disabled, any new results are
 * added to its current period of disablement. If a ship ever reaches a condition
 * of D6 or greater, it is destroyed."
 */
export function applyDamage(
  state: GameState,
  target: ShipId,
  result: DamageResult,
  cause: string,
  by?: PlayerId,
): GameState {
  const ship = state.ships[target];
  if (!ship || ship.destroyed) return state;
  if (result === null) return state;

  if (result === 'E') {
    // "E – Eliminated. The target ship is destroyed."
    return destroy(state, ship, cause, by);
  }

  const total = ship.disabled + result;
  if (total >= DESTRUCTION_THRESHOLD) {
    const wrecked = updateShip(state, target, { disabled: total });
    return destroy(wrecked, ship, cause);
  }

  const next = updateShip(state, target, { disabled: total });
  return log(
    next,
    `${shipLabel(ship)} disabled for ${total} turn${total === 1 ? '' : 's'} by ${cause}.`,
    {
      severity: 'warn',
      focus: [ship.pos],
    },
  );
}

interface HitTotals {
  readonly weapon: number;
  readonly drive: number;
  readonly structure: number;
}

const ZERO_HITS: HitTotals = { weapon: 0, drive: 0, structure: 0 };

/**
 * Fold a bundle of advanced-system hits onto a ship and work out what they cost
 * it. Structure is the only track that kills outright: "if structure reaches D6
 * or below, the ship explodes or falls apart, and is lost."
 */
const applyHitTotals = (
  state: GameState,
  target: ShipId,
  totals: HitTotals,
  cause: string,
  by?: PlayerId,
): GameState => {
  const ship = state.ships[target];
  if (!ship || ship.destroyed) return state;
  if (totals.weapon === 0 && totals.drive === 0 && totals.structure === 0) return state;

  const weapon = ship.advancedDamage.weapon + totals.weapon;
  const drive = ship.advancedDamage.drive + totals.drive;
  const structure = ship.advancedDamage.structure + totals.structure;

  let next = updateShip(state, target, { advancedDamage: { weapon, drive, structure } });
  const parts: string[] = [];
  if (totals.weapon > 0) parts.push(`${totals.weapon} weapon`);
  if (totals.drive > 0) parts.push(`${totals.drive} drive`);
  if (totals.structure > 0) parts.push(`${totals.structure} structure`);
  next = log(next, `${shipLabel(ship)} takes ${parts.join(', ')} damage from ${cause}.`, {
    severity: 'warn',
    focus: [ship.pos],
  });

  if (structure >= ADVANCED_TRACK_LIMIT) {
    return destroy(next, ship, `${cause} (structural failure)`, by);
  }
  if (drive >= ADVANCED_TRACK_LIMIT && ship.advancedDamage.drive < ADVANCED_TRACK_LIMIT) {
    // "may not be repaired; it will be lost when it reaches the edge of the map."
    next = log(
      next,
      `${shipLabel(ship)} has lost its drive for good — it will be lost when it drifts off the map.`,
      { severity: 'bad', focus: [ship.pos] },
    );
  }
  if (weapon >= ADVANCED_TRACK_LIMIT && ship.advancedDamage.weapon < ADVANCED_TRACK_LIMIT) {
    // "can no longer repair them; it must get back to a base."
    next = log(next, `${shipLabel(ship)} has lost its guns until it reaches a base.`, {
      severity: 'warn',
      focus: [ship.pos],
    });
  }
  return next;
};

/**
 * Advanced system: "Each hit scored gives you one roll on the Damage table."
 * Rolls `hits` locations through `state.rng` and applies the lot.
 */
export function applyAdvancedHits(
  state: GameState,
  target: ShipId,
  hits: number,
  cause: string,
  by?: PlayerId,
): { state: GameState } {
  if (hits <= 0) return { state };
  let rng = state.rng;
  let totals = ZERO_HITS;
  for (let i = 0; i < hits; i++) {
    const roll = rollDie(rng);
    rng = roll.state;
    const loc = hitLocation(roll.value);
    totals = {
      weapon: totals.weapon + loc.weapon,
      drive: totals.drive + loc.drive,
      structure: totals.structure + loc.structure,
    };
  }
  return { state: applyHitTotals({ ...state, rng }, target, totals, cause, by) };
}

// ---------------------------------------------------------------------------
// Rolling an attack
// ---------------------------------------------------------------------------

/** What one target will suffer once the counterattack window closes. */
export interface PendingDamage {
  readonly target: ShipId;
  /** Basic system result. `null` in the advanced system. */
  readonly result: DamageResult;
  /** Advanced system: the hit locations already rolled for this target. */
  readonly advanced?: HitTotals;
}

interface RolledAttack {
  readonly state: GameState;
  readonly resolution: AttackResolution;
  readonly damage: readonly PendingDamage[];
  /** Total "D" inflicted, used for the heroism test. */
  readonly severity: number;
}

/**
 * Roll a gun attack that has already been shown to be legal.
 *
 * A single die decides the whole attack, and in the basic system its result
 * applies to every ship in the target group: the group defended with a pooled
 * strength, and the rulebook flags "a torpedo hits only a single target" as an
 * *exception*, which only makes sense if gunfire does not.
 *
 * In the advanced system the hits are dealt out over the group in rotation, then
 * each hit gets its own location roll.
 */
const rollGunAttack = (
  state: GameState,
  preview: AttackPreview,
  attackers: readonly ShipId[],
  targets: readonly ShipId[],
  kind: AttackResolution['kind'],
): RolledAttack => {
  const column = preview.column;

  // "Attacks at less than 1:4 have no effect" — no die is thrown at all.
  if (column === null) {
    return {
      state,
      resolution: {
        attackers: [...attackers],
        targets: [...targets],
        attackStrength: preview.attackStrength,
        defenceStrength: preview.defenceStrength,
        column: null,
        roll: 0,
        modifiers: preview.modifiers,
        modifiedRoll: 0,
        result: null,
        kind,
      },
      damage: [],
      severity: 0,
    };
  }

  let rng = state.rng;
  const first = rollDie(rng);
  rng = first.state;
  const roll = first.value;
  const modifiedRoll = roll + preview.modifiers.total;

  if (state.options.advancedCombat) {
    const count = gunToHit(column, modifiedRoll);
    const totals = new Map<ShipId, HitTotals>();
    for (let i = 0; i < count; i++) {
      const id = targets[i % targets.length]!;
      const where = rollDie(rng);
      rng = where.state;
      const loc = hitLocation(where.value);
      const acc = totals.get(id) ?? ZERO_HITS;
      totals.set(id, {
        weapon: acc.weapon + loc.weapon,
        drive: acc.drive + loc.drive,
        structure: acc.structure + loc.structure,
      });
    }
    const hits = [...totals].map(([target, t]) => ({
      target,
      weapon: t.weapon,
      drive: t.drive,
      structure: t.structure,
    }));
    const damage: PendingDamage[] = hits.map((h) => ({
      target: h.target,
      result: null,
      advanced: { weapon: h.weapon, drive: h.drive, structure: h.structure },
    }));
    const severity = hits.reduce((n, h) => n + h.weapon + h.drive + h.structure, 0);
    return {
      state: { ...state, rng },
      resolution: {
        attackers: [...attackers],
        targets: [...targets],
        attackStrength: preview.attackStrength,
        defenceStrength: preview.defenceStrength,
        column,
        roll,
        modifiers: preview.modifiers,
        modifiedRoll,
        result: null,
        hits,
        kind,
      },
      damage,
      severity,
    };
  }

  const result = gunDamage(column, modifiedRoll);
  const damage: PendingDamage[] =
    result === null ? [] : targets.map((target) => ({ target, result }));
  const severity = result === 'E' ? DESTRUCTION_THRESHOLD : (result ?? 0);

  return {
    state: { ...state, rng },
    resolution: {
      attackers: [...attackers],
      targets: [...targets],
      attackStrength: preview.attackStrength,
      defenceStrength: preview.defenceStrength,
      column,
      roll,
      modifiers: preview.modifiers,
      modifiedRoll,
      result,
      kind,
    },
    damage,
    severity,
  };
};

const describeResolution = (state: GameState, r: AttackResolution, verb: string): string => {
  const atk = r.attackers.map((id) => state.ships[id]).filter((s): s is Ship => !!s);
  const tgt = r.targets.map((id) => state.ships[id]).filter((s): s is Ship => !!s);
  const who = atk.length > 0 ? listNames(atk) : r.attackers.join(', ');
  const whom = listNames(tgt);
  if (r.column === null) {
    return `${who} ${verb} ${whom} at worse than 1:4 — no effect.`;
  }
  const mods =
    r.modifiers.total === 0 ? '' : ` ${r.modifiers.total > 0 ? '+' : ''}${r.modifiers.total}`;
  const outcome =
    r.hits !== undefined
      ? `${r.hits.reduce((n, h) => n + h.weapon + h.drive + h.structure, 0)} hit(s)`
      : r.result === null
        ? 'no effect'
        : r.result === 'E'
          ? 'eliminated'
          : `D${r.result}`;
  return `${who} ${verb} ${whom} at ${r.column} (${r.attackStrength}:${r.defenceStrength}), roll ${r.roll}${mods} = ${r.modifiedRoll}: ${outcome}.`;
};

/**
 * Heroism: "any ship which attacks at less than 1:1 and achieves a result of D2
 * or greater becomes heroic."
 *
 * Less than 1:1 is the 1:4 and 1:2 columns. In the advanced system there is no
 * "D2" result, so we read the equivalent as two or more points of damage.
 */
const heroismEarned = (column: OddsColumn | null, severity: number): boolean =>
  (column === '1:4' || column === '1:2') && severity >= 2;

const awardHeroism = (state: GameState, attackers: readonly ShipId[]): GameState => {
  let next = state;
  for (const id of attackers) {
    const ship = next.ships[id];
    // "A ship may not become heroic more than once."
    if (!ship || ship.destroyed || ship.heroic) continue;
    next = updateShip(next, id, { heroic: true });
    next = log(next, `${shipLabel(ship)} is now heroic (+1 to attack rolls).`, {
      severity: 'good',
      focus: [ship.pos],
    });
  }
  return next;
};

// ---------------------------------------------------------------------------
// The pending-attack record
// ---------------------------------------------------------------------------

/** Where the deferred attack lives inside `GameState.scenarioData`. */
export const PENDING_ATTACK_KEY = '_pendingAttack';

export interface PendingAttack {
  /** The player who made the attack — the one the counterattack answers. */
  readonly by: PlayerId;
  readonly resolution: AttackResolution;
  readonly damage: readonly PendingDamage[];
  /** Ships that may return fire: the victims plus course-matched hexmates. */
  readonly eligible: readonly ShipId[];
  /** Human-readable cause, threaded into damage log lines. */
  readonly cause: string;
}

const readPending = (state: GameState): PendingAttack | null => {
  const raw = state.scenarioData[PENDING_ATTACK_KEY];
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Partial<PendingAttack>;
  if (!p.resolution || !Array.isArray(p.eligible) || !Array.isArray(p.damage)) return null;
  return p as PendingAttack;
};

export const hasPendingAttack = (state: GameState): boolean => readPending(state) !== null;

const writePending = (state: GameState, pending: PendingAttack): GameState => ({
  ...state,
  scenarioData: { ...state.scenarioData, [PENDING_ATTACK_KEY]: pending },
});

const clearPending = (state: GameState): GameState => {
  if (!(PENDING_ATTACK_KEY in state.scenarioData)) return state;
  const next = { ...state.scenarioData };
  delete next[PENDING_ATTACK_KEY];
  return { ...state, scenarioData: next };
};

/**
 * Who, if anyone, owes a counterattack decision.
 *
 * `attackers` are the ships that may return fire, `targets` are the ships they
 * are allowed to shoot at. Returns `null` when no attack is waiting — including
 * the common case where nobody could return fire, because `resolveAttack`
 * applies that damage on the spot rather than parking it.
 */
export function pendingCounterattack(
  state: GameState,
): { attackers: ShipId[]; targets: ShipId[] } | null {
  const pending = readPending(state);
  if (!pending) return null;
  return {
    attackers: [...pending.eligible],
    // "Ships which are attacked may return fire against any or all of their
    // attackers" — and nobody else.
    targets: [...pending.resolution.attackers],
  };
}

/**
 * Ships allowed to return fire against `targets`' attackers: each victim, plus
 * "any ships in the victim's hex and sharing its course".
 */
const counterattackCandidates = (state: GameState, victims: readonly ShipId[]): ShipId[] => {
  const advanced = state.options.advancedCombat;
  const out: ShipId[] = [];
  const seen = new Set<ShipId>();
  for (const id of victims) {
    const victim = state.ships[id];
    if (!victim || victim.destroyed) continue;
    for (const other of Object.values(state.ships)) {
      if (other.destroyed || seen.has(other.id)) continue;
      if (other.id !== id) {
        // Matched course: same position *and* same velocity.
        if (!eq(other.pos, victim.pos) || !eq(other.velocity, victim.velocity)) continue;
        if (!areAllied(state, controllerOf(other), controllerOf(victim))) continue;
      }
      if (!canFire(other, advanced)) continue;
      if (other.firedThisPhase) continue;
      seen.add(other.id);
      out.push(other.id);
    }
  }
  return out;
};

const applyPending = (state: GameState, pending: PendingAttack): GameState => {
  let next = state;
  for (const d of pending.damage) {
    next = d.advanced
      ? applyHitTotals(next, d.target, d.advanced, pending.cause, pending.by)
      : applyDamage(next, d.target, d.result, pending.cause, pending.by);
  }
  return next;
};

/**
 * Write the stored damage into the state and forget the pending attack. Safe to
 * call when nothing is pending (it returns the state untouched), so a phase-end
 * sweep can use it unconditionally.
 */
export function resolvePendingDamage(state: GameState): GameState {
  const pending = readPending(state);
  if (!pending) return state;
  return clearPending(applyPending(state, pending));
}

/** The defender waives return fire; the stored damage lands as rolled. */
export function declineCounterattack(state: GameState): {
  state: GameState;
  result: CommandResult;
} {
  if (!readPending(state)) {
    return { state, result: { ok: false, reason: 'there is no attack to answer' } };
  }
  return { state: resolvePendingDamage(state), result: { ok: true } };
}

// ---------------------------------------------------------------------------
// Attack
// ---------------------------------------------------------------------------

const reject = (state: GameState, reason: string): { state: GameState; result: CommandResult } => ({
  state,
  result: { ok: false, reason },
});

const markFired = (state: GameState, ids: readonly ShipId[]): GameState => {
  let next = state;
  for (const id of ids) next = updateShip(next, id, { firedThisPhase: true });
  return next;
};

const markAttacked = (state: GameState, ids: readonly ShipId[]): GameState => {
  let next = state;
  for (const id of ids) next = updateShip(next, id, { attackedThisPhase: true });
  return next;
};

/**
 * Resolve a gunnery attack, deferring its damage so the victims can shoot back.
 *
 * See the module header for the full handshake. The one shortcut: when nobody is
 * in a position to return fire, the damage is applied immediately and no pending
 * record is created.
 */
export function resolveAttack(
  state: GameState,
  cmd: Attack,
  map: GameMap,
): { state: GameState; result: CommandResult } {
  // "Guns are fired during the combat phase."
  if (state.phase !== 'combat') return reject(state, 'guns may only be fired in the combat phase');
  if (hasPendingAttack(state)) {
    return reject(state, 'the outstanding counterattack must be answered first');
  }
  // "Only ships of the phasing player may initiate attacks."
  if (cmd.by !== activePlayer(state)) {
    return reject(state, 'only the phasing player may initiate attacks');
  }
  for (const id of cmd.attackers) {
    const ship = state.ships[id];
    if (!ship) return reject(state, `unknown ship ${id}`);
    if (!areAllied(state, cmd.by, controllerOf(ship))) {
      return reject(state, `${shipLabel(ship)} does not belong to you`);
    }
  }

  const preview = previewAttack(state, cmd.attackers, cmd.targets, map, cmd.strength, 'attack');
  if (!preview.legal) return reject(state, preview.reason ?? 'illegal attack');

  const attackerShips = cmd.attackers.map((id) => state.ships[id]!).filter(Boolean);
  const cause = `gunfire from ${listNames(attackerShips)}`;

  const rolled = rollGunAttack(state, preview, cmd.attackers, cmd.targets, 'gun');
  let next = rolled.state;

  // The once-per-phase flags are set the moment the attack is *made*, not when
  // its damage lands, so a deferred result cannot be shot at twice.
  next = markFired(next, cmd.attackers);
  next = markAttacked(next, cmd.targets);
  next = log(next, describeResolution(next, rolled.resolution, 'fire on'), {
    severity: rolled.severity > 0 ? 'warn' : 'info',
    focus: attackerShips.map((s) => s.pos),
  });

  // Heroism attaches to the *result*, which is achieved the moment the die is
  // thrown, so it is awarded here rather than when the damage is written back.
  if (heroismEarned(rolled.resolution.column, rolled.severity)) {
    next = awardHeroism(next, cmd.attackers);
  }

  const eligible = counterattackCandidates(next, cmd.targets);
  const pending: PendingAttack = {
    by: cmd.by,
    resolution: rolled.resolution,
    damage: rolled.damage,
    eligible,
    cause,
  };

  if (eligible.length === 0) {
    // No return fire is possible, so there is nothing to wait for.
    return { state: applyPending(next, pending), result: { ok: true } };
  }
  return { state: writePending(next, pending), result: { ok: true } };
}

// ---------------------------------------------------------------------------
// Counterattack
// ---------------------------------------------------------------------------

/**
 * Resolve return fire, then implement both sets of damage.
 *
 * "Odds are recomputed, rounded in favor of the new defender, and new values for
 * range and relative velocity are determined" — which is just `previewAttack`
 * again with the roles swapped, because `oddsColumn` always rounds toward
 * whoever is defending in the ratio it is handed.
 *
 * Crucially the counterattack is rolled against the *undamaged* attackers: the
 * pending damage has not been written yet, so combat strengths are still whole.
 */
export function resolveCounterattack(
  state: GameState,
  cmd: Counterattack,
  map: GameMap,
): { state: GameState; result: CommandResult } {
  const pending = readPending(state);
  if (!pending) return reject(state, 'there is no attack to answer');
  if (cmd.attackers.length === 0) return reject(state, 'no ships were named to return fire');

  for (const id of cmd.attackers) {
    const ship = state.ships[id];
    if (!ship) return reject(state, `unknown ship ${id}`);
    if (!areAllied(state, cmd.by, controllerOf(ship))) {
      return reject(state, `${shipLabel(ship)} does not belong to you`);
    }
    if (!pending.eligible.includes(id)) {
      // "Any ships in the victim's hex and sharing its course may participate."
      return reject(state, `${shipLabel(ship)} may not join this counterattack`);
    }
  }
  for (const id of cmd.targets) {
    if (!pending.resolution.attackers.includes(id)) {
      const ship = state.ships[id];
      return reject(
        state,
        `${ship ? shipLabel(ship) : id} did not take part in the attack and may not be returned fire on`,
      );
    }
  }

  const preview = previewAttack(
    state,
    cmd.attackers,
    cmd.targets,
    map,
    cmd.strength,
    'counterattack',
  );
  if (!preview.legal) return reject(state, preview.reason ?? 'illegal counterattack');

  const returnFire = cmd.attackers.map((id) => state.ships[id]!).filter(Boolean);
  const cause = `return fire from ${listNames(returnFire)}`;

  const rolled = rollGunAttack(state, preview, cmd.attackers, cmd.targets, 'gun');
  let next = rolled.state;

  next = markFired(next, cmd.attackers);
  next = markAttacked(next, cmd.targets);
  next = log(next, describeResolution(next, rolled.resolution, 'return fire on'), {
    severity: rolled.severity > 0 ? 'warn' : 'info',
    player: cmd.by,
    focus: returnFire.map((s) => s.pos),
  });

  if (heroismEarned(rolled.resolution.column, rolled.severity)) {
    next = awardHeroism(next, cmd.attackers);
  }

  // Both results were computed against the same pre-damage state, so the order
  // they are written back in cannot change either outcome.
  next = applyPending(next, pending);
  next = clearPending(next);
  for (const d of rolled.damage) {
    next = d.advanced
      ? applyHitTotals(next, d.target, d.advanced, cause, cmd.by)
      : applyDamage(next, d.target, d.result, cause, cmd.by);
  }

  return { state: next, result: { ok: true } };
}

// ---------------------------------------------------------------------------
// Planetary defences
// ---------------------------------------------------------------------------

/**
 * "Planetary bases may fire at enemy ships in the gravity hex directly above the
 * base's hex side. In a player's combat phase, each of that player's bases may
 * fire at all enemy ships in the gravity hex directly above it. The attack is
 * performed on the gunfire table using 2:1 odds, regardless of the target's
 * combat strength. There is no modification for range or relative velocity. All
 * other normal gunfire combat rules apply."
 *
 * Damage is applied at once: a counterattack needs something to shoot back at,
 * and a planet is not a target for guns — only nukes and hexside suppression
 * touch a world's surface.
 */
export function firePlanetaryDefence(
  state: GameState,
  cmd: FirePlanetaryDefence,
  map: GameMap,
): { state: GameState; result: CommandResult } {
  if (state.phase !== 'combat') {
    return reject(state, 'planetary defences fire in the combat phase');
  }
  if (hasPendingAttack(state)) {
    return reject(state, 'the outstanding counterattack must be answered first');
  }
  const base = state.bases[cmd.base];
  if (!base) return reject(state, `unknown base ${cmd.base}`);
  if (base.kind !== 'planetary')
    return reject(state, 'only planetary bases have planetary defences');
  if (base.destroyed) return reject(state, 'that base has been destroyed');
  if (!base.hasPlanetaryDefences) return reject(state, 'that base has no planetary defences');
  if (!base.side) return reject(state, 'that base is not on a hexside');
  if (base.owner === null || !areAllied(state, cmd.by, base.owner)) {
    return reject(state, 'that base is not yours');
  }
  // "In a player's combat phase, each of that player's bases may fire..."
  if (cmd.by !== activePlayer(state)) return reject(state, 'it is not your combat phase');
  if (base.firedThisTurn) return reject(state, 'that base has already fired this turn');
  // Note: a *suppressed* hexside does not silence the base — "The base on a
  // suppressed hexside is not affected."

  const hexAbove = sideGravityHex(base.side);
  const owner = base.owner;

  const inHex = Object.values(state.ships).filter(
    (s) => !s.destroyed && eq(s.pos, hexAbove) && enemyOf(state, owner, s),
  );
  const chosen = cmd.targets.length > 0 ? cmd.targets : inHex.map((s) => s.id);
  if (chosen.length === 0) return reject(state, 'no enemy ships in the gravity hex above the base');

  const targets: Ship[] = [];
  for (const id of chosen) {
    const ship = state.ships[id];
    if (!ship) return reject(state, `unknown ship ${id}`);
    if (ship.destroyed) return reject(state, `${shipLabel(ship)} has been destroyed`);
    if (!eq(ship.pos, hexAbove)) {
      return reject(state, `${shipLabel(ship)} is not in the gravity hex above the base`);
    }
    if (!enemyOf(state, owner, ship)) return reject(state, `${shipLabel(ship)} is not an enemy`);
    if (ship.attackedThisPhase) {
      return reject(state, `${shipLabel(ship)} has already been attacked this combat phase`);
    }
    targets.push(ship);
  }

  // "All other normal gunfire combat rules apply" — including line of sight.
  const blocker = map.lineOfSightBlockedBy(base.hex, hexAbove);
  if (blocker) return reject(state, `${blocker.name} blocks the line of fire`);

  const defenceStrength = targets.reduce((n, s) => n + combatStrength(s), 0);
  const preview: AttackPreview = {
    legal: true,
    // The odds are fixed at 2:1 "regardless of the target's combat strength";
    // the notional attack strength exists only so the log reads sensibly.
    attackStrength: defenceStrength * 2,
    defenceStrength,
    column: '2:1',
    range: 0,
    relativeVelocity: 0,
    modifiers: NO_MODIFIERS,
  };

  const ids = targets.map((s) => s.id);
  const rolled = rollGunAttack(state, preview, [base.id], ids, 'planetaryDefence');
  let next = rolled.state;
  next = markAttacked(next, ids);
  next = withBase(next, { ...base, firedThisTurn: true });
  next = log(
    next,
    `Planetary defences at ${base.id} open up on ${listNames(targets)}: roll ${rolled.resolution.roll} at 2:1.`,
    { severity: 'warn', focus: [hexAbove] },
  );

  const cause = `planetary defences at ${base.id}`;
  for (const d of rolled.damage) {
    next = d.advanced
      ? applyHitTotals(next, d.target, d.advanced, cause, owner)
      : applyDamage(next, d.target, d.result, cause, owner);
  }
  return { state: next, result: { ok: true } };
}

// ---------------------------------------------------------------------------
// Hexside suppression (Fleet Mutiny)
// ---------------------------------------------------------------------------

/** Where suppressed hexsides are recorded, keyed by `sideKey`. */
export const SUPPRESSED_SIDES_KEY = '_suppressedSides';

export const suppressedSides = (state: GameState): readonly string[] => {
  const raw = state.scenarioData[SUPPRESSED_SIDES_KEY];
  return Array.isArray(raw) ? (raw as string[]) : [];
};

export const isSideSuppressed = (state: GameState, side: HexSide): boolean =>
  suppressedSides(state).includes(sideKey(side));

/**
 * "Planetary hexsides may be suppressed for the remainder of the game by gunfire
 * from a ship orbiting overhead. A ship suppressing a hexside may not fire at
 * other targets that turn. Such suppression is automatic if a ship fires. The
 * base on a suppressed hexside is not affected."
 *
 * Suppression therefore needs no die roll — it is automatic — and it does not
 * disable the base underneath. `BaseState.suppressed` is set purely as a marker
 * for the scenario's victory count.
 */
export function suppressHexside(
  state: GameState,
  cmd: SuppressHexside,
  map: GameMap,
): { state: GameState; result: CommandResult } {
  if (state.phase !== 'combat') return reject(state, 'guns may only be fired in the combat phase');
  if (hasPendingAttack(state)) {
    return reject(state, 'the outstanding counterattack must be answered first');
  }
  const ship = state.ships[cmd.ship];
  if (!ship) return reject(state, `unknown ship ${cmd.ship}`);
  if (!areAllied(state, cmd.by, controllerOf(ship))) return reject(state, 'that ship is not yours');
  if (cmd.by !== activePlayer(state)) return reject(state, 'it is not your combat phase');
  if (!canFire(ship, state.options.advancedCombat)) {
    return reject(state, `${shipLabel(ship)} may not fire`);
  }
  // "A ship suppressing a hexside may not fire at other targets that turn."
  if (ship.firedThisPhase) {
    return reject(state, `${shipLabel(ship)} has already fired this combat phase`);
  }

  const body = map.bodyAt(cmd.side.hex);
  if (!body || body.landing !== 'hexside') {
    return reject(state, 'that hexside does not belong to a world');
  }
  // "...by gunfire from a ship orbiting overhead."
  const orbiting = map.orbitOf(ship.pos, ship.velocity);
  if (!orbiting || orbiting.id !== body.id) {
    return reject(state, `${shipLabel(ship)} is not in orbit around ${body.name}`);
  }
  if (!eq(ship.pos, sideGravityHex(cmd.side))) {
    return reject(state, 'the ship must be in the gravity hex directly above the hexside');
  }
  const k = sideKey(cmd.side);
  if (suppressedSides(state).includes(k)) {
    return reject(state, 'that hexside is already suppressed');
  }

  let next: GameState = {
    ...state,
    scenarioData: {
      ...state.scenarioData,
      [SUPPRESSED_SIDES_KEY]: [...suppressedSides(state), k],
    },
  };
  const site = map.planetaryBaseAt(cmd.side);
  if (site) {
    const base = next.bases[site.id];
    if (base && !base.suppressed) next = withBase(next, { ...base, suppressed: true });
  }
  next = updateShip(next, ship.id, { firedThisPhase: true });
  next = log(
    next,
    `${shipLabel(ship)} suppresses the ${body.name} hexside ${cmd.side.dir} from orbit.`,
    { severity: 'bad', focus: [ship.pos] },
  );
  return { state: next, result: { ok: true } };
}

// ---------------------------------------------------------------------------
// Damage control
// ---------------------------------------------------------------------------

export type RepairTrack = 'weapon' | 'drive' | 'structure';

/**
 * Can this track actually be worked on out here?
 *
 * "A ship whose weapons reach D6 or below can no longer repair them; it must get
 * back to a base", and the same for a drive at D6. Structure has no such ceiling
 * — a ship at D6 structure is already destroyed.
 */
export const repairable = (ship: Ship, track: RepairTrack): boolean => {
  const level = ship.advancedDamage[track];
  if (level <= 0) return false;
  return track === 'structure' || level < ADVANCED_TRACK_LIMIT;
};

/** The tracks this ship could be ordered to work on right now. */
export const repairableTracks = (ship: Ship): RepairTrack[] =>
  (['drive', 'weapon', 'structure'] as const).filter((t) => repairable(ship, t));

/**
 * Which track a ship's damage-control party works on this turn.
 *
 * "The owner chooses what kind of damage to recover from" — so an explicit
 * standing order wins whenever that track is still worth working on. Absent one,
 * the fallback is drive, then weapons, then structure: mobility first, because a
 * ship that cannot run cannot choose its next fight.
 */
export const repairTarget = (ship: Ship): RepairTrack | null => {
  const wanted = ship.repairPreference;
  if (wanted !== undefined && repairable(ship, wanted)) return wanted;
  return repairableTracks(ship)[0] ?? null;
};

/**
 * Record the owner's standing repair order.
 *
 * Deliberately permissive about *when*: this sets a preference, it does not
 * perform a repair, so ordering the yard about before the damage lands costs
 * nothing and stopping the game to ask would cost a lot.
 */
export function chooseRepair(
  state: GameState,
  cmd: { readonly by: PlayerId; readonly ship: ShipId; readonly track: RepairTrack },
): { state: GameState; result: CommandResult } {
  if (!state.options.advancedCombat) {
    return reject(state, 'damage tracks only exist under the advanced combat system');
  }
  const ship = state.ships[cmd.ship];
  if (!ship || ship.destroyed) return reject(state, `unknown ship ${cmd.ship}`);
  if (!areAllied(state, cmd.by, controllerOf(ship))) {
    return reject(state, 'that ship is not yours');
  }
  const next = log(
    updateShip(state, ship.id, { repairPreference: cmd.track }),
    `${shipLabel(ship)} sets damage control to work on the ${cmd.track}.`,
    { focus: [ship.pos] },
  );
  return { state: next, result: { ok: true } };
}

/**
 * "A damaged ship will repair itself at the rate of one 'D' per turn. It recovers
 * at the end of the Resupply phase."
 *
 * Tracks that have reached D6 are skipped: weapons at D6 "can no longer [be
 * repaired]... it must get back to a base", and a drive at D6 "may not be
 * repaired". Which track gets the turn's work is `repairTarget`'s decision.
 *
 * Keyed on `controllerOf`, not `owner`: the prize crew aboard a captured hull is
 * the one holding the welding torch.
 */
export function recoverDamage(state: GameState, player: PlayerId): GameState {
  let next = state;
  const advanced = state.options.advancedCombat;

  for (const ship of Object.values(state.ships)) {
    if (controllerOf(ship) !== player || ship.destroyed) continue;

    if (advanced) {
      const track = repairTarget(ship);
      if (track !== null) {
        const { weapon, drive, structure } = ship.advancedDamage;
        const patched = { weapon, drive, structure, [track]: ship.advancedDamage[track] - 1 };
        next = updateShip(next, ship.id, { advancedDamage: patched });
        continue;
      }
    }

    if (ship.disabled > 0) {
      const left = ship.disabled - 1;
      next = updateShip(next, ship.id, { disabled: left });
      if (left === 0) {
        next = log(next, `${shipLabel(ship)} completes repairs and is under way again.`, {
          severity: 'good',
          focus: [ship.pos],
        });
      }
    }
  }
  return next;
}

// ---------------------------------------------------------------------------
// Convenience for other modules
// ---------------------------------------------------------------------------

/** Live enemy ships sharing a hex — the natural target group for one attack. */
export const targetGroupIn = (state: GameState, where: Hex, attackerSide: PlayerId): Ship[] =>
  Object.values(state.ships).filter(
    (s) =>
      !s.destroyed &&
      eq(s.pos, where) &&
      enemyOf(state, attackerSide, s) &&
      !immuneToGunfire(s) &&
      !s.attackedThisPhase,
  );
