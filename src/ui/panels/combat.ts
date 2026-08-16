/**
 * The gunnery board.
 *
 * Everything the rules make you compute by hand — the strength ratio, the
 * rounding, the two die modifiers, the line of sight — is shown live before the
 * die is rolled, because "if rounding is necessary, it is always done in favor
 * of the defender" is the kind of rule players get wrong in their heads.
 *
 * The counterattack prompt lives here too: "ships which are attacked may return
 * fire against any or all of their attackers during the combat phase, before any
 * damage is implemented."
 */

import { canFire, combatStrength, pendingCounterattack, previewAttack } from '@engine/combat.js';
import { type OddsColumn, gunDamage } from '@engine/crt.js';
import { add, sideGravityHex } from '@engine/hex.js';
import { logisticsData } from '@engine/logistics.js';
import { baseTorpedoAimOptions, canLaunchBaseTorpedo } from '@engine/ordnance.js';

import { SHIP_CLASSES } from '@engine/ships.js';
import type { Counterattack } from '@engine/commands.js';
import {
  type PlayerId,
  type Ship,
  type ShipId,
  activePlayer,
  areAllied,
  liveShips,
  controllerOf,
} from '@engine/types.js';
import { type Child, button, el, fill } from '../components/dom.js';
import { empty, note, section, statRow } from '../components/meters.js';
import { damageText, hexText, shipLabel, signed } from '../format.js';
import type { Ctx, Panel } from '../viewmodel.js';

interface CounterDraft {
  readonly signature: string;
  attackers: Set<ShipId>;
  targets: Set<ShipId>;
  /** Pooled strength to hold back to, or null for everything the ships have. */
  strength: number | null;
}

/**
 * The order the "Return fire" button sends.
 *
 * "A ship may always attack or counterattack with less than its rated combat
 * strength, if it hopes to disable a target without destroying it." The limit
 * rides on a counterattack exactly as it does on an attack, so it has to be
 * carried here; a draft left at full pooled strength omits the field.
 */
export const counterattackCommand = (
  by: PlayerId,
  attackers: readonly ShipId[],
  targets: readonly ShipId[],
  strength: number | null,
): Counterattack => ({
  type: 'counterattack',
  by,
  attackers: [...attackers],
  targets: [...targets],
  ...(strength !== null ? { strength } : {}),
});

/**
 * The base torpedo. A base has no hold to draw from — "All bases (planetary,
 * asteroid, and orbital) carry an unlimited supply of fuel, mines, and
 * torpedoes" — and stands still, so its whole vector is the launch boost.
 */
const baseTorpedoSection = (ctx: Ctx): Child[] => {
  const { state, map, act } = ctx;
  const by = activePlayer(state);
  const armed = Object.values(state.bases)
    .filter((b) => canLaunchBaseTorpedo(state, b, by, map).ok)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  if (armed.length === 0) return [];

  return [
    section(
      'Base torpedoes',
      ...armed.map((base) =>
        el(
          'div',
          { class: 'actions' },
          el('span', { class: 'sel-label', text: base.id }),
          ...baseTorpedoAimOptions(base, map).map((aim) =>
            button({
              label: hexText(add(base.hex, aim)),
              variant: 'ghost',
              title: 'One torpedo per turn; it may accelerate one or two hexes in any direction',
              onClick: () => act.dispatch({ type: 'launchBaseTorpedo', by, base: base.id, aim }),
            }),
          ),
        ),
      ),
    ),
  ];
};

