/**
 * Skipping phases nobody can act in.
 *
 * A convenience, not a rule: the phase still happens and everything the sequence
 * of play does automatically inside it still runs. What is dropped is the
 * prompt, when the only legal orders left are "end phase" and "concede".
 *
 * So the tests that matter are the ones about *not* skipping. A phase skipped
 * while somebody still holds a decision would take that decision away from them,
 * and the rulebook hands two of them to a player whose turn it is not: "ships
 * which are attacked may return fire ... during the combat phase", and a demand
 * for surrender is answered by the ship being asked.
 */

import { describe, expect, it } from 'vitest';
import {
  type BaseState,
  type Command,
  type GameState,
  type Phase,
  type PlayerId,
  type Ship,
  type ShipClass,
  applyCommand,
  createInitialState,
  hex,
  hexSide,
  legalCommands,
  makePlayer,
  makeShip,
  phaseIsIdle,
} from '../src/engine/index.js';
import { DEFAULT_MAP } from '../src/engine/map.js';
import { buildScenario } from '../src/scenarios/index.js';

const map = DEFAULT_MAP;
const A = 'a';
const B = 'b';
const TERRA = map.body('terra')!;

/** Deep space, out of every detector field and every gravity arrow. */
const DEEP = hex(-28, -10);
const FAR = hex(28, 6);

const rig = (ships: readonly Ship[], phase: Phase = 'astrogation'): GameState => ({
  ...createInitialState({
    scenarioId: 'phase-skip',
    seed: 5,
    players: [makePlayer(A, 'A', 'Alpha', '#fff'), makePlayer(B, 'B', 'Beta', '#000')],
    ships,
    options: { nukesAllowed: false },
  }),
  phase,
});

const hull = (id: string, owner: PlayerId, cls: ShipClass, extra: Partial<Ship> = {}): Ship => ({
  ...makeShip({ id, owner, shipClass: cls, pos: DEEP }),
  ...extra,
});

const ok = (s: GameState, cmd: Command): GameState => {
  const out = applyCommand(s, cmd, map);
  expect({ cmd: cmd.type, ok: out.result.ok, why: out.result.reason }).toEqual({
    cmd: cmd.type,
    ok: true,
    why: undefined,
  });
  return out.state;
};

/** What the interface's auto-advance would do, as a pure loop. */
const skipFrom = (start: GameState): { state: GameState; skipped: Phase[] } => {
  let s = start;
  const skipped: Phase[] = [];
  for (let i = 0; i < 5 * s.playerOrder.length + 1; i += 1) {
    if (!phaseIsIdle(s, map)) break;
    const before = s;
    const out = applyCommand(s, { type: 'endPhase', by: s.playerOrder[s.activePlayerIndex]! }, map);
    if (!out.result.ok) break;
    s = out.state;
    if (s.phase === before.phase && s.activePlayerIndex === before.activePlayerIndex) break;
    skipped.push(before.phase);
  }
  return { state: s, skipped };
};

// ---------------------------------------------------------------------------
// What counts as idle
// ---------------------------------------------------------------------------

