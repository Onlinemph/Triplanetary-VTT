/**
 * Orbital Drop: the seam between the two games, tested at engine level.
 *
 * The space half drives the real Triplanetary reducer; the ground half builds
 * the real Ogre assault from the order the freeze minted, decides it, and
 * hands the result back through `resolveGroundBattle` — the same round trip
 * the shell performs, minus the pixels.
 */

import { describe, expect, it } from 'vitest';
import { applyCommand } from '@engine/reducer.js';
import { DEFAULT_MAP } from '@engine/map.js';
import { type Command } from '@engine/commands.js';
import { type GameState, activePlayer } from '@engine/types.js';
import { withBase, withShip, cargoCount } from '@engine/state.js';
import { sideGravityHex } from '@engine/hex.js';
import { toOffset } from '../src/ogre/engine/hex.js';
import { hold, inSpace, landed } from '../src/scenarios/helpers.js';
import { buildScenario } from '../src/scenarios/index.js';
import {
  GROUND_PRICES,
  MILITIA_SQUADS,
  OPENING_TREASURY,
  dropData,
} from '../src/scenarios/orbitalDrop.js';

import { applyCommand as ogreApply } from '../src/ogre/engine/reducer.js';
import { allHexes, terrainAt } from '../src/ogre/engine/map.js';
import { onBoard } from '../src/ogre/engine/types.js';
import { ASSAULT } from '../src/ogre/scenarios/index.js';
import { readBattleResult } from '../src/ogre/campaign/result.js';
import type { OrderOfBattle } from '@campaign/orders.js';

const map = DEFAULT_MAP;

const run = (s: GameState, c: Command): { state: GameState; ok: boolean; why?: string } => {
  const out = applyCommand(s, c, map);
  return { state: out.state, ok: out.result.ok, why: out.result.reason };
};

const mustRun = (s: GameState, c: Command): GameState => {
  const out = run(s, c);
  if (!out.ok) throw new Error(out.why ?? `${c.type} refused`);
  return out.state;
};

/** Wind the phase machine until a predicate holds. */
const until = (s: GameState, done: (x: GameState) => boolean, cap = 120): GameState => {
  let cur = s;
  for (let i = 0; i < cap; i++) {
    if (done(cur)) return cur;
    cur = mustRun(cur, { type: 'endPhase', by: activePlayer(cur) });
  }
  throw new Error('never got there');
};

const marsBaseId = (s: GameState): string => {
  const id = Object.keys(s.bases).find((k) => k.startsWith('mars:'));
  if (!id) throw new Error('mars has no base');
  return id;
};

