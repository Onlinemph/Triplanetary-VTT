/**
 * Every trail the engine can draw obeys the movement rules.
 *
 * The renderer draws a ship's course straight out of `Ship.course`, arrow by
 * arrow, to the rulebook's Standard Astrogation Conventions (p. 3). So "is this
 * picture rules-accurate?" is answerable: audit the record the picture is drawn
 * from, leg against leg, against the printed law of motion.
 *
 *   "A ship which is not accelerated by thrust or gravity will move as it did in
 *    the previous turn, in the same direction, and traveling an equal distance."
 *   "One fuel point allows a ship to alter its predicted course by one hex in
 *    any direction."
 *   "Gravity ... is cumulative and mandatory", and "takes effect on the turn
 *    after an object enters the gravity hex."
 *
 * Put together: leg N+1 must end within `accel` hexes of `head(N) + vector(N) +
 * gravity picked up during N`, and `accel` is the fuel the arrow is drawn with.
 * That is the whole of vector movement, and it is checkable arithmetic.
 *
 * The audit is run over courses flown through the real reducer rather than over
 * hand-built ones, so what it certifies is the engine, not a fixture.
 */

import { describe, expect, it } from 'vitest';
import {
  type Command,
  type CourseLeg,
  type GameState,
  type Hex,
  type Ship,
  add,
  applyCommand,
  distance,
  eq,
  isZero,
  key,
  length,
  reachableEndpoints,
  sub,
  traceSegment,
} from '../src/engine/index.js';
import { DEFAULT_MAP, type GameMap } from '../src/engine/map.js';
import { buildScenario } from '../src/scenarios/index.js';

const map = DEFAULT_MAP;

// ---------------------------------------------------------------------------
// The auditor
// ---------------------------------------------------------------------------

/** Every combination of weak-gravity arrows the pilot could have accepted. */
const gravityChoices = (mandatory: Hex, optional: readonly Hex[]): Hex[] => {
  let out: Hex[] = [mandatory];
  for (const h of optional) {
    const arrow = map.weakGravityArrow(h);
    out = [...out, ...out.map((g) => add(g, arrow))];
  }
  return out;
};

/**
 * Gravity picked up by flying `from → to`, as the engine books it.
 *
 * "Gravity takes effect on the turn after an object enters the gravity hex", so
 * what a leg collects is what bends the *next* leg. A stationary turn still
 * collects the hex it sits in — hovering over a planet does not make the pull
 * go away.
 */
const gravityFrom = (from: Hex, to: Hex): { mandatory: Hex; optional: readonly Hex[] } => {
  if (eq(from, to)) return map.accumulateGravity([to], map.hasWeakGravity(from));
  const entered = traceSegment(from, to).entered.filter((h) => !eq(h, from));
  return map.accumulateGravity(entered, map.hasWeakGravity(from));
};

export interface Violation {
  readonly turn: number;
  readonly why: string;
}

/**
 * Audit one ship's trail. An empty list means every arrow in the picture is a
 * legal consequence of the one before it.
 *
 * Two kinds of leg are exempt from the vector law because the rules exempt
 * them: a take-off ("boosters ... lift the ship one hex, leaving it stationary")
 * and a landing ("a ship may only land by expending one fuel point while in
 * orbit"), both of which start or end inside a world's own hex.
 */
