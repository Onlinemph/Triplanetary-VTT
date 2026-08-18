/**
 * A computer opponent.
 *
 * ## What it is
 *
 * A function from a game state to the next order. Nothing more: `nextCommand`
 * returns one ordinary `Command` — the same shape a human's click produces — or
 * `null` when it has nothing left to do and the phase should end. The driver
 * loops on it.
 *
 * That is the whole architecture, and it is what keeps everything else working.
 * The AI cannot cheat the rules, because every order it gives goes through
 * `applyCommand` and is refused on exactly the same terms as a player's. It
 * cannot break replay, because the orders land in the command log like any
 * others and a game replays into the identical position. It cannot desynchronise
 * a networked game, because it is a client that happens not to be a person.
 *
 * ## Determinism
 *
 * No `Math.random` and no `Date`. Every choice is a pure function of the state,
 * with ties broken on ship and hex order, so the same position always produces
 * the same order. A solo game is still reproducible from its seed and its log.
 *
 * ## It does not see through walls
 *
 * The driver hands the AI a *redacted* state when the scenario plays with fog of
 * war — the same view a human in that seat would get, with undetected ships and
 * scenario secrets removed. Detection is a real rule ("all ships and bases have
 * detectors", p. 8) and an opponent that ignored it would not be beating you at
 * Triplanetary. See `src/net/redact.ts`.
 *
 * ## What it is not
 *
 * It plans one turn at a time. It does not search, and it will not out-fly a
 * thoughtful human over a long approach. What it does reliably is fly without
 * crashing, close on a target it can actually catch, take fights worth taking,
 * decline fights that are not, and go home to refuel before it runs dry.
 */

import {
  type Command,
  type GameMap,
  type GameState,
  type Hex,
  type Ship,
  type PlayerId,
  DEFAULT_MAP,
  activePlayer,
  areAllied,
  baseWillSupply,
  canFire,
  canResupplyAt,
  cargoCount,
  cargoSpace,
  combatStrength,
  controllerOf,
  distance,
  forecastOf,
  hasUnlimitedFuel,
  heldForContact,
  immuneToGunfire,
  isDisabled,
  key,
  length,
  logisticsData,
  matchedShips,
  pendingCounterattack,
  pendingDevastation,
  previewAttack,
  fuelCapacity,
  isFixedInstallation,
  isLandingThisTurn,
  isTakingOffThisTurn,
  isZero,
  guardsAt,
  mineAt,
  minedThisTurn,
  prospectingEnabled,
  canTradeAt,
  legalCommands,
  cheapestDevastation,
} from '../engine/index.js';
import { brakingCourse, courseToward, isRunaway, orbitalCourse, safeCourses } from './navigate.js';
import { combatForbidden, errandFor, landingSideAt } from './objectives.js';

// ---------------------------------------------------------------------------
// Small readings of the position
// ---------------------------------------------------------------------------

const myShips = (state: GameState, me: PlayerId): Ship[] =>
  Object.values(state.ships)
    .filter((s) => !s.destroyed && controllerOf(s) === me)
    .sort((a, b) => a.id.localeCompare(b.id));

const enemies = (state: GameState, me: PlayerId): Ship[] =>
  Object.values(state.ships)
    .filter((s) => !s.destroyed && !areAllied(state, me, controllerOf(s)))
    .sort((a, b) => a.id.localeCompare(b.id));

/** Worth shooting at: an enemy that is not immune and has not been shot yet. */
const shootable = (state: GameState, me: PlayerId): Ship[] =>
  enemies(state, me).filter((s) => !immuneToGunfire(s) && !s.attackedThisPhase);

/**
 * How badly a ship needs a base.
 *
 * "Whenever a ship is refueled from a base, it automatically undergoes
 * maintenance. This repairs all remaining damage" — so a stop fixes fuel and
 * damage together, and a ship that is hurt *or* low is a ship that should be
 * heading home. A torch never needs fuel and only ever goes home for repairs.
 */