describe('Orbital Drop: the campaign layer', () => {
  const start = buildScenario('orbital-drop', { seed: 42 });

  it('opens with the war split and the treasuries full', () => {
    expect(start.players['combine']!.megacredits).toBe(OPENING_TREASURY);
    expect(Object.values(start.bases).some((b) => b.owner === 'combine')).toBe(true);
    expect(Object.values(start.bases).some((b) => b.owner === 'paneuro')).toBe(true);
    expect(Object.keys(start.bases).some((k) => k.startsWith('mercury:'))).toBe(true);
  });

  it('sells ground forces at a held base, against the hold and the purse', () => {
    // A combine transport is landed at a combine base already.
    const transport = Object.values(start.ships).find(
      (s) => s.owner === 'combine' && s.shipClass === 'transport',
    )!;
    const s0 = until(start, (x) => x.phase === 'resupply' && activePlayer(x) === 'combine');

    const bought = mustRun(s0, {
      type: 'purchaseGround',
      by: 'combine',
      ship: transport.id,
      kind: 'gndHVY',
      quantity: 2,
    });
    expect(cargoCount(bought.ships[transport.id]!, 'gndHVY')).toBe(2);
    expect(bought.players['combine']!.megacredits).toBe(
      OPENING_TREASURY - 2 * GROUND_PRICES['gndHVY']!,
    );

    // 50-ton hold: 2 tanks are 20 tons; 16 more squads (32 tons) overflow it.
    const over = run(bought, {
      type: 'purchaseGround',
      by: 'combine',
      ship: transport.id,
      kind: 'gndINF',
      quantity: 16,
    });
    expect(over.ok).toBe(false);
    expect(over.why).toMatch(/hold/);
  });

  it('caps garrisons the way §3.02 says', () => {
    const s0 = until(start, (x) => x.phase === 'resupply' && activePlayer(x) === 'combine');
    const base = Object.values(s0.bases).find((b) => b.owner === 'combine')!;

    // 6 Superheavies are 12 armour units: legal. A 7th anything is not.
    let s = mustRun(s0, {
      type: 'purchaseGarrison',
      by: 'combine',
      base: base.id,
      unit: 'SHVY',
      count: 6,
    });
    const overArmour = run(s, {
      type: 'purchaseGarrison',
      by: 'combine',
      base: base.id,
      unit: 'HVY',
      count: 1,
    });
    expect(overArmour.ok).toBe(false);

    // Squads cap at 20 on a planetary base.
    s = mustRun(s, {
      type: 'purchaseGarrison',
      by: 'combine',
      base: base.id,
      unit: 'INF',
      count: 20,
    });
    expect(
      run(s, { type: 'purchaseGarrison', by: 'combine', base: base.id, unit: 'INF', count: 1 }).ok,
    ).toBe(false);

    // A garrison Ogre takes the whole armour allowance.
    const other = Object.values(s0.bases).find((b) => b.owner === 'combine' && b.id !== base.id)!;
    let g = mustRun(s0, {
      type: 'purchaseGarrison',
      by: 'combine',
      base: other.id,
      unit: 'MK3',
      count: 1,
    });
    expect(
      run(g, { type: 'purchaseGarrison', by: 'combine', base: other.id, unit: 'HVY', count: 1 }).ok,
    ).toBe(false);

    // The reaction force is at most half the purchased garrison.
    g = mustRun(g, {
      type: 'purchaseGarrison',
      by: 'combine',
      base: other.id,
      unit: 'INF',
      count: 4,
    });
    expect(
      run(g, {
        type: 'purchaseGarrison',
        by: 'combine',
        base: other.id,
        unit: 'INF',
        count: 10,
        reaction: true,
      }).ok,
    ).toBe(false);
    expect(
      run(g, {
        type: 'purchaseGarrison',
        by: 'combine',
        base: other.id,
        unit: 'INF',
        count: 2,
        reaction: true,
      }).ok,
    ).toBe(true);
  });
});

