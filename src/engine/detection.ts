/**
 * Detectors.
 *
 * "All ships and bases have detectors which enable them to determine the
 * position of other ships. Detectors on ships and orbital bases (including Ceres
 * and Clandestine) have a range of three hexes; detectors on planetary bases
 * have a range of five hexes."
 *
 * Two things make this more than a distance check.
 *
 * First, detection *sticks*: "Once a ship has been detected by the enemy, it
 * remains detected (regardless of range) until it arrives at a friendly base."
 * So this module only ever adds to `ship.detectedBy`; the clearing half of the
 * rule belongs to arrival, and lives in movement and logistics.
 *
 * Second, detection is per *player*, not global. A ship is a contact on one
 * side's plot and a blank hex on the other's, which is exactly what the fog of
 * war option needs, and why `detectedBy` is a list of players rather than a flag.
 */

import { type Hex, distance, eq, key, withinRadius } from './hex.js';
import { type GameMap, DETECTION_RANGE_PLANETARY_BASE, DETECTION_RANGE_SHIP } from './map.js';
import { shipLabel } from './movement.js';
import { log, withShip } from './state.js';
import {
  type BaseState,
  type GameState,
  type PlayerId,
  type Ship,
  areAllied,
  controllerOf,
} from './types.js';

/** Where a detector sits and how far it reaches. */
export interface DetectionSource {
  readonly hex: Hex;
  readonly range: number;
  readonly kind: 'ship' | 'base';
  /** Ship id or base id, so the UI can explain a contact. */
  readonly id: string;
}

/** "Detectors on ships and orbital bases... three hexes." */
export const detectionRangeOfShip = (): number => DETECTION_RANGE_SHIP;

/**
 * Planetary bases see five hexes; asteroid and orbital bases see three, Ceres and
 * Clandestine explicitly included.
 */
export const detectionRangeOfBase = (base: BaseState): number =>
  base.kind === 'planetary' ? DETECTION_RANGE_PLANETARY_BASE : DETECTION_RANGE_SHIP;

/**
 * "Ships which reach Clandestine drop off the detectors of the opposing side."
 *
 * The hiding place is the base hex itself — a ship stopped there is inside the
 * rock, not merely near it.
 */
export const hiddenAtClandestine = (state: GameState, ship: Ship, map: GameMap): boolean => {
  void state;
  const body = map.body('clandestine');
  if (!body) return false;
  return eq(ship.pos, body.hex) && ship.location.kind !== 'space';
};

/**
 * Every detector working for this player.
 *
 * Bases only detect for their owner — an unclaimed base is nobody's eyes — while
 * allies pool their plots, which is what lets the Nova blocs share bases.
 */
export function detectionSources(
  state: GameState,
  viewer: PlayerId,
  map: GameMap,
): DetectionSource[] {
  void map;
  const out: DetectionSource[] = [];

  for (const ship of Object.values(state.ships)) {
    if (ship.destroyed) continue;
    // A prize is flown by its captor, so it watches for the captor.
    if (!areAllied(state, viewer, controllerOf(ship))) continue;
    out.push({ hex: ship.pos, range: detectionRangeOfShip(), kind: 'ship', id: ship.id });
  }

  for (const base of Object.values(state.bases)) {
    if (base.destroyed || base.owner === null) continue;
    if (!areAllied(state, viewer, base.owner)) continue;
    // Suppression silences a hexside's guns, not its radar: "The base on a
    // suppressed hexside is not affected."
    out.push({ hex: base.hex, range: detectionRangeOfBase(base), kind: 'base', id: base.id });
  }

  return out;
}

/** Every hex this player's detectors cover — the renderer's detection field. */
export function detectionField(state: GameState, viewer: PlayerId, map: GameMap): Hex[] {
  const seen = new Set<string>();
  const out: Hex[] = [];
  for (const source of detectionSources(state, viewer, map)) {
    for (const h of withinRadius(source.hex, source.range)) {
      const k = key(h);
      if (seen.has(k) || !map.inBounds(h)) continue;
      seen.add(k);
      out.push(h);
    }
  }
  return out;
}

/**
 * Can this player see that ship?
 *
 * Your own ships and your allies' are never hidden from you; everyone else has
 * to have been picked up at some point — "once... detected... it remains
 * detected (regardless of range)".
 */
export function isDetected(state: GameState, ship: Ship, viewer: PlayerId): boolean {
  if (ship.destroyed) return false;
  // Whoever *flies* the ship sees it. A captured prize has changed hands, so its
  // original owner has to find it again like any other enemy contact.
  if (areAllied(state, viewer, controllerOf(ship))) return true;
  return ship.detectedBy.includes(viewer);
}

/** What a player may legitimately look at, for fog of war. */
export function visibleShips(state: GameState, viewer: PlayerId): Ship[] {
  return Object.values(state.ships).filter((s) => !s.destroyed && isDetected(state, s, viewer));
}

/** Is `target` within range of any of `viewer`'s detectors right now? */
export function inDetectorRange(
  state: GameState,
  target: Ship,
  viewer: PlayerId,
  map: GameMap,
): boolean {
  for (const source of detectionSources(state, viewer, map)) {
    // A detector never picks up the ship it is bolted to.
    if (source.kind === 'ship' && source.id === target.id) continue;
    if (distance(source.hex, target.pos) <= source.range) return true;
  }
  return false;
}

/**
 * Sweep every player's detectors and record the contacts.
 *
 * Detection is monotone here: this function never *un*-detects anything, because
 * the rule that ends a contact is arrival at a friendly base, not distance.
 * Guns are their own beacon — a ship that has fired this phase has announced
 * itself to everyone who could have seen the flash, which is the assumption
 * behind the Grand Tour's "firing while in detection range of a world" penalty.
 */
export function updateDetection(state: GameState, map: GameMap): GameState {
  let s = state;

  for (const viewer of state.playerOrder) {
    const sources = detectionSources(s, viewer, map);
    if (sources.length === 0) continue;

    for (const id of Object.keys(s.ships).sort()) {
      const ship = s.ships[id];
      if (!ship || ship.destroyed) continue;
      if (areAllied(s, viewer, controllerOf(ship))) continue;
      if (ship.detectedBy.includes(viewer)) continue;
      if (hiddenAtClandestine(s, ship, map)) continue;

      let spotted = false;
      for (const source of sources) {
        if (distance(source.hex, ship.pos) <= source.range) {
          spotted = true;
          break;
        }
      }
      // "Such suppression is automatic if a ship fires" is a different rule, but
      // the principle is the same: firing gives a ship away.
      if (!spotted && ship.firedThisPhase) spotted = true;
      if (!spotted) continue;

      s = withShip(s, { ...ship, detectedBy: [...ship.detectedBy, viewer] });
      s = log(s, `${shipLabel(ship)} is detected by ${s.players[viewer]?.name ?? viewer}.`, {
        severity: 'warn',
        player: viewer,
        focus: [ship.pos],
      });
    }
  }

  return s;
}
