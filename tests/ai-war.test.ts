/**
 * The general staff: the computer playing Orbital Drop above the pilot.
 *
 * As with the pilot, these are about trust before skill. The staff has to
 * fight the war at all (a headless war reaches a landing and a ground
 * battle), do it the same way twice, obey the freeze, and — the one that
 * matters most for a hidden-information rule — decide without reading the
 * enemy's secret garrison. The rest are single rules of the invasion
 * sequence, each set up on a bare board and put to the policy.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_MAP } from '../src/engine/map.js';
import { applyCommand } from '../src/engine/reducer.js';
import { type GameState, type PlayerId, activePlayer } from '../src/engine/types.js';
import { withBase, withShip } from '../src/engine/state.js';
import { sideGravityHex } from '../src/engine/hex.js';
import { buildScenario, hold, inOrbit, landed } from '../src/scenarios/index.js';
import { dropData } from '../src/scenarios/orbitalDrop.js';
import { redactState } from '../src/net/redact.js';
import { nextCommand } from '../src/ai/index.js';
import { aiCommand } from '../src/ai/driver.js';
import {
  playWar,
  skyFrozen,
  warCombatOrder,
  warErrand,
  warOrdnanceOrder,
  warReading,
  warResupplyOrder,
} from '../src/ai/war/index.js';
import type { OrderOfBattle } from '../src/campaign/orders.js';

const map = DEFAULT_MAP;
const COMBINE: PlayerId = 'combine';
const PANEURO: PlayerId = 'paneuro';

/** Wind the phase machine until a predicate holds. */
const until = (s: GameState, done: (x: GameState) => boolean, cap = 120): GameState => {
  let cur = s;
  for (let i = 0; i < cap; i++) {
    if (done(cur)) return cur;
    const out = applyCommand(cur, { type: 'endPhase', by: activePlayer(cur) }, map);
    if (!out.result.ok) throw new Error(out.result.reason);
    cur = out.state;
  }
  throw new Error('never got there');
};

const phaseOf = (s: GameState, player: PlayerId, phase: GameState['phase']): GameState =>
  until(s, (x) => x.phase === phase && activePlayer(x) === player);

const baseNamed = (s: GameState, id: string) => {
  const base = s.bases[id];
  if (!base || !base.side) throw new Error(`no hexside base ${id}`);
  return { ...base, side: base.side };
};

/** The war's ledger, patched in place. */
const withDrop = (s: GameState, patch: Partial<ReturnType<typeof dropData>>): GameState => ({
  ...s,
  scenarioData: { ...s.scenarioData, orbitalDrop: { ...dropData(s), ...patch } },
});

/** A Combine wave in orbit over Mercury's first base, an escort with it. */
const waveOverMercury = (seed: number, escort: boolean): { state: GameState; base: string } => {
  let s = buildScenario('orbital-drop', { seed });
  const base = baseNamed(s, 'mercury:0');
  s = withShip(
    s,
    inOrbit(
      {
        id: 'combine-wave-1',
        owner: COMBINE,
        shipClass: 'transport',
        number: 90,
        cargo: hold({ gndHVY: 2, gndINF: 9 }),
      },
      map,
      'mercury',
      base.side.dir,
    ),
  );
  if (escort) {
    s = withShip(
      s,
      inOrbit(
        { id: 'combine-escort-1', owner: COMBINE, shipClass: 'frigate', number: 91, cargo: [] },
        map,
        'mercury',
        base.side.dir,
      ),
    );
  }
  return { state: s, base: base.id };
};

// ---------------------------------------------------------------------------
// 1. It fights the war
// ---------------------------------------------------------------------------

