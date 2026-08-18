/**
 * What the computer is actually trying to do.
 *
 * The general policy — repair, take prizes, hunt — is right for a battle and
 * completely wrong for a race. Bi-Planetary is won by landing on the other
 * world; the Grand Tour by passing every full-gravity body and coming home. An
 * opponent that spent those scenarios chasing your corvette around would not be
 * playing them at all.
 *
 * So this module is the computer's briefing book. It reads the scenario's own
 * published data — the same `scenarioData` keys the scenarios already write for
 * their victory checks — and turns them into an errand for a particular ship.
 * Nothing here reaches into `src/scenarios`: a scenario states its terms in
 * data, and the AI reads them, which keeps the scenario table free of any
 * knowledge that a computer might be playing it.
 *
 * Scenarios with no errand fall through to `null`, and the general policy takes
 * over. That is the right answer for the fighting scenarios — Lateral 7, Nova,
 * Retribution, Fleet Mutiny, Interplanetary War — where hunting the enemy *is*
 * the objective.
 */

import {
  type GameMap,
  type GameState,
  type Hex,
  type HexSide,
  type PlayerId,
  type Ship,
  MARKETS,
  baseBodyId,
  baseIsFriendly,
  cargoCount,
  cargoSpace,
  controllerOf,
  distance,
  hasScanners,
  key,
  prospectingEnabled,
  sideKey,
  traceSegment,
} from '../engine/index.js';

/** Where this ship is meant to be, and what it does when it gets there. */
export interface Errand {
  readonly hex: Hex;
  /** Set when the destination is a world rather than a bare hex. */
  readonly bodyId?: string;
  /** The errand is only complete once the ship is down. */
  readonly land: boolean;
  /**
   * Arrive slowly. "Any ship may prospect by passing through an asteroid hex at
   * a speed of 1" — the one errand where going faster does not get there sooner.
   */
  readonly cruise?: boolean;
  readonly why: string;
}

/**
 * "Combat is not allowed."
 *
 * The Grand Tour says so outright, and its combat variant only punishes the
 * player who opens fire — "self-defence is allowed; a racer is not disqualified
 * for counterattacking on the turn of attack" — so this suppresses attacks and
 * leaves return fire alone.
 */
export const combatForbidden = (state: GameState): boolean =>
  state.scenarioData['combatForbidden'] === true;

const stringTable = (value: unknown): Record<string, string> => {
  if (typeof value !== 'object' || value === null) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
};

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [];

/**
 * Every body whose gravity this ship has already flown through.
 *
 * "Each ship must pass through at least one gravity hex" of each world —
 * entered, not merely skimmed along the edge of — so the test walks the hexes
 * the trail actually entered, exactly as the Grand Tour's victory check does.
 */
export const bodiesVisited = (ship: Ship, map: GameMap): Set<string> => {
  const seen = new Set<string>();
  for (const leg of ship.course) {
    for (const h of traceSegment(leg.from, leg.to).entered) {
      for (const src of map.gravityAt(h)) seen.add(src.bodyId);
    }
  }
  return seen;
};

/**
 * The errand this ship is on, or `null` when the scenario sets none.
 */
export const errandFor = (state: GameState, ship: Ship, map: GameMap): Errand | null => {
  const me: PlayerId = controllerOf(ship);

  // Bi-Planetary: "each player must navigate to the other world and land."
  const targets = stringTable(state.scenarioData['targets']);
  const target = targets[me];
  const targetBody = target === undefined ? undefined : map.body(target);
  if (targetBody) {
    return {
      hex: targetBody.hex,
      bodyId: targetBody.id,
      land: true,
      why: 'reach the target world',
    };
  }

  // Prospecting: dig the Belt, then run the ore to market.
  if (prospectingEnabled(state)) {
    const prospect = prospectingErrand(state, ship, map);
    if (prospect !== null) return prospect;
  }

  // The Grand Tour: every full-gravity body, then home again.
  const required = stringList(state.scenarioData['requiredBodies']);
  if (required.length > 0) {
    const home = stringTable(state.scenarioData['startWorlds'])[me] ?? 'terra';
    const seen = bodiesVisited(ship, map);
    const remaining = required
      .filter((id) => !seen.has(id) && map.body(id) !== undefined)
      .sort((a, b) => {
        const da = distance(ship.pos, map.body(a)!.hex);
        const db = distance(ship.pos, map.body(b)!.hex);
        return da - db || a.localeCompare(b);
      });
    const next = remaining[0];
    if (next !== undefined) {
      // A pass counts; there is no need to stop, and stopping costs turns.
      return {
        hex: map.body(next)!.hex,
        bodyId: next,
        land: false,
        why: 'round the next body on the tour',
      };
    }
    // "A ship completes the tour by landing at its home world" — the one leg
    // that has to end on the ground.
    const homeBody = map.body(home);
    if (homeBody) {
      return { hex: homeBody.hex, bodyId: homeBody.id, land: true, why: 'come home and land' };
    }
  }

  return null;
};