export const auditCourse = (ship: Ship, m: GameMap = map): Violation[] => {
  const out: Violation[] = [];
  const legs = ship.course;

  for (let i = 0; i < legs.length; i += 1) {
    const leg = legs[i]!;
    const previous = i > 0 ? legs[i - 1] : undefined;

    if (leg.accel !== 0 && leg.accel !== 1 && leg.accel !== 2) {
      out.push({ turn: leg.turn, why: `burned ${leg.accel} fuel points on one leg` });
    }

    if (previous && !eq(previous.to, leg.from)) {
      // "Vectors are drawn as straight lines, beginning in the center of a hex
      // and ending in the center of a hex" — and the next one starts where the
      // last one stopped. A gap in the trail is a teleport.
      out.push({
        turn: leg.turn,
        why: `starts at ${key(leg.from)} but the previous leg ended at ${key(previous.to)}`,
      });
      continue;
    }
    if (!previous) continue;

    // Take-off and landing legs are their own rules.
    const startsOnWorld = m.bodyAt(leg.from)?.landing === 'hexside';
    const endsOnWorld = m.bodyAt(leg.to)?.landing === 'hexside';
    if (startsOnWorld || endsOnWorld) continue;

    // A take-off arrow is a picture of the boost, not a vector: "the planetary
    // surface gravity immediately cancels takeoff velocity, leaving the ship
    // stationary in the gravity hex immediately above the base." So the leg
    // after one starts from rest, however long the arrow beneath it looks. The
    // pull of the hex it was lifted into is still collected, which is exactly
    // why an unpowered ship falls straight back down.
    const liftedOff = m.bodyAt(previous.from)?.landing === 'hexside';
    const velocity = liftedOff ? { q: 0, r: 0 } : sub(previous.to, previous.from);
    const { mandatory, optional } = gravityFrom(previous.from, previous.to);
    const coasting = add(add(leg.from, velocity), mandatory);

    // The pilot's weak-gravity choice is not stored on the leg, so the leg is
    // legal if it is within `accel` of *any* endpoint the choice could produce.
    const best = gravityChoices(mandatory, optional)
      .map((g) => distance(add(add(leg.from, velocity), g), leg.to))
      .reduce((a, b) => Math.min(a, b), Infinity);

    if (best > leg.accel) {
      out.push({
        turn: leg.turn,
        why:
          `ends at ${key(leg.to)}, ${best} hex(es) off the coasting endpoint ` +
          `${key(coasting)}, but only ${leg.accel} fuel point(s) were spent`,
      });
    }
  }
  return out;
};

// ---------------------------------------------------------------------------
// Flying something to audit
// ---------------------------------------------------------------------------

const ok = (s: GameState, cmd: Command): GameState => {
  const out = applyCommand(s, cmd, map);
  expect({ cmd: cmd.type, ok: out.result.ok, why: out.result.reason }).toEqual({
    cmd: cmd.type,
    ok: true,
    why: undefined,
  });
  return out.state;
};

const nextDay = (s: GameState): GameState => {
  const day = s.turn;
  let x = s;
  for (let i = 0; i < 12 && x.turn === day; i += 1) {
    if (x.victory) return x;
    x = ok(x, { type: 'endPhase', by: x.playerOrder[x.activePlayerIndex]! });
  }
  return x;
};

/**
 * Fly a long, varied course: orbit, break out, accelerate, coast, brake, hover.
 *
 * Deliberately not a straight line. The audit is only worth running over a trail
 * that does the awkward things — a stationary turn, a gravity slingshot, a
 * reversal — because those are where a vector bug would hide.
 */
const flyVariedCourse = (seed: number): GameState => {
  let s = buildScenario('flight-school', { seed });
  const SHIP = 'school-ship';
  s = nextDay(ok(s, { type: 'takeOff', by: 'cadet', ship: SHIP }));

  let rng = seed >>> 0;
  const roll = (n: number): number => {
    rng = (rng * 1664525 + 1013904223) >>> 0;
    return rng % n;
  };

  for (let day = 0; day < 40; day += 1) {
    if (s.victory) break;
    const ship = s.ships[SHIP]!;
    if (ship.destroyed) break;
    if (ship.location.kind === 'landed') {
      s = nextDay(ok(s, { type: 'takeOff', by: 'cadet', ship: SHIP }));
      continue;
    }
    const options = reachableEndpoints(s, ship, map).filter(
      (o) => !o.crashesInto && !o.exitsMap && o.accel <= 1,
    );
    if (options.length === 0) break;

    // Mix it up: sometimes the fastest course, sometimes the slowest (which at
    // speed means braking, and at rest means hovering), sometimes any of them.
    const mode = roll(3);
    const sorted = [...options].sort((a, b) =>
      mode === 0 ? b.distance - a.distance : mode === 1 ? a.distance - b.distance : 0,
    );
    const pick = mode === 2 ? sorted[roll(sorted.length)]! : sorted[0]!;
    s = nextDay(ok(s, { type: 'plotCourse', by: 'cadet', ship: SHIP, endpoint: pick.endpoint }));
  }
  return s;
};

