/**
 * The frozen sky, online: a fleet table waiting on a ground battle gets a
 * child Ogre table for it, and the child's result comes back as the parent's
 * own settling order. The referee's part is pure — which seats the child
 * gets, and what order settles the parent — and that is what is proved here;
 * the edge function only writes what these return.
 */

import { describe, expect, it } from 'vitest';
import type { BattleResult, OrderOfBattle } from '../src/campaign/orders.js';
import { dropData } from '../src/scenarios/orbitalDrop.js';
import type { GameState as TriState } from '../src/engine/index.js';
import { TRI_RULES } from '../src/net/kinds.js';
import { OGRE_RULES, asOgreState } from '../src/net/ogreRules.js';
import { DEFAULT_ASSAULT } from '../src/ogre/scenarios/index.js';
import {
  type SeatRow,
  type StoredGame,
  childSeats,
  settleParent,
  tableInfo,
} from '../src/net/supabase/referee.js';

const seat = (over: Partial<SeatRow> & { seat: string; ordinal: number }): SeatRow => ({
  faction: over.seat,
  name: over.seat,
  kind: 'human',
  userId: null,
  lastSeen: null,
  ...over,
});

const war = (
  seats: readonly SeatRow[],
  state = TRI_RULES.build('orbital-drop', { seed: 4 }),
): StoredGame => ({
  id: 'war-1',
  code: 'FGKMNP',
  kind: 'tri',
  locked: true,
  scenarioId: 'orbital-drop',
  fog: false,
  status: 'playing',
  state: TRI_RULES.seal(state),
  commandCount: 3,
  seats,
  hostId: 'user-host',
});

const order = (attacker: string, defender: string): OrderOfBattle => ({
  ...DEFAULT_ASSAULT,
  battleId: 'drop-1-base',
  seed: 9,
  sides: [
    { ...DEFAULT_ASSAULT.sides[0]!, player: attacker },
    { ...DEFAULT_ASSAULT.sides[1]!, player: defender },
  ],
});

describe('the child table’s roster', () => {
  it('seats the people who hold the parent’s seats of the same name, and the computer for the rest', () => {
    const tri = TRI_RULES.build('orbital-drop', { seed: 4 });
    const [a, b] = tri.playerOrder;
    const parent = war([
      seat({ seat: a!, ordinal: 0, kind: 'human', userId: 'user-host', name: 'Ann' }),
      seat({ seat: b!, ordinal: 1, kind: 'computer', name: 'Computer' }),
    ]);
    const o = order(a!, 'militia');
    const opening = OGRE_RULES.build(o.scenarioId, { seed: o.seed, order: o });
    const summary = OGRE_RULES.summary(opening);
    const seats = childSeats(parent, o, summary, 1234);
    expect(seats.map((s) => s.seat)).toEqual(summary.playerOrder);
    expect(seats.map((s) => [s.kind, s.userId, s.name])).toEqual([
      ['human', 'user-host', 'Ann'],
      ['computer', null, summary.players['militia']?.name],
    ]);
    expect(seats[0]!.lastSeen).toBe(1234);
    // The defence is a power somebody plays at the parent: they come too.
    const withFriend = war([
      seat({ seat: a!, ordinal: 0, kind: 'human', userId: 'user-host', name: 'Ann' }),
      seat({ seat: b!, ordinal: 1, kind: 'human', userId: 'user-bob', name: 'Bob' }),
    ]);
    const o2 = order(a!, b!);
    const opening2 = OGRE_RULES.build(o2.scenarioId, { seed: o2.seed, order: o2 });
    const seats2 = childSeats(withFriend, o2, OGRE_RULES.summary(opening2), 5);
    expect(seats2.map((s) => [s.kind, s.userId])).toEqual([
      ['human', 'user-host'],
      ['human', 'user-bob'],
    ]);
  });

  it('names the parent and the child on the table info, so a browser can hop', () => {
    const parent = { ...war([]), childId: 'child-1', childCode: 'ABCDEF' };
    expect(tableInfo(parent, null, 0).child).toEqual({ code: 'ABCDEF' });
    expect(tableInfo(parent, null, 0).parent).toBeUndefined();
    const child = { ...war([]), kind: 'ogre' as const, parentId: 'war-1', parentCode: 'FGKMNP' };
    expect(tableInfo(child, null, 0).parent).toEqual({ code: 'FGKMNP' });
  });
});

describe('the fleet game’s hand-off hooks', () => {
  it('names the pending ground battle, and nothing when the sky is clear', () => {
    const state = TRI_RULES.build('orbital-drop', { seed: 4 }) as TriState;
    expect(TRI_RULES.handoff?.(state)).toBeNull();
    const o = order(state.playerOrder[0]!, 'militia');
    const frozen = {
      ...state,
      scenarioData: {
        ...state.scenarioData,
        orbitalDrop: { ...dropData(state), pendingGround: o },
      },
    };
    expect(TRI_RULES.handoff?.(frozen)).toEqual(o);
    expect(TRI_RULES.handoff?.(TRI_RULES.build('bi-planetary', { seed: 1 }))).toBeNull();
  });

  it('settles with a resolveGroundBattle order from the active player', () => {
    const state = TRI_RULES.build('orbital-drop', { seed: 4 });
    const result = {
      battleId: 'drop-1-base',
      winners: ['x'],
      level: 'standard',
    } as unknown as BattleResult;
    const cmd = TRI_RULES.settleCommand?.(state, result) as {
      type: string;
      by: string;
      result: BattleResult;
    };
    expect(cmd.type).toBe('resolveGroundBattle');
    expect(cmd.by).toBe(state.playerOrder[state.activePlayerIndex]);
    expect(cmd.result).toBe(result);
    // A war with no battle pending refuses the result, and says so.
    const out = settleParent(war([]), result, () => 1, TRI_RULES);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/no ground battle/);
  });
});

describe('the ground game’s settlement', () => {
  it('reports a finished battle built from an order, and nothing before it ends', () => {
    const o = order('invader', 'militia');
    const state = OGRE_RULES.seal(OGRE_RULES.build(o.scenarioId, { seed: o.seed, order: o }));
    expect(OGRE_RULES.settle?.(state)).toBeNull();
    const done = {
      ...asOgreState(state),
      victory: { winners: ['militia'], level: 'standard' as const, reason: 'held' },
    };
    const result = OGRE_RULES.settle?.(done);
    expect(result?.battleId).toBe('drop-1-base');
    expect(result?.winners).toEqual(['militia']);
    expect(result?.survivors['invader']).toBeDefined();
    // A printed scenario has no order, and so no result to hand anywhere.
    expect(
      OGRE_RULES.settle?.({
        ...asOgreState(OGRE_RULES.build('mark-iii-attack', { seed: 1 })),
        victory: done.victory,
      }),
    ).toBeNull();
  });
});