export const createCombatPanel = (): Panel => {
  const root = el('div', { class: 'combat-panel' });
  let draft: CounterDraft | null = null;

  const update = (ctx: Ctx): void => {
    const { state, map, ui, act } = ctx;
    const pending = pendingCounterattack(state);

    if (pending) {
      const signature = `${pending.attackers.join(',')}|${pending.targets.join(',')}`;
      if (!draft || draft.signature !== signature) {
        // Default to everyone firing at everyone: the common case, and the one
        // the rules describe first.
        draft = {
          signature,
          attackers: new Set(pending.attackers),
          targets: new Set(pending.targets),
          strength: null,
        };
      }
      fill(root, ...counterattackPrompt(ctx, pending, draft));
      return;
    }
    draft = null;

    // "They are capable of launching one torpedo per turn" (Ceres and
    // Clandestine); an orbital base "may fire one torpedo per turn, providing
    // resupply operations are not in progress". A base shoots in the ordnance
    // phase, before anybody moves.
    if (state.phase === 'ordnance') {
      fill(root, ...baseTorpedoSection(ctx));
      return;
    }

    if (state.phase !== 'combat') {
      fill(root);
      return;
    }

    const nodes: Child[] = [];
    const attackers = ui.attackers
      .map((id) => state.ships[id])
      .filter((s): s is Ship => s !== undefined && !s.destroyed);
    const targets = ui.targets
      .map((id) => state.ships[id])
      .filter((s): s is Ship => s !== undefined && !s.destroyed);

    nodes.push(
      section(
        'Attack',
        el(
          'div',
          { class: 'sel-block' },
          el('span', { class: 'sel-label', text: 'Attackers' }),
          attackers.length === 0
            ? el('span', {
                class: 'sel-hint',
                text: 'click your ships on the map or in the fleet list',
              })
            : el(
                'div',
                { class: 'chips' },
                ...attackers.map((s) =>
                  selChip(s, () => act.toggleAttacker(s.id), state.players[s.owner]?.color),
                ),
              ),
        ),
        el(
          'div',
          { class: 'sel-block' },
          el('span', { class: 'sel-label', text: 'Targets' }),
          targets.length === 0
            ? el('span', {
                class: 'sel-hint',
                text: 'click enemy ships to add them',
              })
            : el(
                'div',
                { class: 'chips' },
                ...targets.map((s) =>
                  selChip(s, () => act.toggleTarget(s.id), state.players[s.owner]?.color),
                ),
              ),
        ),
      ),
    );

    if (attackers.length > 0 && targets.length > 0) {
      const preview = previewAttack(
        state,
        attackers.map((s) => s.id),
        targets.map((s) => s.id),
        map,
        ui.limitedStrength ?? undefined,
        'attack',
      );
      nodes.push(oddsBlock(ctx, preview));

      const maxStrength = attackers.reduce((n, s) => n + combatStrength(s), 0);
      nodes.push(
        section(
          'Limited attack',
          el(
            'div',
            { class: 'row-inline' },
            el('input', {
              type: 'range',
              min: '1',
              max: String(Math.max(1, maxStrength)),
              value: String(ui.limitedStrength ?? maxStrength),
              class: 'slider',
              'aria-label': 'Attack strength',
              oninput: (ev: Event) => {
                const v = Number((ev.target as HTMLInputElement).value);
                act.setLimitedStrength(v >= maxStrength ? null : v);
              },
            }),
            el('span', {
              class: 'mono strength-readout',
              text: String(ui.limitedStrength ?? maxStrength),
            }),
          ),
          note(
            'info',
            'Attack with less than full strength to disable a prize without destroying it.',
          ),
        ),
      );

      nodes.push(
        el(
          'div',
          { class: 'actions actions-wide' },
          button({
            label: 'Fire',
            variant: 'danger',
            disabled: !preview.legal,
            title: preview.legal ? 'Resolve the attack' : preview.reason,
            onClick: () => {
              const ok = act.dispatch({
                type: 'attack',
                by: activePlayer(state),
                attackers: attackers.map((s) => s.id),
                targets: targets.map((s) => s.id),
                ...(ui.limitedStrength !== null ? { strength: ui.limitedStrength } : {}),
              });
              if (ok) act.clearCombatSelection();
            },
          }),
          button({
            label: 'Clear',
            variant: 'quiet',
            onClick: () => act.clearCombatSelection(),
          }),
        ),
      );
    }

    // --- Planetary defences ------------------------------------------------
    // "Planetary defenses may fire at 2:1 odds at any ship in the gravity hex
    // directly above their hex side. Range and velocity modifiers do not apply."
    const defences = Object.values(state.bases).filter(
      (b) =>
        b.hasPlanetaryDefences &&
        !b.destroyed &&
        !b.firedThisTurn &&
        b.side !== undefined &&
        b.owner !== null &&
        areAllied(state, b.owner, activePlayer(state)),
    );
    const defenceShots = defences
      .map((b) => {
        const hex = sideGravityHex(b.side!);
        const marks = liveShips(state).filter(
          (s) =>
            !areAllied(state, s.owner, activePlayer(state)) &&
            s.pos.q === hex.q &&
            s.pos.r === hex.r,
        );
        return { base: b, marks };
      })
      .filter((d) => d.marks.length > 0);

    if (defenceShots.length > 0) {
      nodes.push(
        section(
          'Planetary defences',
          ...defenceShots.map((d) =>
            el(
              'div',
              { class: 'actions' },
              button({
                label: `Fire ${d.base.id} at ${d.marks.map(shipLabel).join(', ')}`,
                variant: 'ghost',
                onClick: () =>
                  act.dispatch({
                    type: 'firePlanetaryDefence',
                    by: activePlayer(state),
                    base: d.base.id,
                    targets: d.marks.map((s) => s.id),
                  }),
                title: '2:1 odds, no range or velocity modifiers',
              }),
            ),
          ),
        ),
      );
    }

    // --- Surrender ---------------------------------------------------------
    const demands = logisticsData(state).demands;
    const mine = Object.entries(demands).filter(([shipId]) => {
      const s = state.ships[shipId];
      return s !== undefined && !s.destroyed && controllerOf(s) === activePlayer(state);
    });
    if (mine.length > 0) {
      nodes.push(
        section(
          'Surrender demanded',
          ...mine.flatMap(([shipId, from]) =>
            (from ?? []).map((byId) => {
              const ship = state.ships[shipId]!;
              const demander = state.ships[byId];
              return el(
                'div',
                { class: 'actions' },
                el('span', {
                  class: 'sel-hint',
                  text: `${shipLabel(ship)} ← ${demander ? shipLabel(demander) : byId}`,
                }),
                button({
                  label: 'Surrender',
                  variant: 'ghost',
                  onClick: () =>
                    act.dispatch({
                      type: 'respondToSurrender',
                      by: activePlayer(state),
                      ship: shipId,
                      to: byId,
                      accept: true,
                    }),
                  title: 'Surrender is a binding bargain',
                }),
                button({
                  label: 'Refuse',
                  variant: 'quiet',
                  onClick: () =>
                    act.dispatch({
                      type: 'respondToSurrender',
                      by: activePlayer(state),
                      ship: shipId,
                      to: byId,
                      accept: false,
                    }),
                }),
              );
            }),
          ),
        ),
      );
    }

    if (nodes.length === 0) nodes.push(empty('Select an attacker and a target.'));
    fill(root, ...nodes);
  };

  return { el: root, update };
};

