/**
 * Server-side redaction: what one player is allowed to know.
 *
 * Hot-seat and open-information play need none of this — every client can hold
 * the whole state, because every client is entitled to it. Fog of war is
 * different in kind: hiding a counter in the UI is not hiding it, because the
 * data is still on the machine. The only place a secret can actually be kept is
 * the server, which is why redaction lives here and not in the renderer.
 *
 * Three things get removed:
 *
 *  - **Undetected enemy ships.** Detection is the rulebook's own mechanic
 *    (p. 8): three hexes for ships and orbital bases, five for planetary bases,
 *    and once seen a ship stays seen "until it arrives at a friendly base".
 *  - **Enemy ordnance outside the detector net.** A mine nobody has spotted is
 *    the entire point of laying it.
 *  - **Scenario secrets.** Escape's designated fugitive transport, Lateral 7's
 *    dummy counters.
 *
 * A redacted state is still a valid `GameState`, so the client renders it with
 * no special cases.
 */

import type { GameMap } from '../engine/map.js';
import {
  type GameState,
  type Ordnance,
  type PlayerId,
  type Ship,
  areAllied,
  distance,
} from '../engine/index.js';
import { detectionSources, isDetected } from '../engine/detection.js';

/**
 * The `scenarioData` key scenarios use for hidden setup.
 *
 * Scenarios put their concealed choices under this key — see
 * `ESCAPE_SECRET_KEY`. Everything beneath it is withheld from players who are
 * not entitled to it; see {@link secretIsVisibleTo} for how that is decided.
 */
export const SECRET_KEY = 'secret';

/**
 * `scenarioData` key for ships a scenario makes visible regardless of detection.
 *
 * Shaped `Record<PlayerId, ShipId[]>`. Lateral 7 needs it: "Because ship
 * sailings are published, the pirate knows the location of the liner" — a fact
 * the detection rules alone would not produce. Each player is sent only their
 * own entry, so the list itself reveals nothing.
 */
export const ALWAYS_VISIBLE_KEY = 'alwaysVisible';

/** Every string appearing anywhere inside a value, however deeply nested. */
const collectStrings = (value: unknown, out: Set<string>, depth = 0): void => {
  if (depth > 8 || value == null) return;
  if (typeof value === 'string') {
    out.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out, depth + 1);
    return;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out.add(k);
      collectStrings(v, out, depth + 1);
    }
  }
};

/**
 * May `viewer` see a scenario secret?
 *
 * A secret is derived from the things it names. If it references ships, it
 * belongs to whoever owns them; if it names a player outright, it belongs to
 * them. Escape stores `{ fugitiveShip: <a Pilgrim transport> }`, so the Pilgrim
 * sees it and the Enforcer does not — which is exactly the scenario's intent —
 * and Lateral 7's dummy table resolves the same way for the pirate.
 *
 * A secret that names nothing identifiable is withheld from everyone, which is
 * the safe direction to fail in.
 */
export const secretIsVisibleTo = (
  state: GameState,
  secret: unknown,
  viewer: PlayerId,
): boolean => {
  const names = new Set<string>();
  collectStrings(secret, names);

  for (const name of names) {
    if (name === viewer) return true;
    const ship = state.ships[name];
    if (ship && ship.owner === viewer) return true;
  }
  // Either it names somebody else, or it names nobody identifiable. Both
  // withhold: failing closed is the only safe direction for a secret.
  return false;
};

/**
 * Does this value talk about other players' ships, and none of the viewer's?
 *
 * Used as a backstop on `scenarioData`. A value that names no ship at all —
 * prices, flags, turn limits — is public and passes through untouched.
 */
export const mentionsOnlyOtherPlayersShips = (
  state: GameState,
  value: unknown,
  viewer: PlayerId,
): boolean => {
  const names = new Set<string>();
  collectStrings(value, names);

  let sawForeignShip = false;
  for (const name of names) {
    const ship = state.ships[name];
    if (!ship) continue;
    if (ship.owner === viewer) return false; // it is at least partly ours
    sawForeignShip = true;
  }
  return sawForeignShip;
};

/**
 * Filter a table keyed by ship or player to the entries the viewer owns.
 *
 * Lateral 7 keeps `dummyAssignments`, mapping every real ship to the three
 * dummy counters that hide it — for *both* sides. Shipping that whole table
 * tells each player which of the enemy's counters are real, which is precisely
 * what the scenario conceals. Neither the plain secret rule nor the
 * foreign-ships backstop catches it, because the table legitimately names the
 * viewer's own ships too.
 *
 * Returns `null` when the value is not a table of this shape, so the caller can
 * fall through to its other rules.
 */