describe('the general staff fights the war', () => {
  it('buys a landing, sails it, declares, lands, fights the ground battle and takes a base', () => {
    const r = playWar(1, undefined, { maxDays: 45 });
    expect(r.refused).toBeUndefined();
    expect(r.battles).toBeGreaterThanOrEqual(1);
    expect(r.captures).toBeGreaterThanOrEqual(1);
  }, 120_000);

  it('fights the same war identically from the same seed', () => {
    const a = playWar(2, undefined, { maxDays: 20 });
    const b = playWar(2, undefined, { maxDays: 20 });
    expect(b).toEqual(a);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// 2. It does not see through walls
// ---------------------------------------------------------------------------

describe('the staff does not read the enemy’s garrison', () => {
  it('chooses the same target and the same purchases whatever the enemy has hidden', () => {
    const open = phaseOf(buildScenario('orbital-drop', { seed: 5 }), COMBINE, 'resupply');
    // §3.02: the composition is recorded secretly. Paneurope's whole allowance
    // at every base, and a Mark V at Mars for good measure.
    const garrisons: Record<
      string,
      { units: Record<string, number>; reaction: Record<string, number> }
    > = {};
    for (const b of Object.values(open.bases)) {
      if (b.owner === PANEURO)
        garrisons[b.id] = { units: { INF: 20, HVY: 6, MSL: 6 }, reaction: {} };
    }
    garrisons['mars:0'] = { units: { INF: 20, MK5: 1 }, reaction: {} };
    const hidden = withDrop(open, { garrisons });

    expect(warReading(hidden, COMBINE, map)).toEqual(warReading(open, COMBINE, map));
    expect(warResupplyOrder(hidden, COMBINE, map)).toEqual(warResupplyOrder(open, COMBINE, map));
    expect(nextCommand(hidden, COMBINE, map)).toEqual(nextCommand(open, COMBINE, map));
  });

  it('is sent only its own garrisons under fog of war, and the invasion in the open', () => {
    let s = buildScenario('orbital-drop', { seed: 5, options: { fogOfWar: true } });
    const terra = Object.values(s.bases).find((b) => b.owner === COMBINE)!;
    const mars = Object.values(s.bases).find((b) => b.owner === PANEURO)!;
    s = withDrop(s, {
      garrisons: {
        [terra.id]: { units: { INF: 4 }, reaction: {} },
        [mars.id]: { units: { HVY: 3 }, reaction: { MSL: 1 } },
      },
      invasion: {
        base: mars.id,
        world: 'mars',
        side: mars.side ?? null,
        hex: mars.hex,
        attacker: COMBINE,
        declaredTurn: 1,
      },
    });
    const view = dropData(redactState(s, COMBINE, map));
    expect(Object.keys(view.garrisons)).toEqual([terra.id]);
    expect(view.invasion?.base).toBe(mars.id);
    const theirs = dropData(redactState(s, PANEURO, map));
    expect(Object.keys(theirs.garrisons)).toEqual([mars.id]);
    expect(Object.keys(dropData(redactState(s, null, map)).garrisons)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. The invasion sequence, rule by rule
// ---------------------------------------------------------------------------

describe('the invasion sequence', () => {
  it('says nothing at all while the sky is frozen', () => {
    const s0 = phaseOf(buildScenario('orbital-drop', { seed: 3 }), COMBINE, 'astrogation');
    const order: OrderOfBattle = {
      battleId: 'drop-1-mercury:0',
      seed: 1,
      scenarioId: 'assault',
      sides: [
        { player: COMBINE, faction: 'North American Combine', forces: { INF: 3 } },
        { player: 'militia', faction: 'Base Militia', forces: { INF: 6 } },
      ],
      terms: {},
    };
    const frozen = withDrop(s0, { pendingGround: order });
    expect(skyFrozen(frozen)).toBe(true);
    expect(nextCommand(frozen, COMBINE, map)).toBeNull();
    expect(aiCommand(frozen, new Set([COMBINE, PANEURO]), map)).toBeNull();
    // And the moment it thaws, the computer is back.
    expect(aiCommand(s0, new Set([COMBINE, PANEURO]), map)).not.toBeNull();
  });

  it('declares only with the wave overhead — and, against live guns, an escort with it', () => {
    const alone = waveOverMercury(4, false);
    const s1 = phaseOf(alone.state, COMBINE, 'ordnance');
    expect(s1.bases[alone.base]!.hasPlanetaryDefences).toBe(true);
    expect(warOrdnanceOrder(s1, COMBINE, map)).toBeNull();

    const escorted = waveOverMercury(4, true);
    const s2 = phaseOf(escorted.state, COMBINE, 'ordnance');
    expect(warOrdnanceOrder(s2, COMBINE, map)).toEqual({
      type: 'declareInvasion',
      by: COMBINE,
      base: escorted.base,
    });
    // The pilot gives the same order in the ordnance phase, and the engine takes it.
    const cmd = nextCommand(s2, COMBINE, map)!;
    expect(cmd.type).toBe('declareInvasion');
    expect(applyCommand(s2, cmd, map).result.ok).toBe(true);
  });

  it('silences the hexside with a warship overhead before the wave goes down', () => {
    // Suppression is a combat-phase order, and the movement phase carries a
    // ship one hex round its orbit first: the escort starts one hex short of
    // the hexside so that it is over it when the guns are asked.
    const { state, base } = waveOverMercury(4, false);
    const side = baseNamed(state, base).side;
    const withEscort = withShip(
      state,
      inOrbit(
        { id: 'combine-escort-1', owner: COMBINE, shipClass: 'frigate', number: 91, cargo: [] },
        map,
        'mercury',
        (side.dir + 5) % 6,
      ),
    );
    expect(state.playerOrder[0]).toBe(COMBINE);
    const s = phaseOf(withEscort, COMBINE, 'combat');
    expect(s.ships['combine-escort-1']!.pos).toEqual(sideGravityHex(side));
    const order = warCombatOrder(s, COMBINE, map);
    expect(order).toEqual({ type: 'suppressHexside', by: COMBINE, ship: 'combine-escort-1', side });
    expect(applyCommand(s, order!, map).result.ok).toBe(true);
  });

  it('lands the wave the day after the declaration, on the declared hexside, and not before', () => {
    const { state, base } = waveOverMercury(6, false);
    const b = baseNamed(state, base);
    const declared = (turnsAgo: number, silenced: boolean): GameState => {
      let s = phaseOf(state, COMBINE, 'astrogation');
      s = withBase(s, { ...b, suppressed: silenced });
      return withDrop(s, {
        invasion: {
          base: b.id,
          world: 'mercury',
          side: b.side,
          hex: b.hex,
          attacker: COMBINE,
          declaredTurn: s.turn - turnsAgo,
        },
      });
    };
    // Everything the pilot says this astrogation phase, in order.
    const phase = (start: GameState) => {
      const out = [];
      let cur = start;
      for (let i = 0; i < 40; i++) {
        const cmd = nextCommand(cur, COMBINE, map);
        if (cmd === null) break;
        const applied = applyCommand(cur, cmd, map);
        expect(applied.result.reason).toBeUndefined();
        cur = applied.state;
        out.push(cmd);
      }
      return out;
    };
    const landings = (start: GameState) => phase(start).filter((c) => c.type === 'land');

    expect(landings(declared(0, true))).toEqual([]);
    expect(landings(declared(1, false))).toEqual([]);
    expect(landings(declared(1, true))).toEqual([
      { type: 'land', by: COMBINE, ship: 'combine-wave-1', side: b.side },
    ]);
  });

  it('holds a transport at the yard until its hold is full, then sends it', () => {
    const s = phaseOf(buildScenario('orbital-drop', { seed: 8 }), COMBINE, 'resupply');
    // Buy until the staff is done at the yard.
    let cur = s;
    let bought = 0;
    for (let i = 0; i < 40; i++) {
      const cmd = warResupplyOrder(cur, COMBINE, map);
      if (cmd === null) break;
      const out = applyCommand(cur, cmd, map);
      expect(out.result.reason).toBeUndefined();
      cur = out.state;
      if (cmd.type === 'purchaseGround') bought += 1;
    }
    expect(bought).toBeGreaterThan(0);
    const loaded = Object.values(cur.ships).find(
      (x) => x.owner === COMBINE && x.cargo.some((c) => c.kind.startsWith('gnd')),
    )!;
    const errand = warErrand(cur, loaded, map)!;
    expect(errand.why).toBe('carry the landing to the target');
    expect(errand.land).toBe(false);
    // And an empty one is told to wait at the yard, on the ground.
    const empty = Object.values(cur.ships).find(
      (x) => x.owner === COMBINE && x.shipClass === 'transport' && x.cargo.length === 0,
    );
    if (empty) expect(warErrand(cur, empty, map)?.land).toBe(true);
  });

  it('leaves a transport down on a ruined hexside where it is, rather than asking for boosters', () => {
    let s = buildScenario('orbital-drop', { seed: 9 });
    const b = baseNamed(s, 'mercury:0');
    s = withBase(s, { ...b, owner: COMBINE, destroyed: true });
    s = withShip(
      s,
      landed(
        { id: 'combine-lander-1', owner: COMBINE, shipClass: 'transport', number: 95, cargo: [] },
        b.side,
      ),
    );
    s = phaseOf(s, COMBINE, 'astrogation');
    for (let i = 0; i < 20; i++) {
      const cmd = nextCommand(s, COMBINE, map);
      if (cmd === null) break;
      expect(cmd).not.toEqual({ type: 'takeOff', by: COMBINE, ship: 'combine-lander-1' });
      const out = applyCommand(s, cmd, map);
      expect(out.result.ok).toBe(true);
      s = out.state;
    }
  });

  it('never sends a wave at the rock inside the pirate cordon', () => {
    const s = buildScenario('orbital-drop', { seed: 10 });
    for (const p of s.playerOrder) {
      expect(warReading(s, p, map).target).not.toBe('clandestine');
    }
  });

  it('keeps the wave in orbit over the world, over no hexside in particular', () => {
    const { state } = waveOverMercury(11, false);
    const s = phaseOf(state, COMBINE, 'astrogation');
    const wave = s.ships['combine-wave-1']!;
    const errand = warErrand(s, wave, map)!;
    expect(errand.orbit).toBe(true);
    expect(errand.bodyId).toBe('mercury');
    expect(errand.hex).toEqual(map.body('mercury')!.hex);
    // Over the hexside itself the engine's overhead check is met, and the
    // errand does not pull the ship off its orbit to hold one hex of it.
    expect(errand.hex).not.toEqual(sideGravityHex(baseNamed(s, 'mercury:0').side));
  });
});