// ---------------------------------------------------------------------------

const selChip = (ship: Ship, onRemove: () => void, color?: string): HTMLElement =>
  el(
    'button',
    {
      class: 'sel-chip',
      type: 'button',
      title: 'Remove from the selection',
      style: color ? { '--player': color } : {},
      onclick: onRemove,
    },
    el('span', { class: 'sel-chip-name', text: shipLabel(ship) }),
    el('span', {
      class: 'sel-chip-str mono',
      text: String(combatStrength(ship)),
    }),
    el('span', { class: 'sel-chip-x', text: '×' }),
  );

interface PreviewLike {
  legal: boolean;
  reason?: string;
  attackStrength: number;
  defenceStrength: number;
  column: OddsColumn | null;
  range: number;
  relativeVelocity: number;
  modifiers: {
    range: number;
    relativeVelocity: number;
    heroic: boolean;
    total: number;
  };
  blockedBy?: string;
}

/** The whole combat calculation, broken out the way the rulebook computes it. */
const oddsBlock = (ctx: Ctx, p: PreviewLike): HTMLElement => {
  const { map } = ctx;
  const rows: Child[] = [
    statRow('Attack strength', p.attackStrength),
    statRow('Defence strength', p.defenceStrength),
    statRow('Odds column', p.column ?? 'no effect', p.column === null ? 'bad' : 'good'),
    statRow(
      'Range',
      `${p.range} hex → ${signed(p.modifiers.range)}`,
      p.modifiers.range < 0 ? 'warn' : undefined,
    ),
    statRow(
      'Relative velocity',
      `${p.relativeVelocity} hex → ${signed(p.modifiers.relativeVelocity)}`,
      p.modifiers.relativeVelocity < 0 ? 'warn' : undefined,
    ),
  ];
  if (p.modifiers.heroic) rows.push(statRow('Heroic', '+1', 'good'));
  rows.push(
    statRow('Die modifier', signed(p.modifiers.total), p.modifiers.total < 0 ? 'warn' : 'good'),
  );

  if (p.blockedBy) {
    rows.push(
      note(
        'bad',
        `Line of sight is blocked by ${map.body(p.blockedBy)?.name ?? p.blockedBy}. Attacks may not be made through moons, planets or Sol.`,
      ),
    );
  }
  if (!p.legal && p.reason) rows.push(note('warn', p.reason));

  if (p.column) {
    // Show the actual outcome of each face, modifiers already applied — the
    // number a player would otherwise have to look up twice.
    rows.push(
      el(
        'div',
        { class: 'roll-table' },
        ...[1, 2, 3, 4, 5, 6].map((face) => {
          const result = gunDamage(p.column!, face + p.modifiers.total);
          return el(
            'div',
            {
              class: `roll-cell${result === null ? ' is-null' : ''}${result === 'E' ? ' is-kill' : ''}`,
            },
            el('span', { class: 'roll-face mono', text: String(face) }),
            el('span', { class: 'roll-result mono', text: damageText(result) }),
          );
        }),
      ),
    );
  }

  return section('Odds', ...rows);
};

// ---------------------------------------------------------------------------