// ---------------------------------------------------------------------------
// Prospecting
// ---------------------------------------------------------------------------

/**
 * "Ore may be sold at Ceres (MCr 2 per ton) or at Luna (MCr 3 per ton)."
 *
 * Luna pays half again as much, and a Belt-to-Luna run is a long haul, so the
 * pilot takes whichever is closer rather than always chasing the better price —
 * turns are the scarce thing in a scenario with a clock.
 */
const nearestMarket = (state: GameState, ship: Ship, map: GameMap): Hex | null => {
  const me = controllerOf(ship);
  let best: Hex | null = null;
  let bestDistance = Infinity;
  for (const base of Object.values(state.bases)) {
    if (base.destroyed) continue;
    if (MARKETS[baseBodyId(base, map)] === undefined) continue;
    if (!baseIsFriendly(state, base, me)) continue;
    const d = distance(ship.pos, base.hex);
    if (d < bestDistance || (d === bestDistance && best !== null && key(base.hex) < key(best))) {
      bestDistance = d;
      best = base.hex;
    }
  }
  return best;
};

/** Tons of ore and shards aboard — the reason to head for a market. */
const saleable = (ship: Ship): number => cargoCount(ship, 'ore') + cargoCount(ship, 'ctShard');

/**
 * What a prospector does next.
 *
 * "Any ship may prospect by passing through an asteroid hex at a speed of 1", so
 * the whole business is a slow trawl of unexamined rock, punctuated by hauls to
 * market. The pilot keeps trawling until the hold is worth emptying — a run to
 * Ceres with a tenth of a ton aboard is a wasted fortnight.
 */
const prospectingErrand = (state: GameState, ship: Ship, map: GameMap): Errand | null => {
  const hold = saleable(ship);
  const full = cargoSpace(ship) <= 0;
  if (hold > 0 && (full || hold >= MIN_WORTH_HAULING)) {
    const market = nearestMarket(state, ship, map);
    if (market) {
      return { hex: market, bodyId: map.bodyAt(market)?.id, land: false, why: 'sell the ore' };
    }
  }

  const cleared = new Set(state.clearedAsteroids);
  let best: Hex | null = null;
  let bestDistance = Infinity;
  for (const k of map.belt.asteroids) {
    if (state.prospected[k] !== undefined) continue; // "each hex may only be prospected once"
    const h = parseKey(k);
    if (h === null || cleared.has(k)) continue;
    // "Only ships possessing scanners may enter those hexes. Other ships are
    // destroyed" — the cordon around Clandestine is not a prospecting ground.
    if (map.isDenseAsteroid(h, cleared) && !hasScanners(state, ship)) continue;
    const d = distance(ship.pos, h);
    if (d < bestDistance || (d === bestDistance && best !== null && k < key(best))) {
      bestDistance = d;
      best = h;
    }
  }
  if (best === null) return null;
  return { hex: best, land: false, cruise: true, why: 'prospect a fresh hex' };
};

/** Below this the haul is not worth the turns; see {@link prospectingErrand}. */
const MIN_WORTH_HAULING = 1;

const parseKey = (k: string): Hex | null => {
  const parts = k.split(',');
  if (parts.length !== 2) return null;
  const q = Number(parts[0]);
  const r = Number(parts[1]);
  return Number.isFinite(q) && Number.isFinite(r) ? { q, r } : null;
};

/**
 * A hexside of `bodyId` this ship could actually put down on.
 *
 * Prefers a base — "boosters are available only at friendly bases", so a ship
 * that lands anywhere else is stranded — and skips any hexside a nuke has
 * devastated, which the engine would refuse anyway.
 */
export const landingSideAt = (
  state: GameState,
  bodyId: string,
  map: GameMap,
  me: PlayerId,
): HexSide | null => {
  const sides = Object.values(state.bases)
    .filter((b) => !b.destroyed && b.kind === 'planetary' && b.side !== undefined)
    .filter((b) => map.bodyAt(b.side!.hex)?.id === bodyId)
    .filter((b) => !state.devastatedSides.includes(sideKey(b.side!)))
    .sort(
      (a, b) =>
        // Ours first, then a neutral pad, then anyone's — with a stable tiebreak.
        Number(b.owner === me) - Number(a.owner === me) ||
        Number(b.owner === null) - Number(a.owner === null) ||
        sideKey(a.side!).localeCompare(sideKey(b.side!)),
    );
  return sides[0]?.side ?? null;
};