const needsBase = (ship: Ship): boolean => {
  if (ship.disabled > 0) return true;
  if (hasUnlimitedFuel(ship)) return false;
  // Enough left to turn onto a course home and then brake to a stop at the far
  // end, plus a little for corrections. A ship that waits until it is nearly
  // empty is a ship that arrives unable to stop — or does not arrive.
  const reserve = 3 + length(ship.velocity);
  return ship.fuel <= Math.max(reserve, Math.ceil(fuelCapacity(ship) * 0.25));
};

/**
 * The nearest base this ship could actually draw supply from.
 *
 * Not merely the nearest friendly one: a base that will sell this player nothing
 * is not worth crossing the map for. Grand Tour is the case in point — "fuel is
 * available only at bases on Terra, Venus, Mars, and Callisto", on a map where
 * every base is friendly to everybody.
 */
const nearestFriendlyBase = (state: GameState, ship: Ship, map: GameMap): Hex | null => {
  const me = controllerOf(ship);
  let best: Hex | null = null;
  let bestDistance = Infinity;
  for (const base of Object.values(state.bases)) {
    if (!baseWillSupply(state, base.id, me, map)) continue;
    const d = distance(ship.pos, base.hex);
    if (d < bestDistance || (d === bestDistance && best !== null && key(base.hex) < key(best))) {
      bestDistance = d;
      best = base.hex;
    }
  }
  return best;
};

/**
 * What this ship should be flying toward, and whether it wants to end up in
 * orbit there.
 *
 * The order matters and is the whole of the AI's strategy: fix yourself first,
 * then take a prize that is already helpless, then hunt.
 */
interface Goal {
  readonly hex: Hex;
  /** Body to end up orbiting, when the goal is a world. */
  readonly orbit?: string;
  /** Arrive at a walking pace — see {@link Errand.cruise}. */
  readonly cruise?: boolean;
  readonly why: 'repair' | 'errand' | 'prize' | 'hunt' | 'hold';
}

const goalFor = (state: GameState, ship: Ship, map: GameMap): Goal | null => {
  const me = controllerOf(ship);

  // 1. A ship that is hurt or nearly dry is no use to anybody. Go home.
  if (needsBase(ship)) {
    const home = nearestFriendlyBase(state, ship, map);
    if (home)
      return {
        hex: home,
        ...(map.bodyAt(home) ? { orbit: map.bodyAt(home)!.id } : {}),
        why: 'repair',
      };
  }

  // 2. The scenario's own errand, where it sets one. A race is not won by
  //    shooting at the other racer.
  const errand = errandFor(state, ship, map);
  if (errand !== null) {
    return {
      hex: errand.hex,
      ...(errand.land && errand.bodyId !== undefined ? { orbit: errand.bodyId } : {}),
      ...(errand.cruise === true ? { cruise: true } : {}),
      why: 'errand',
    };
  }

  // 3. A disabled enemy is a prize: "a disabled ship may be looted or captured
  //    by any enemy ship which matches courses with it." Free, if we can reach.
  const prizes = enemies(state, me).filter((s) => isDisabled(s, state.options.advancedCombat));
  const prize = prizes.sort(
    (a, b) => distance(ship.pos, a.pos) - distance(ship.pos, b.pos) || a.id.localeCompare(b.id),
  )[0];
  if (prize && distance(ship.pos, prize.pos) <= 12) {
    return { hex: prize.pos, why: 'prize' };
  }

  // 4. Otherwise hunt whatever is nearest and worth hitting. A ship with no guns
  //    hunts nothing — it keeps out of the way instead.
  if (canFire(ship, state.options.advancedCombat)) {
    const quarry = enemies(state, me).sort(
      (a, b) => distance(ship.pos, a.pos) - distance(ship.pos, b.pos) || a.id.localeCompare(b.id),
    )[0];
    if (quarry) return { hex: quarry.pos, why: 'hunt' };
  }

  // 5. Nothing to do but stay somewhere sensible.
  const home = nearestFriendlyBase(state, ship, map);
  return home ? { hex: home, why: 'hold' } : null;
};