export const filterOwnedEntries = (
  state: GameState,
  value: unknown,
  viewer: PlayerId,
): Record<string, unknown> | null => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return null;

  // Only treat it as an ownership table if every key identifies somebody.
  const owned: Record<string, unknown> = {};
  for (const [k, v] of entries) {
    const ship = state.ships[k];
    const isPlayer = k in state.players;
    if (!ship && !isPlayer) return null;
    if (k === viewer || ship?.owner === viewer) owned[k] = v;
  }
  return owned;
};

/** Is this enemy ordnance inside the viewer's detector net? */
const ordnanceVisible = (
  state: GameState,
  o: Ordnance,
  viewer: PlayerId,
  map: GameMap,
): boolean => {
  if (areAllied(state, viewer, o.owner)) return true;
  for (const src of detectionSources(state, viewer, map)) {
    if (distance(src.hex, o.pos) <= src.range) return true;
  }
  return false;
};

/** Ships the scenario declares permanently visible to a given player. */
const alwaysVisibleTo = (state: GameState, viewer: PlayerId): ReadonlySet<string> => {
  const table = state.scenarioData[ALWAYS_VISIBLE_KEY];
  if (typeof table !== 'object' || table === null) return new Set();
  const list = (table as Record<string, unknown>)[viewer];
  return Array.isArray(list) ? new Set(list.filter((x): x is string => typeof x === 'string')) : new Set();
};

const shipVisible = (
  state: GameState,
  ship: Ship,
  viewer: PlayerId,
  always: ReadonlySet<string>,
): boolean => {
  if (areAllied(state, viewer, ship.owner)) return true;
  if (always.has(ship.id)) return true;
  return isDetected(state, ship, viewer);
};

/**
 * Produce the view of the game that `viewer` is entitled to.
 *
 * When the scenario is not playing with fog of war this is the identity
 * function, and the server can broadcast one state to everybody.
 */
export const redactState = (
  state: GameState,
  viewer: PlayerId | null,
  map: GameMap,
): GameState => {
  // A spectator of an open-information game sees everything; a spectator of a
  // fog game sees only what is public, which is what `null` falls through to.
  if (!state.options.fogOfWar) return state;

  const always = viewer === null ? new Set<string>() : alwaysVisibleTo(state, viewer);

  const ships: Record<string, Ship> = {};
  for (const [id, ship] of Object.entries(state.ships)) {
    // Destroyed ships stay in the record: their loss is public, and the log
    // already reports it.
    if (ship.destroyed || (viewer !== null && shipVisible(state, ship, viewer, always))) {
      ships[id] = ship;
    }
  }

  const ordnance: Record<string, Ordnance> = {};
  for (const [id, o] of Object.entries(state.ordnance)) {
    if (viewer !== null && ordnanceVisible(state, o, viewer, map)) ordnance[id] = o;
  }

  const scenarioData: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(state.scenarioData)) {
    // Each player receives only their own always-visible list.
    if (key === ALWAYS_VISIBLE_KEY) {
      if (viewer !== null && always.size > 0) scenarioData[key] = { [viewer]: [...always] };
      continue;
    }
    // The declared secret is withheld unless it belongs to this viewer.
    if (key === SECRET_KEY) {
      if (viewer !== null && secretIsVisibleTo(state, value, viewer)) {
        scenarioData[key] = value;
      }
      continue;
    }
    // A table keyed by ship or player is split, so each player receives only
    // their own rows.
    if (viewer !== null) {
      const owned = filterOwnedEntries(state, value, viewer);
      if (owned !== null) {
        if (Object.keys(owned).length > 0) scenarioData[key] = owned;
        continue;
      }
    }
    // Safety net. A scenario that names *other players'* ships in plain
    // scenarioData leaks by construction, and the leak can be worse than the
    // secret it was hiding: Escape's decoy list named two of three transports,
    // handing the Enforcer the fugitive by elimination. Any entry that talks
    // only about ships the viewer does not own is withheld.
    if (viewer !== null && mentionsOnlyOtherPlayersShips(state, value, viewer)) continue;
    scenarioData[key] = value;
  }

  return { ...state, ships, ordnance, scenarioData };
};

/**
 * Does a command come from the player it claims to?
 *
 * The one check a relay cannot skip. Without it any client can end another
 * player's turn, fire their guns, or scuttle their ordnance, because `by` is
 * just a string in a JSON frame.
 */
export const commandIsAuthorised = (
  seat: PlayerId | null,
  commandBy: PlayerId,
): boolean => seat !== null && seat === commandBy;