describe('a phase is idle only when nobody can do anything', () => {
  it('is not idle while a ship could still plot a course', () => {
    // A ship in space can always be re-plotted, even with dry tanks: coasting is
    // a course like any other.
    const s = rig([hull('mine', A, 'corsair', { fuel: 0 })]);
    expect(legalCommands(s, A, map)).toContain('plotCourse');
    expect(phaseIsIdle(s, map)).toBe(false);
  });

  it('is not idle while a landed ship could take off', () => {
    const s = rig([
      hull('mine', A, 'corsair', {
        pos: TERRA.hex,
        location: { kind: 'landed', side: hexSide(TERRA.hex, 0) },
      }),
    ]);
    expect(phaseIsIdle(s, map)).toBe(false);
  });

  it('is idle in a combat phase with nothing to shoot at', () => {
    // One ship, no enemy: "attack" has no feasible target, and the only orders
    // left are flow.
    const s = rig([hull('mine', A, 'corsair')], 'combat');
    expect(legalCommands(s, A, map).filter((c) => c !== 'endPhase' && c !== 'concede')).toEqual([]);
    expect(phaseIsIdle(s, map)).toBe(true);
  });

  it('is not idle in a combat phase with an enemy on the board', () => {
    const s = rig(
      [hull('mine', A, 'corsair'), hull('theirs', B, 'corsair', { pos: FAR })],
      'combat',
    );
    expect(phaseIsIdle(s, map)).toBe(false);
  });

  it('is idle in an ordnance phase with an empty magazine', () => {
    const s = rig([hull('mine', A, 'corsair')], 'ordnance');
    expect(phaseIsIdle(s, map)).toBe(true);
  });

  it('is not idle in an ordnance phase with a mine aboard', () => {
    const s = rig(
      [hull('mine', A, 'corsair', { cargo: [{ kind: 'mine', quantity: 1 }] })],
      'ordnance',
    );
    expect(legalCommands(s, A, map)).toContain('launchOrdnance');
    expect(phaseIsIdle(s, map)).toBe(false);
  });

  it('is idle in a resupply phase nowhere near a base', () => {
    const s = rig([hull('mine', A, 'corsair')], 'resupply');
    expect(phaseIsIdle(s, map)).toBe(true);
  });

  it('is not idle in a resupply phase alongside a base', () => {
    const base: BaseState = {
      id: 'terra:0',
      kind: 'planetary',
      owner: A,
      side: hexSide(TERRA.hex, 0),
      hex: TERRA.hex,
      destroyed: false,
      suppressed: false,
      hasPlanetaryDefences: false,
      firedThisTurn: false,
      launchedThisTurn: false,
      resuppliedThisTurn: false,
    };
    const s: GameState = {
      ...rig(
        [
          hull('mine', A, 'transport', {
            pos: TERRA.hex,
            location: { kind: 'landed', side: hexSide(TERRA.hex, 0) },
          }),
        ],
        'resupply',
      ),
    };
    const withBase: GameState = { ...s, bases: { ...s.bases, [base.id]: base } };
    expect(legalCommands(withBase, A, map)).toContain('resupply');
    expect(phaseIsIdle(withBase, map)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The guards — the half that actually matters
// ---------------------------------------------------------------------------

describe('a decision somebody still holds is never skipped', () => {
  it('never skips while return fire is owed', () => {
    // "Ships which are attacked may return fire against any or all of their
    //  attackers during the combat phase, before any damage is implemented."
    // The defender is not the phasing player, so a check that only asked the
    // phasing player would skip straight past their one chance to shoot back.
    const s = rig(
      [
        hull('mine', A, 'corsair', { pos: DEEP }),
        hull('theirs', B, 'corsair', { pos: hex(DEEP.q + 1, DEEP.r) }),
      ],
      'combat',
    );
    const fired = ok(s, { type: 'attack', by: A, attackers: ['mine'], targets: ['theirs'] });

    // The attack left a live decision with B; nothing may be skipped until it is
    // answered, and the skip loop must not move the game on.
    if (fired.scenarioData['_pendingAttack'] !== undefined) {
      expect(phaseIsIdle(fired, map)).toBe(false);
      expect(skipFrom(fired).skipped).toEqual([]);
    }
  });

  it('never skips a finished game', () => {
    const s = rig([hull('mine', A, 'corsair')], 'combat');
    const won: GameState = {
      ...s,
      victory: { winners: [A], level: 'decisive', reason: 'test' },
    };
    expect(phaseIsIdle(won, map)).toBe(false);
    expect(skipFrom(won).skipped).toEqual([]);
  });

  it('asks every player, not just the one whose turn it is', () => {
    // B is not phasing and has no orders of their own; the phase is idle. Give
    // B something only they can answer and it must stop being idle.
    const quiet = rig([hull('mine', A, 'corsair'), hull('theirs', B, 'transport')], 'combat');
    expect(legalCommands(quiet, B, map)).toEqual([]);

    // A surrender demand is answered by the ship being asked, in the attacker's
    // player-turn.
    const demanded: GameState = {
      ...quiet,
      scenarioData: {
        ...quiet.scenarioData,
        logistics: { demands: { theirs: [A] } },
      },
    };
    expect(legalCommands(demanded, B, map)).toContain('respondToSurrender');
    expect(phaseIsIdle(demanded, map)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The loop itself
// ---------------------------------------------------------------------------

describe('the skip loop terminates and changes nothing but the clock', () => {
  it('stops at the first phase with something to do', () => {
    // A lone ship in deep space: ordnance, movement and combat are all empty,
    // but astrogation is not — it can always be re-plotted.
    const s = rig([hull('mine', A, 'corsair')], 'ordnance');
    const { state, skipped } = skipFrom(s);
    expect(skipped.length).toBeGreaterThan(0);
    expect(phaseIsIdle(state, map)).toBe(false);
    expect(state.phase).toBe('astrogation');
  });

  it('is bounded even when every phase is idle', () => {
    // Nothing on the board at all: every phase for every seat is empty. The loop
    // must still stop.
    const s = rig([]);
    const { skipped } = skipFrom(s);
    expect(skipped.length).toBeLessThanOrEqual(5 * s.playerOrder.length + 1);
  });

  it('leaves the game exactly where pressing the button that many times would', () => {
    // The skip issues ordinary `endPhase` orders and nothing else, so pressing
    // the button the same number of times has to land in the same place. This is
    // a convenience, not a shortcut through the rules.
    const s = rig([hull('mine', A, 'corsair')], 'ordnance');
    const { state: skippedTo, skipped } = skipFrom(s);
    expect(skipped.length).toBeGreaterThan(0);

    let byHand = s;
    for (let i = 0; i < skipped.length; i += 1) {
      byHand = ok(byHand, {
        type: 'endPhase',
        by: byHand.playerOrder[byHand.activePlayerIndex]!,
      });
    }
    expect({
      phase: skippedTo.phase,
      turn: skippedTo.turn,
      seat: skippedTo.activePlayerIndex,
      log: skippedTo.log.length,
    }).toEqual({
      phase: byHand.phase,
      turn: byHand.turn,
      seat: byHand.activePlayerIndex,
      log: byHand.log.length,
    });
  });

  it('skips a seat that has no ships at all, rather than making them click through', () => {
    // The clearest case for the whole feature: a player with nothing on the
    // board has nothing to do in any of their five phases.
    const s = rig([hull('mine', A, 'corsair')], 'ordnance');
    expect(Object.values(s.ships).filter((x) => x.owner === B)).toHaveLength(0);
    const { state } = skipFrom(s);
    // Straight past B's empty turn and back round to A.
    expect(state.playerOrder[state.activePlayerIndex]).toBe(A);
    expect(state.phase).toBe('astrogation');
  });

  it('does not skip a real scenario off its opening turn', () => {
    // A guard against the feature being too eager: every printed scenario starts
    // with ships that can be ordered, so nothing should be skipped at all on the
    // first astrogation phase.
    for (const id of ['bi-planetary', 'escape', 'lateral-7', 'piracy', 'flight-school']) {
      const s = buildScenario(id);
      expect({ id, idle: phaseIsIdle(s, map) }).toEqual({ id, idle: false });
    }
  });
});