// ---------------------------------------------------------------------------
// Astrogation
// ---------------------------------------------------------------------------

const astrogationOrder = (state: GameState, me: PlayerId, map: GameMap): Command | null => {
  for (const ship of myShips(state, me)) {
    if (isFixedInstallation(ship)) continue;
    // A scenario may pin a ship down until something happens ("the Enforcer
    // patrol may not move until the fugitives are detected").
    if (heldForContact(state, ship) !== null) continue;

    // Landed: lift off if there is anywhere to be. "Boosters are provided free
    // of charge" — a take-off costs nothing, so the only question is whether the
    // ship is done resting.
    if (ship.location.kind === 'landed') {
      if (isTakingOffThisTurn(state, ship.id)) continue; // boosters already readied
      if (needsBase(ship)) continue; // still repairing; stay put
      const errand = errandFor(state, ship, map);
      // A ship that has flown its errand and is down where it was sent stays
      // down: taking off again would only undo it.
      if (errand?.land === true && map.bodyAt(ship.location.side.hex)?.id === errand.bodyId) {
        continue;
      }
      // Otherwise fly. A ship on the ground can do nothing at all, and with fog
      // of war on it will often be unable to *see* an enemy — which is a reason
      // to go looking, not a reason to stay parked on the pad.
      return { type: 'takeOff', by: me, ship: ship.id };
    }
    if (isLandingThisTurn(state, ship.id)) continue; // already committed to the ground

    // Ore under the keel is worth more than another survey. "Mining takes place
    // on the movement phase, instead of movement" and "only a stationary ship
    // may mine", so the order comes before any course is plotted.
    const dig = miningOrder(state, ship, map);
    if (dig) return dig;

    if (ship.plottedEndpoint !== undefined) continue; // already ordered this turn

    // Always keep enough fuel to come to rest. Braking sheds one hex of speed
    // per turn and costs a point each time, so a ship whose fuel has fallen to
    // its speed can no longer stop — and "any ship whose final course places it
    // off the map is considered eliminated". Every racer this pilot has lost has
    // been lost that way, coasting to the rim with dry tanks.
    if (!hasUnlimitedFuel(ship) && ship.fuel <= length(ship.velocity)) {
      const brake = brakingCourse(state, ship, map);
      if (brake && key(brake.endpoint) !== key(predicted(state, ship, map))) {
        return { type: 'plotCourse', by: me, ship: ship.id, endpoint: brake.endpoint };
      }
    }

    const goal = goalFor(state, ship, map);
    if (goal === null) continue;

    // Down, if the errand ends on the ground and we are in orbit to do it.
    // "A ship may only land by expending one fuel point while in orbit."
    if (goal.orbit !== undefined) {
      const landing = landingOrder(state, ship, goal.orbit, map);
      if (landing) return landing;
    }

    // Arrived: if the goal is a world and we can drop into orbit, do that — an
    // orbit holds for free, and landing is only possible from one.
    if (goal.orbit !== undefined) {
      const orbit = orbitalCourse(state, ship, goal.orbit, map);
      if (orbit) {
        return { type: 'plotCourse', by: me, ship: ship.id, endpoint: orbit.endpoint };
      }
    }

    // Coming in too hot to stop is the commonest way to lose a ship. Brake.
    const course = isRunaway(ship, goal.hex)
      ? (brakingCourse(state, ship, map) ??
        courseToward(state, ship, goal.hex, map, goal.cruise === true))
      : courseToward(state, ship, goal.hex, map, goal.cruise === true);
    if (course === null) continue;

    // A course that changes nothing is not worth an order; leaving it unplotted
    // lets the ship coast, which is the same thing for free.
    if (course.accel === 0 && key(course.endpoint) === key(predicted(state, ship, map))) continue;
    return { type: 'plotCourse', by: me, ship: ship.id, endpoint: course.endpoint };
  }
  return null;
};