describe('Orbital Drop: declare, land, freeze, fight, resume', () => {
  /**
   * Stage an invasion by surgery: a loaded transport already landed at the
   * Mars hexside, a corvette overhead to declare with (and to owe the
   * orbital strike), and the guns silenced so the freeze is deterministic.
   */
  const staged = (): { state: GameState; base: string } => {
    let s = buildScenario('orbital-drop', { seed: 7 });
    const base = marsBaseId(s);
    const side = s.bases[base]!.side!;
    s = withShip(
      s,
      landed(
        {
          id: 'combine-drop-1',
          owner: 'combine',
          shipClass: 'transport',
          number: 90,
          cargo: hold({ gndHVY: 2, gndINF: 9 }),
        },
        side,
      ),
    );
    s = withShip(
      s,
      inSpace(
        { id: 'combine-escort-1', owner: 'combine', shipClass: 'corvette', number: 91, cargo: [] },
        sideGravityHex(side),
      ),
    );
    // Silence the guns: the crash roll is its own test.
    s = withBase(s, { ...s.bases[base]!, suppressed: true });
    return { state: s, base };
  };

  it('freezes the sky over a declared invasion and mints the assault order', () => {
    const { state: s0, base } = staged();
    const side = s0.bases[base]!.side!;
    let s = until(s0, (x) => x.phase === 'ordnance' && activePlayer(x) === 'combine');
    s = mustRun(s, { type: 'declareInvasion', by: 'combine', base });
    expect(dropData(s).invasion?.base).toBe(base);

    // Gravity moves everything: put the escort back over the hexside just
    // before the freeze, the way a player times an orbit to be overhead when
    // the transports go down.
    s = until(s, (x) => x.turn > 1 && activePlayer(x) === 'combine' && x.phase === 'resupply');
    s = withShip(s, {
      ...s.ships['combine-escort-1']!,
      destroyed: false,
      pos: sideGravityHex(side),
    });
    s = until(s, (x) => dropData(x).pendingGround !== null);
    const order = dropData(s).pendingGround!;
    expect(order.scenarioId).toBe('assault'); // Mars is a dead world
    expect(order.sides[0]!.player).toBe('combine');
    expect(order.sides[0]!.forces).toEqual({ HVY: 2, INF: 9 });
    // Mars opens Paneuropean but ungarrisoned: the free militia is the
    // whole defence — §3.01's "there is never a walkover".
    expect(order.sides[1]!.player).toBe('paneuro');
    expect(order.sides[1]!.forces).toEqual({ INF: MILITIA_SQUADS });
    expect(order.terms['profile']).toBe('dead');
    // The corvette overhead owes its strike.
    expect(order.terms['orbitalStrikes']).toEqual([2]);
  });

  it('fights the assault in the real Ogre engine and reports the fall of Mars', () => {
    const { state: s0, base } = staged();
    let s = until(s0, (x) => x.phase === 'ordnance' && activePlayer(x) === 'combine');
    s = mustRun(s, { type: 'declareInvasion', by: 'combine', base });
    s = until(s, (x) => dropData(x).pendingGround !== null);
    const order = dropData(s).pendingGround!;

    // The ground half, in the real engine: build it, decide it by wiping the
    // garrison, and read the result the way the battle view does.
    let ground = ASSAULT.build({ seed: order.seed, order });
    expect(Object.values(ground.units).some((u) => u.owner === 'combine' && onBoard(u))).toBe(true);
    ground = {
      ...ground,
      units: Object.fromEntries(
        Object.entries(ground.units).map(([id, u]) => [
          id,
          u.owner === 'paneuro' && !(u.kind === 'unit' && u.classId === 'CP')
            ? { ...u, destroyed: true }
            : u,
        ]),
      ),
    };
    const decided = ogreApply(
      ground,
      { type: 'endPhase', by: ground.playerOrder[ground.activePlayerIndex]! },
      ASSAULT.map,
      ASSAULT.checkVictory,
    ).state;
    expect(decided.victory?.winners).toEqual(['combine']);
    const result = readBattleResult(decided, [])!;
    expect(result.battleId).toBe(order.battleId);
    // The CP stands, so the level says the base was taken intact.
    expect(result.level).toBe('complete');

    // Resume the day: Mars changes hands, the survivors dig in, the income
    // waits out the §7 delay, and the winner banks the salvage.
    const before = s.players['combine']!.megacredits;
    s = mustRun(s, { type: 'resolveGroundBattle', by: 'combine', result });
    expect(s.bases[base]!.owner).toBe('combine');
    expect(s.bases[base]!.destroyed).toBe(false);
    const g = dropData(s).garrisons[base]!;
    expect((g.units['HVY'] ?? 0) + (g.units['INF'] ?? 0)).toBeGreaterThan(0);
    expect(g.incomeFrom).toBeGreaterThan(s.turn);
    expect(s.players['combine']!.megacredits).toBeGreaterThan(before);
    expect(dropData(s).pendingGround).toBeNull();
    // The landed transport's holds are empty: the force is ashore for good.
    expect(cargoCount(s.ships['combine-drop-1']!, 'gndHVY')).toBe(0);
  });

  it('fires the guns at unsuppressed landers', () => {
    const { state: s0, base } = staged();
    // Un-silence them again.
    let s = withBase(s0, { ...s0.bases[base]!, suppressed: false });
    s = until(s, (x) => x.phase === 'ordnance' && activePlayer(x) === 'combine');
    s = mustRun(s, { type: 'declareInvasion', by: 'combine', base });
    s = until(s, (x) => dropData(x).pendingGround !== null || dropData(x).invasion === null, 200);
    // Either the lander crashed (invasion failed) or it got down under fire —
    // both are legal outcomes of the 2:1 roll; what must be true is that the
    // guns spoke.
    expect(s.log.some((e) => /guns at .* fire on the lander/i.test(e.text))).toBe(true);
  });
});