// ---------------------------------------------------------------------------

describe('a drawn trail is a legal trail', () => {
  it('audits a long varied flight, leg by leg, across many seeds', () => {
    for (let seed = 1; seed <= 25; seed += 1) {
      const s = flyVariedCourse(seed);
      const ship = s.ships['school-ship']!;
      // A flight worth auditing: several legs, and not all the same length.
      expect(ship.course.length).toBeGreaterThan(3);
      expect(auditCourse(ship)).toEqual([]);
    }
  });

  it('exercises the awkward cases it is meant to cover', () => {
    // A guard on the guard: if these flights never brake, never hover and never
    // slingshot, the audit above is passing on trivial straight lines.
    let sawStationary = false;
    let sawBraking = false;
    let sawFreeAcceleration = false;

    for (let seed = 1; seed <= 25; seed += 1) {
      const legs = flyVariedCourse(seed).ships['school-ship']!.course;
      for (let i = 1; i < legs.length; i += 1) {
        const a = legs[i - 1]!;
        const b = legs[i]!;
        if (eq(b.from, b.to)) sawStationary = true;
        const before = length(sub(a.to, a.from));
        const after = length(sub(b.to, b.from));
        if (after < before) sawBraking = true;
        // Gravity is free acceleration: speed up by more than the fuel spent.
        if (after > before + b.accel) sawFreeAcceleration = true;
      }
    }
    expect({ sawStationary, sawBraking, sawFreeAcceleration }).toEqual({
      sawStationary: true,
      sawBraking: true,
      sawFreeAcceleration: true,
    });
  });

  it('catches a leg that turns further than its fuel allows', () => {
    // The auditor has to be able to fail, or the tests above prove nothing.
    // Bend one arrow two hexes sideways while still charging one fuel point.
    const s = flyVariedCourse(3);
    const ship = s.ships['school-ship']!;
    const i = ship.course.findIndex((leg, n) => n > 0 && leg.accel <= 1 && !eq(leg.from, leg.to));
    expect(i).toBeGreaterThan(0);

    const bent: CourseLeg[] = ship.course.map((leg, n) =>
      n === i ? { ...leg, to: add(leg.to, { q: 2, r: 0 }) } : leg,
    );
    // Re-anchor the following leg so the only fault is the bend itself.
    if (bent[i + 1]) bent[i + 1] = { ...bent[i + 1]!, from: bent[i]!.to };

    const faults = auditCourse({ ...ship, course: bent.slice(0, i + 1) });
    expect(faults).toHaveLength(1);
    expect(faults[0]!.why).toMatch(/fuel point/);
  });

  it('catches a trail with a gap in it', () => {
    const s = flyVariedCourse(5);
    const ship = s.ships['school-ship']!;
    const legs = [...ship.course];
    expect(legs.length).toBeGreaterThan(2);
    legs[1] = { ...legs[1]!, from: add(legs[1]!.from, { q: 3, r: -1 }) };
    expect(
      auditCourse({ ...ship, course: legs }).some((v) => /previous leg ended/.test(v.why)),
    ).toBe(true);
  });

  it('accepts an orbit, which is the case that looks most like an error', () => {
    // Six one-hex legs round a world, each bent by gravity and none of them
    // burning fuel after the first: "such a ship will continue to orbit until
    // fuel is burned to produce a course change."
    const s = buildScenario('bi-planetary');
    const orbiter = Object.values(s.ships).find((x) => !isZero(x.velocity)) ?? null;
    if (orbiter === null) return;
    let cur = s;
    for (let day = 0; day < 8; day += 1) cur = nextDay(cur);
    for (const ship of Object.values(cur.ships)) {
      expect({ id: ship.id, faults: auditCourse(ship) }).toEqual({ id: ship.id, faults: [] });
    }
  });
});