/**
 * Swing a pick, when there is anything under the ship worth digging.
 *
 * "Mining takes place on the movement phase, instead of movement... only a
 * stationary ship may mine", and the prospecting roll has already told everyone
 * whether the hex holds ore. A stopped ship over a proven claim has nothing
 * better to do with its turn.
 */
const miningOrder = (state: GameState, ship: Ship, map: GameMap): Command | null => {
  if (!prospectingEnabled(state)) return null;
  if (!isZero(ship.velocity)) return null;
  if (ship.disabled > 0) return null;
  if (minedThisTurn(state, ship.id)) return null;
  if (cargoSpace(ship) <= 0) return null;
  if (!map.isAsteroid(ship.pos, new Set(state.clearedAsteroids))) return null;

  const me = controllerOf(ship);
  const claim = guardsAt(state, ship.pos);
  if (claim !== undefined && !areAllied(state, claim, me)) return null;

  const site = mineAt(state, ship.pos);
  const stockpiled = site && areAllied(state, site.owner, me) ? site.stockpile : 0;
  if (state.prospected[key(ship.pos)] !== 'ore' && stockpiled <= 0) return null;
  return { type: 'mineOre', by: me, ship: ship.id };
};

/**
 * Put the ship down on `bodyId`, if it is in orbit there and meant to land.
 *
 * "A ship may only land by expending one fuel point while in orbit" — so this is
 * the one moment the order is available, and missing it costs a lap.
 */
const landingOrder = (
  state: GameState,
  ship: Ship,
  bodyId: string,
  map: GameMap,
): Command | null => {
  if (errandFor(state, ship, map)?.land !== true) return null;
  if (map.orbitOf(ship.pos, ship.velocity)?.id !== bodyId) return null;
  if (ship.fuel < 1 && !hasUnlimitedFuel(ship)) return null;
  const side = landingSideAt(state, bodyId, map, controllerOf(ship));
  if (side === null) return null;
  return { type: 'land', by: controllerOf(ship), ship: ship.id, side };
};

/** Where the ship goes if it burns nothing — the endpoint a no-op plot would pick. */
const predicted = (state: GameState, ship: Ship, map: GameMap): Hex => {
  const coasting = safeCourses(state, ship, map).find((o) => o.accel === 0);
  return coasting?.endpoint ?? ship.pos;
};

// ---------------------------------------------------------------------------
// Combat
// ---------------------------------------------------------------------------

/** What a group of ships is worth, for weighing a shot against the reply. */
const worth = (ships: readonly Ship[]): number => ships.reduce((n, s) => n + combatStrength(s), 0);

/**
 * The expected value of a shot, in enemy combat strength.
 *
 * A destroyed ship is worth all of it; a damaged one, half — it is out of the
 * fight for a while and may be looted, but it may also repair. Six faces, so the
 * odds are exact rather than sampled.
 */
const expectedGain = (
  state: GameState,
  attackers: readonly Ship[],
  targets: readonly Ship[],
  map: GameMap,
  mode: 'attack' | 'counterattack',
): number => {
  const preview = previewAttack(
    state,
    attackers.map((s) => s.id),
    targets.map((s) => s.id),
    map,
    undefined,
    mode,
  );
  if (!preview.legal) return -Infinity;
  const f = forecastOf(preview.column, preview.modifiers.total, targets);
  const value = worth(targets);
  return ((f.destroy + f.damage * 0.5) / 6) * value;
};