const counterattackPrompt = (
  ctx: Ctx,
  pending: { attackers: ShipId[]; targets: ShipId[] },
  draft: CounterDraft,
): Child[] => {
  const { state, map, act } = ctx;
  const eligible = pending.attackers
    .map((id) => state.ships[id])
    .filter((s): s is Ship => s !== undefined && !s.destroyed);
  const marks = pending.targets
    .map((id) => state.ships[id])
    .filter((s): s is Ship => s !== undefined && !s.destroyed);

  const defender = eligible[0] ? controllerOf(eligible[0]) : null;
  const defenderName = defender ? (state.players[defender]?.name ?? defender) : 'The defender';

  const chosenAttackers = eligible.filter((s) => draft.attackers.has(s.id));
  const chosenTargets = marks.filter((s) => draft.targets.has(s.id));

  // "A ship may always attack or counterattack with less than its rated combat
  // strength." Deselecting ships is not a substitute — a lone defender has to be
  // able to hold back part of its own strength.
  const maxStrength = chosenAttackers.reduce((n, s) => n + combatStrength(s), 0);
  if (draft.strength !== null && draft.strength >= maxStrength) draft.strength = null;
  const limited = draft.strength;

  const preview =
    chosenAttackers.length > 0 && chosenTargets.length > 0
      ? previewAttack(
          state,
          chosenAttackers.map((s) => s.id),
          chosenTargets.map((s) => s.id),
          map,
          limited ?? undefined,
          'counterattack',
        )
      : null;

  const toggleRow = (
    ships: readonly Ship[],
    set: Set<ShipId>,
    label: string,
    disabledNote: (s: Ship) => string | null,
  ): HTMLElement =>
    el(
      'div',
      { class: 'sel-block' },
      el('span', { class: 'sel-label', text: label }),
      el(
        'div',
        { class: 'chips' },
        ...ships.map((s) => {
          const why = disabledNote(s);
          return el(
            'button',
            {
              class: `sel-chip${set.has(s.id) ? ' is-on' : ''}${why ? ' is-off' : ''}`,
              type: 'button',
              ...(why ? { disabled: true, title: why } : {}),
              style: { '--player': state.players[s.owner]?.color ?? '' },
              onclick: () => {
                if (set.has(s.id)) set.delete(s.id);
                else set.add(s.id);
                act.refresh();
              },
            },
            el('span', { class: 'sel-chip-name', text: shipLabel(s) }),
            el('span', {
              class: 'sel-chip-str mono',
              text: String(combatStrength(s)),
            }),
          );
        }),
      ),
    );

  return [
    el(
      'div',
      { class: 'counter-banner' },
      el('strong', { text: `${defenderName} may return fire` }),
      el('span', {
        text: 'Damage from the attack is held until this is answered — odds are recomputed in favour of the new defender.',
      }),
    ),
    section(
      'Return fire',
      toggleRow(eligible, draft.attackers, 'Firing', (s) =>
        SHIP_CLASSES[s.shipClass].defensiveOnly
          ? 'A "D" strength is defensive only and may not counterattack'
          : !canFire(s, state.options.advancedCombat)
            ? `${shipLabel(s)} cannot fire`
            : null,
      ),
      toggleRow(marks, draft.targets, 'At', () => null),
    ),
    preview ? oddsBlock(ctx, preview) : empty('Choose at least one ship on each side.'),
    maxStrength > 1
      ? section(
          'Limited return fire',
          el(
            'div',
            { class: 'row-inline' },
            el('input', {
              type: 'range',
              min: '1',
              max: String(maxStrength),
              value: String(limited ?? maxStrength),
              class: 'slider',
              'aria-label': 'Return fire strength',
              oninput: (ev: Event) => {
                const v = Number((ev.target as HTMLInputElement).value);
                draft.strength = v >= maxStrength ? null : v;
                act.refresh();
              },
            }),
            el('span', {
              class: 'mono strength-readout',
              text: String(limited ?? maxStrength),
            }),
          ),
          note('info', 'Return fire with less than full strength to disable rather than destroy.'),
        )
      : null,
    el(
      'div',
      { class: 'actions actions-wide' },
      button({
        label: 'Return fire',
        variant: 'danger',
        disabled: preview === null || !preview.legal,
        title: preview?.reason ?? 'Resolve the counterattack',
        onClick: () =>
          act.dispatch(
            counterattackCommand(
              defender ?? activePlayer(state),
              chosenAttackers.map((s) => s.id),
              chosenTargets.map((s) => s.id),
              limited,
            ),
          ),
      }),
      button({
        label: 'Hold fire',
        variant: 'ghost',
        onClick: () =>
          act.dispatch({
            type: 'declineCounterattack',
            by: defender ?? activePlayer(state),
          }),
        title: 'Take the damage as rolled',
      }),
    ),
  ];
};
