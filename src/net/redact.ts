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
import { shipLabel } from '../engine/movement.js';

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

/**
 * `scenarioData` key naming other keys that are published verbatim.
 *
 * The filters below fail closed, which is right for a secret and wrong for an
 * announcement. Piracy's delivery board is the case: "The Merchant must announce
 * the destination when a ship takes off", and the player who most needs to hear
 * it is the pirate, who owns none of the ships it names — so every ownership
 * rule here would withhold exactly the wrong thing. A scenario that publishes
 * something says so, by name, once.
 */
export const PUBLIC_KEYS_KEY = 'publicKeys';

/**
 * The generator state a sealed view carries: none.
 *
 * "Every die roll in the game goes through here. The generator's entire state is
 * a single 32-bit integer carried inside `GameState`" — which is exactly the
 * problem once the table is open to strangers. A client holding the real
 * generator can compute the next roll before deciding whether to fire, and no
 * amount of fog hides it, because the number is right there in the state the
 * fog is wrapped around.
 *
 * So a state going over the wire has its generator sealed. In an authoritative
 * game the value is meaningless anyway: the referee draws a fresh, unguessable
 * seed for every command and records it in the log, so the number sitting in
 * the stored state between commands is never the number a roll will use. See
 * {@link sealDie}.
 */
export const SEALED_RNG = 0;

const publicKeys = (state: GameState): ReadonlySet<string> => {
  const raw = state.scenarioData[PUBLIC_KEYS_KEY];
  return Array.isArray(raw)
    ? new Set(raw.filter((x): x is string => typeof x === 'string'))
    : new Set();
};

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
export const secretIsVisibleTo = (state: GameState, secret: unknown, viewer: PlayerId): boolean => {
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

/**
 * Strike every mention of somebody else's ships out of a value, at any depth.
 *
 * The three rules above are shape rules: they recognise a secret, an ownership
 * table, a blob that talks only about the enemy. Between them they missed the
 * commonest shape in the game, and missed it silently for as long as fog of war
 * has existed.
 *
 * `movement.ts` parks its per-turn bookkeeping under `scenarioData.movement`,
 * whose keys are `paths`, `landing`, `rams` and `hazards` — not ship ids. So
 * `filterOwnedEntries` declines to split it, and `mentionsOnlyOtherPlayersShips`
 * lets it through because the viewer's own ships are in there too. The result
 * was that every seat in a fog game received `paths`: the hex-by-hex course, in
 * order, of every enemy ship it had never detected. The fog was drawn over a
 * board the client already held in full.
 *
 * A shape rule could not have caught that, so this is not one. It walks the
 * whole value and removes anything that names a ship the viewer may not see —
 * a key, an array element, or a string buried three levels down. Failing that
 * test drops the smallest enclosing entry, never the whole tree, so
 * `movement.paths` survives holding exactly the viewer's own courses.
 *
 * Ownership rather than detection is the test, deliberately. Lateral 7's dummy
 * assignments stay secret for a counter you have *detected*: knowing where a
 * ship is and knowing whether it is real are different facts, and only one of
 * them is what detection buys you.
 */
const REDACTED = Symbol('redacted');

const pruneForeignShips = (
  state: GameState,
  value: unknown,
  // Nullable on purpose. A spectator owns nothing, so `ship.owner !== viewer`
  // is true of every live ship and the whole tree is struck out — which is
  // exactly a spectator's entitlement at a fogged table, and the direction the
  // ships, ordnance and log filters already fail in.
  viewer: PlayerId | null,
): unknown => {
  if (typeof value === 'string') {
    const ship = state.ships[value];
    return ship && ship.owner !== viewer && !ship.destroyed ? REDACTED : value;
  }
  if (Array.isArray(value)) {
    return value
      .map((v) => pruneForeignShips(state, v, viewer))
      .filter((v) => v !== REDACTED);
  }
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const ship = state.ships[k];
      if (ship && ship.owner !== viewer && !ship.destroyed) continue;
      const pruned = pruneForeignShips(state, v, viewer);
      if (pruned !== REDACTED) out[k] = pruned;
    }
    return out;
  }
  return value;
};

/**
 * Drop the entries of the running commentary this seat could not have watched.
 *
 * The second hole, and the one that made the first one moot. `redactState`
 * filtered `ships`, `ordnance` and `scenarioData` and passed `state.log`
 * straight through — so a fog view carried the narration of the entire game:
 * every takeoff, plot, burn and landing of every enemy ship, by name, with the
 * hex printed in the sentence. Hiding a counter while narrating its course is
 * not hiding it.
 *
 * Detection is the test here, not ownership, because that is exactly what
 * detection is for: a ship you have found is a ship whose movements you may
 * watch. An entry naming nobody — "Day 5 begins", "Combat phase" — is public
 * and survives.
 *
 * Matching is on the ship's printed label rather than on structured metadata,
 * because `LogEntry` carries none: it is a sentence and a severity. That errs
 * towards dropping an entry it need not have (one ship's label can be a prefix
 * of another's) which is the safe direction, and the property test in
 * `tests/multiplayer.test.ts` is what holds it honest.
 */
const redactLog = (
  state: GameState,
  viewer: PlayerId | null,
  always: ReadonlySet<string>,
): GameState['log'] => {
  const hidden = Object.values(state.ships).filter(
    (ship) => !(viewer !== null && shipVisible(state, ship, viewer, always)) && !ship.destroyed,
  );
  if (hidden.length === 0) return state.log;
  const labels = hidden.map((ship) => shipLabel(ship));
  return state.log.filter(
    (entry) => !labels.some((label) => entry.text.includes(label)) && !hidden.some((s) => entry.text.includes(s.id)),
  );
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
  return Array.isArray(list)
    ? new Set(list.filter((x): x is string => typeof x === 'string'))
    : new Set();
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
 * Take the dice off the table before handing the state to a player.
 *
 * Unlike {@link redactState} this applies to *every* game, fogged or not. Fog
 * of war is about what is on the board; this is about what the board is going
 * to do next, and a player who can read the generator knows every roll before
 * making a decision. Sealing costs nothing, because the referee never rolls
 * with the state's own generator: it draws a fresh seed per command.
 */
export const sealDie = (state: GameState): GameState =>
  state.rng.seed === SEALED_RNG ? state : { ...state, rng: { seed: SEALED_RNG } };

/**
 * Produce the view of the game that `viewer` is entitled to.
 *
 * When the scenario is not playing with fog of war this is the identity
 * function, and the server can broadcast one state to everybody.
 */
export const redactState = (state: GameState, viewer: PlayerId | null, map: GameMap): GameState => {
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

  const published = publicKeys(state);

  const scenarioData: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(state.scenarioData)) {
    // Declared public: sent whole, to everybody, spectators included.
    if (key === PUBLIC_KEYS_KEY || published.has(key)) {
      scenarioData[key] = value;
      continue;
    }
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
    // And the general case the shape rules miss: strike out any mention of
    // somebody else's ships wherever it is buried.
    scenarioData[key] = pruneForeignShips(state, value, viewer);
  }

  return { ...state, ships, ordnance, scenarioData, log: redactLog(state, viewer, always) };
};

/**
 * Does a command come from the player it claims to?
 *
 * The one check a relay cannot skip. Without it any client can end another
 * player's turn, fire their guns, or launch their ordnance, because `by` is
 * just a string in a JSON frame.
 */
export const commandIsAuthorised = (seat: PlayerId | null, commandBy: PlayerId): boolean =>
  seat !== null && seat === commandBy;