/**
 * Pick a shot worth taking.
 *
 * Two things make a shot bad, and the AI weighs both. The odds may simply be
 * hopeless — "attacks at worse than 1:4 have no effect" — and firing at all
 * invites the reply the rules guarantee: "ships which are attacked may return
 * fire against any or all of their attackers ... before any damage is
 * implemented." So the shot is weighed against the reply it buys.
 *
 * The threshold is *even*, not *ahead*, and that matters more than it looks.
 * Two identical warships in range make a perfectly symmetric exchange: what I
 * expect to destroy is exactly what I expect to lose. Insisting on a favourable
 * trade would have both ships decline forever and the battle would never happen,
 * which is not how anyone plays. Declining is not free either — the enemy simply
 * fires on their turn and I return fire instead, the same exchange with the
 * initiative handed over. Only a shot that is expected to lose the exchange is
 * refused.
 */
const combatOrder = (state: GameState, me: PlayerId, map: GameMap): Command | null => {
  // "Combat is not allowed." The Grand Tour means it; return fire is handled
  // separately and stays available, as its own variant rule insists.
  if (combatForbidden(state)) return null;
  const guns = myShips(state, me).filter(
    (s) =>
      canFire(s, state.options.advancedCombat) &&
      !s.firedThisPhase &&
      // "No ship may fire its guns or launch ordnance during a player-turn in
      // which it resupplies." A ship that is sitting at a base needing repair or
      // fuel is about to take the stopover, and the stopover is worth more than
      // one shot — so it holds its fire rather than spending the turn.
      !(needsBase(s) && canResupplyAt(state, s, map).ok),
  );
  if (guns.length === 0) return null;

  // Target groups are hexes: "if more than one ship occupies a hex, the attacker
  // may attack one, some, or all of them in one attack."
  const hexes = new Map<string, Ship[]>();
  for (const foe of shootable(state, me)) {
    const k = key(foe.pos);
    hexes.set(k, [...(hexes.get(k) ?? []), foe]);
  }

  interface Shot {
    readonly attackers: readonly Ship[];
    readonly targets: readonly Ship[];
    readonly net: number;
  }
  const consider = (attackers: readonly Ship[], targets: readonly Ship[]): Shot | null => {
    const gain = expectedGain(state, attackers, targets, map, 'attack');
    if (gain <= 0) return null;

    // What comes back — and it comes back at *everyone who fired*. One die
    // decides a gun attack and its result "applies to all target ships", so a
    // fleet that pools its fire is a fleet that can be wiped out by one face of
    // the counterattack. That is the real cost of massing, and it is why the
    // pilot tries small groups before large ones.
    const defenders = targets.filter(
      (t) => canFire(t, state.options.advancedCombat) && !t.firedThisPhase,
    );
    const reply =
      defenders.length === 0
        ? 0
        : Math.max(0, expectedGain(state, defenders, attackers, map, 'counterattack'));

    return { attackers, targets, net: gain - reply };
  };

  let best: Shot | null = null;

  for (const group of [...hexes.values()].sort((a, b) => a[0]!.id.localeCompare(b[0]!.id))) {
    // Both readings of "one, some, or all of them": the whole hex in one attack,
    // and each ship picked off alone. A lone target has a lower defence total and
    // so a better column; the whole hex dies together on an E.
    const targetSets: Ship[][] = group.length > 1 ? [group, ...group.map((t) => [t])] : [group];

    for (const targets of targetSets) {
      // "Any number of ships may combine their fire", but the number is a
      // decision, not a formality. Strongest first, then take prefixes: the
      // smallest group that reaches a good column risks the least in reply.
      const able = guns
        .filter(
          (g) =>
            previewAttack(
              state,
              [g.id],
              targets.map((t) => t.id),
              map,
            ).legal,
        )
        .sort((a, b) => combatStrength(b) - combatStrength(a) || a.id.localeCompare(b.id));
      for (let n = 1; n <= able.length; n += 1) {
        const shot = consider(able.slice(0, n), targets);
        if (shot !== null && (best === null || shot.net > best.net)) best = shot;
      }
    }
  }

  if (best === null || best.net < 0) return null;
  return {
    type: 'attack',
    by: me,
    attackers: best.attackers.map((s) => s.id),
    targets: best.targets.map((s) => s.id),
  };
};