describe('The Assault: reserves, assembly, orbital fire', () => {
  const order: OrderOfBattle = {
    battleId: 'drop-9-mars:0',
    seed: 99,
    scenarioId: 'assault',
    sides: [
      {
        player: 'combine',
        faction: 'North American Combine',
        forces: { HVY: 2, INF: 6, MK3: 1 },
      },
      { player: 'paneuro', faction: 'Paneuropean Federation', forces: { HVY: 2, INF: 12 } },
    ],
    terms: {
      world: 'mars',
      profile: 'dead',
      entryEdge: 'west',
      reaction: { HVY: 2 },
      reactionTurn: 5,
      orbitalStrikes: [3],
    },
  };

  const built = ASSAULT.build({ seed: order.seed, order });

  it('holds the reaction force off the map until turn 5, then lets it in', () => {
    const reserves = Object.values(built.units).filter((u) => u.offMap === 'reserve');
    expect(reserves.length).toBe(2);

    const edgeHex = allHexes(ASSAULT.map).find(
      (h) => toOffset(h).col === ASSAULT.map.cols && terrainAt(ASSAULT.map, h) !== 'crater',
    )!;
    const early = ogreApply(
      { ...built, phase: 'movement', playerOrder: built.playerOrder, activePlayerIndex: 1 },
      { type: 'deployReserve', by: 'paneuro', unit: reserves[0]!.id, at: edgeHex },
      ASSAULT.map,
    );
    expect(early.result.ok).toBe(false);

    const turn5 = { ...built, turn: 5, phase: 'movement' as const, activePlayerIndex: 1 };
    const entered = ogreApply(
      turn5,
      { type: 'deployReserve', by: 'paneuro', unit: reserves[0]!.id, at: edgeHex },
      ASSAULT.map,
    );
    expect(entered.result.ok).toBe(true);
    expect(onBoard(entered.state.units[reserves[0]!.id]!)).toBe(true);
  });

  it('keeps an invading Ogre inert until it finishes assembling', () => {
    const ogre = Object.values(built.units).find(
      (u) => u.kind === 'ogre' && u.owner === 'combine',
    )!;
    // A Mark III is size 7: delay max(2, 7-4) = 3, so it activates on turn 4.
    expect(ogre.kind === 'ogre' && ogre.activatesOn).toBe(4);
    const move = ogreApply(
      { ...built, phase: 'movement' as const, activePlayerIndex: 0 },
      { type: 'moveUnit', by: 'combine', unit: ogre.id, path: [] },
      ASSAULT.map,
    );
    expect(move.result.ok).toBe(false);
    expect(move.result.ok ? '' : move.result.reason).toMatch(/assembling/);
  });

  it('spends an orbital strike on the CRT', () => {
    const target = Object.values(built.units).find(
      (u) => u.owner === 'paneuro' && u.kind === 'unit' && u.classId !== 'CP' && onBoard(u),
    )!;
    const inFire = { ...built, phase: 'fire' as const, activePlayerIndex: 0 };
    const struck = ogreApply(
      inFire,
      {
        type: 'orbitalStrike',
        by: 'combine',
        strike: 0,
        target: { kind: 'unit', unit: target.id },
      },
      ASSAULT.map,
    );
    expect(struck.result.ok).toBe(true);
    expect(struck.state.scenarioData['orbitalStrikes']).toEqual([]);
    // The defender cannot call the fleet down.
    const stolen = ogreApply(
      { ...inFire, activePlayerIndex: 1 },
      {
        type: 'orbitalStrike',
        by: 'paneuro',
        strike: 0,
        target: { kind: 'unit', unit: target.id },
      },
      ASSAULT.map,
    );
    expect(stolen.result.ok).toBe(false);
  });
});