/**
 * Answer return fire that is owed to us.
 *
 * "Ships which are attacked may return fire against any or all of their
 * attackers." Almost always worth it — the damage is already rolled and holding
 * fire buys nothing — but the AI checks anyway, because a ship that has
 * surrendered to one of the attackers may not fire on it and a hopeless shot is
 * still hopeless.
 */
const counterattackOrder = (state: GameState, me: PlayerId, map: GameMap): Command | null => {
  const pending = pendingCounterattack(state);
  if (pending === null) return null;

  const mine = pending.attackers
    .map((id) => state.ships[id])
    .filter((s): s is Ship => s !== undefined && !s.destroyed && controllerOf(s) === me);
  if (mine.length === 0) return null;

  const marks = pending.targets
    .map((id) => state.ships[id])
    .filter((s): s is Ship => s !== undefined && !s.destroyed);

  if (marks.length > 0) {
    const preview = previewAttack(
      state,
      mine.map((s) => s.id),
      marks.map((s) => s.id),
      map,
      undefined,
      'counterattack',
    );
    const f = preview.legal ? forecastOf(preview.column, preview.modifiers.total, marks) : null;
    if (f !== null && f.destroy + f.damage > 0) {
      return {
        type: 'counterattack',
        by: me,
        attackers: mine.map((s) => s.id),
        targets: marks.map((s) => s.id),
      };
    }
  }
  return { type: 'declineCounterattack', by: me };
};

/**
 * Answer a surrender demand.
 *
 * "Surrender is a binding bargain. Both parties agree not to attack the other
 * specific ship." That makes it a genuine bargain rather than a defeat: a ship
 * that cannot shoot back gains a permanent truce with the one gun pointed at it
 * and loses nothing it was still using. So the AI strikes it when the ship is
 * out of the fight — disabled, or gunless — and refuses otherwise. A ship that
 * can still fire has something to lose by promising not to.
 */
const surrenderOrder = (state: GameState, me: PlayerId, map: GameMap): Command | null => {
  if (!legalCommands(state, me, map).includes('respondToSurrender')) return null;
  const demands = logisticsData(state).demands;

  for (const ship of myShips(state, me)) {
    const from = demands[ship.id];
    if (from === undefined || from.length === 0) continue;
    const to = [...from].sort((a, b) => a.localeCompare(b))[0]!;
    const helpless =
      isDisabled(ship, state.options.advancedCombat) ||
      !canFire(ship, state.options.advancedCombat);
    return { type: 'respondToSurrender', by: me, ship: ship.id, to, accept: helpless };
  }
  return null;
};

// ---------------------------------------------------------------------------
// Resupply
// ---------------------------------------------------------------------------

const resupplyOrder = (state: GameState, me: PlayerId, map: GameMap): Command | null => {
  for (const ship of myShips(state, me)) {
    // Take the prize first: "a disabled ship may be looted or captured by any
    // enemy ship which matches courses with it." A disabled captor is not
    // eligible — it "cannot maneuver", so it cannot board anything.
    if (isDisabled(ship, state.options.advancedCombat)) continue;
    for (const other of matchedShips(state, ship)) {
      if (areAllied(state, me, controllerOf(other))) continue;
      if (!isDisabled(other, state.options.advancedCombat)) continue;
      if (other.capturedBy !== undefined) continue;
      // "Surrender is a binding bargain" — a ship that struck one is not a prize.
      if (other.surrenderedTo.length > 0) continue;
      return { type: 'capture', by: me, ship: ship.id, target: other.id };
    }
  }

  // Cash in. "Ore may be sold at Ceres (MCr 2 per ton) or at Luna (MCr 3 per
  // ton). CT shards sell for MCr 100 at Ceres or MCr 200 at Luna."
  for (const ship of myShips(state, me)) {
    if (!canTradeAt(state, ship, map).ok) continue;
    for (const kind of ['ctShard', 'ore'] as const) {
      const quantity = cargoCount(ship, kind);
      if (quantity <= 0) continue;
      return { type: 'sellCargo', by: me, ship: ship.id, kind, quantity };
    }
  }

  for (const ship of myShips(state, me)) {
    if (ship.resuppliedThisTurn) continue;
    // The other half of the same sentence, enforced backwards: a ship that has
    // already shot or dropped something this player-turn has spent it.
    if (ship.firedThisPhase || ship.launchedOrdnanceThisTurn) continue;
    if (!needsBase(ship) && ship.fuel >= fuelCapacity(ship)) continue;
    if (!canResupplyAt(state, ship, map).ok) continue;
    // "Whenever a ship is refueled from a base, it automatically undergoes
    // maintenance." Fuel and repairs in one stop.
    return { type: 'resupply', by: me, ship: ship.id, loadout: [] };
  }
  return null;
};

// ---------------------------------------------------------------------------
// The one entry point
// ---------------------------------------------------------------------------

/**
 * The next order this player would give, or `null` to end the phase.
 *
 * Answers owed to somebody else's turn come first — return fire and an
 * unanswered nuke hexside are decisions the rules hand to a player who is not
 * phasing, and they block everything else until given.
 */
export function nextCommand(
  state: GameState,
  me: PlayerId,
  map: GameMap = DEFAULT_MAP,
): Command | null {
  if (state.victory) return null;
  if (state.players[me]?.eliminated === true) return null;

  // Owed answers, in either player's turn. Both of these *block*: while one is
  // outstanding the engine accepts nothing else from anybody, so a seat that
  // does not owe the answer has nothing to say either — not even the attacker
  // whose turn it still is.
  if (pendingCounterattack(state) !== null) return counterattackOrder(state, me, map);

  const strike = pendingDevastation(state);
  if (strike !== null) {
    if (strike.sufferer !== me) return null;
    // "If it is not clear which hex side has been affected, the suffering player
    // makes the choice." Take the one that costs least.
    return {
      type: 'chooseDevastatedSide',
      by: me,
      side: cheapestDevastation(state, strike.at, strike.candidates, me),
    };
  }

  const answer = surrenderOrder(state, me, map);
  if (answer) return answer;

  // Everything else needs the floor.
  if (activePlayer(state) !== me) return null;

  switch (state.phase) {
    case 'astrogation':
      return astrogationOrder(state, me, map);
    case 'combat':
      return combatOrder(state, me, map);
    case 'resupply':
      return resupplyOrder(state, me, map);
    // The ordnance phase is left alone for now: a mine laid badly is a mine you
    // fly into yourself, and the rule that makes that dangerous — "that ship
    // must execute an immediate course change" — needs planning this pilot does
    // not do. Movement is automatic.
    case 'ordnance':
    case 'movement':
      return null;
  }
}

/**
 * Everything this player would do in the current phase, in order.
 *
 * A convenience for tests and for a driver that wants the whole list at once.
 * Bounded: a policy bug can produce an order the engine refuses, and the loop
 * must not spin on it.
 */
export function planPhase(
  state: GameState,
  me: PlayerId,
  map: GameMap = DEFAULT_MAP,
  apply: (s: GameState, c: Command) => GameState | null,
  limit = 40,
): { state: GameState; commands: Command[] } {
  let s = state;
  const commands: Command[] = [];
  for (let i = 0; i < limit; i += 1) {
    const cmd = nextCommand(s, me, map);
    if (cmd === null) break;
    const next = apply(s, cmd);
    if (next === null) break; // refused: stop rather than loop on it
    s = next;
    commands.push(cmd);
  }
  return { state: s, commands };
}

export { brakingRoom, courseToward, orbitalCourse, safeCourses } from './navigate.js';
