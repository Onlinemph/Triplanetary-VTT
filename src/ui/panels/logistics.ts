/**
 * Resupply-phase controls: refuel and rearm, transfer, loot, capture.
 *
 * All four of the ship-to-ship operations need matched courses — "the ships must
 * match courses, i.e. be in the same hex with identical vectors" — so the panel
 * only ever offers the ships that already qualify. Nothing here guesses: it asks
 * `coursesMatched` and shows what comes back.
 */

import { isDisabled } from '@engine/combat.js';
import {
  RESUPPLY_ORDNANCE,
  canResupplyAt,
  cargoMass,
  cargoSpace,
  fuelCapacity,
  hasUnlimitedFuel,
  matchedShips,
} from '@engine/logistics.js';
import { CARGO, type CargoKind, SHIP_CLASSES } from '@engine/ships.js';
import { type Ship, activePlayer, areAllied } from '@engine/types.js';
import { type Child, button, el } from '../components/dom.js';
import { bar, empty, note, section, statRow } from '../components/meters.js';
import { num, shipLabel } from '../format.js';
import type { Ctx } from '../viewmodel.js';

type Loadout = Partial<Record<CargoKind, number>>;

export interface LogisticsSection {
  (ctx: Ctx, ship: Ship): Child[];
}

/**
 * A factory, because the loadout editor and the transfer stepper are half-built
 * orders: they must survive re-renders without being pushed into `UiState`,
 * where they would have nothing to do with the rest of the interface.
 */
export const createLogisticsSection = (): LogisticsSection => {
  let loadoutFor: string | null = null;
  let loadout: Loadout = {};
  let qty = 1;

  const resetLoadout = (ship: Ship): void => {
    loadoutFor = ship.id;
    loadout = {};
    for (const kind of RESUPPLY_ORDNANCE) {
      loadout[kind] = ship.cargo.find((c) => c.kind === kind)?.quantity ?? 0;
    }
  };

  return (ctx: Ctx, ship: Ship): Child[] => {
    const { state, map, act } = ctx;
    const by = activePlayer(state);
    const out: Child[] = [];

    if (loadoutFor !== ship.id) resetLoadout(ship);

    // --- Resupply ----------------------------------------------------------

    const check = canResupplyAt(state, ship, map);
    const capacity = SHIP_CLASSES[ship.shipClass].cargoCapacity;
    const otherMass = ship.cargo
      .filter((c) => !RESUPPLY_ORDNANCE.includes(c.kind))
      .reduce((n, c) => n + c.quantity * CARGO[c.kind].mass, 0);
    const loadMass = RESUPPLY_ORDNANCE.reduce((n, k) => n + (loadout[k] ?? 0) * CARGO[k].mass, 0);
    const fits = otherMass + loadMass <= capacity;

    out.push(
      section(
        'Resupply',
        check.ok
          ? note(
              'good',
              `Matched courses with ${check.baseId}. Refuelling is free and repairs all damage.`,
            )
          : note('warn', check.reason ?? 'No base within reach.'),
        check.ok
          ? el(
              'div',
              { class: 'loadout' },
              ...RESUPPLY_ORDNANCE.map((kind) =>
                stepper(
                  CARGO[kind].name,
                  loadout[kind] ?? 0,
                  (next) => {
                    loadout = { ...loadout, [kind]: Math.max(0, next) };
                    act.refresh();
                  },
                  `${CARGO[kind].mass} t each`,
                ),
              ),
              statRow(
                'Hold',
                `${num(otherMass + loadMass)} / ${num(capacity)} t`,
                fits ? undefined : 'bad',
              ),
            )
          : null,
        check.ok
          ? el(
              'div',
              { class: 'actions' },
              button({
                label: 'Resupply',
                variant: 'primary',
                disabled: !fits || ship.resuppliedThisTurn,
                title: ship.resuppliedThisTurn
                  ? 'Already resupplied this turn'
                  : 'Refuel, repair all damage, restore the overload manoeuvre and rearm',
                onClick: () =>
                  act.dispatch({
                    type: 'resupply',
                    by,
                    ship: ship.id,
                    loadout: RESUPPLY_ORDNANCE.map((kind) => ({
                      kind,
                      quantity: loadout[kind] ?? 0,
                    })),
                  }),
              }),
            )
          : null,
        check.ok
          ? note(
              'info',
              'A ship that resupplies may not fire guns or launch ordnance this player-turn.',
            )
          : null,
      ),
    );

    // --- Course-matched neighbours ----------------------------------------

    const matched = matchedShips(state, ship);
    if (matched.length === 0) {
      out.push(section('Alongside', empty('No ship has matched courses.')));
      return out;
    }

    const friends = matched.filter((s) => areAllied(state, ship.owner, s.owner));
    const foes = matched.filter((s) => !areAllied(state, ship.owner, s.owner));

    if (friends.length > 0) {
      out.push(
        section(
          'Transfer',
          el(
            'div',
            { class: 'row-inline' },
            el('span', { class: 'sel-label', text: 'Amount' }),
            stepper('', qty, (n) => {
              qty = Math.max(1, n);
              act.refresh();
            }),
          ),
          ...friends.map((other) =>
            el(
              'div',
              { class: 'transfer-row' },
              el('span', { class: 'transfer-name', text: shipLabel(other) }),
              el(
                'div',
                { class: 'chips' },
                hasUnlimitedFuel(ship)
                  ? null
                  : button({
                      label: `fuel ${qty}`,
                      variant: 'quiet',
                      disabled: ship.fuel < qty,
                      onClick: () =>
                        act.dispatch({
                          type: 'transferCargo',
                          by,
                          from: ship.id,
                          to: other.id,
                          kind: 'fuel',
                          quantity: qty,
                        }),
                      title: 'Torch ships may not transfer fuel',
                    }),
                ...ship.cargo
                  .filter((c) => c.quantity > 0)
                  .map((c) =>
                    button({
                      label: `${CARGO[c.kind].name} ${Math.min(qty, c.quantity)}`,
                      variant: 'quiet',
                      onClick: () =>
                        act.dispatch({
                          type: 'transferCargo',
                          by,
                          from: ship.id,
                          to: other.id,
                          kind: c.kind,
                          quantity: Math.min(qty, c.quantity),
                        }),
                    }),
                  ),
              ),
            ),
          ),
        ),
      );
    }

    // --- Loot, rescue and capture -----------------------------------------

    const prizes = foes.filter(
      (s) => isDisabled(s, state.options.advancedCombat) || s.surrenderedTo.includes(by),
    );
    if (foes.length > 0) {
      out.push(
        section(
          'Prizes',
          prizes.length === 0
            ? note('warn', 'Only disabled or surrendered ships may be looted or captured.')
            : null,
          ...prizes.map((prize) =>
            el(
              'div',
              { class: 'transfer-row' },
              el('span', { class: 'transfer-name', text: shipLabel(prize) }),
              el(
                'div',
                { class: 'chips' },
                ...prize.cargo
                  .filter((c) => c.quantity > 0)
                  .map((c) =>
                    button({
                      label: `take ${CARGO[c.kind].name}`,
                      variant: 'quiet',
                      disabled: cargoSpace(ship) < c.quantity * CARGO[c.kind].mass,
                      onClick: () =>
                        act.dispatch({
                          type: 'loot',
                          by,
                          ship: ship.id,
                          target: prize.id,
                          items: [{ kind: c.kind, quantity: c.quantity }],
                        }),
                    }),
                  ),
                prize.fuel > 0
                  ? button({
                      label: 'take fuel',
                      variant: 'quiet',
                      onClick: () =>
                        act.dispatch({
                          type: 'loot',
                          by,
                          ship: ship.id,
                          target: prize.id,
                          items: [{ kind: 'fuel', quantity: prize.fuel }],
                        }),
                      title: 'A surrendered ship keeps enough fuel to reach a base',
                    })
                  : null,
                button({
                  label: 'Capture',
                  variant: 'danger',
                  onClick: () =>
                    act.dispatch({
                      type: 'capture',
                      by,
                      ship: ship.id,
                      target: prize.id,
                    }),
                  title: 'A captured ship must reach a base friendly to the captor',
                }),
              ),
            ),
          ),
          ...foes
            .filter((s) => !prizes.includes(s))
            .map((s) =>
              button({
                label: `Demand ${shipLabel(s)} surrender`,
                variant: 'ghost',
                onClick: () =>
                  act.dispatch({
                    type: 'demandSurrender',
                    by,
                    ship: ship.id,
                    target: s.id,
                  }),
              }),
            ),
        ),
      );
    }

    return out;
  };
};

/** Fuel and hold read-outs, shown in every phase. */
export const supplyStats = (ship: Ship): Child[] => {
  const capacity = SHIP_CLASSES[ship.shipClass].cargoCapacity;
  return [
    el(
      'div',
      { class: 'meter-row' },
      el('span', { class: 'meter-label', text: 'Fuel' }),
      bar(ship.fuel, fuelCapacity(ship)),
    ),
    el(
      'div',
      { class: 'meter-row' },
      el('span', { class: 'meter-label', text: 'Hold' }),
      bar(cargoMass(ship), capacity, {
        label: `${num(cargoMass(ship))} of ${num(capacity)} tons`,
      }),
    ),
  ];
};

const stepper = (
  label: string,
  value: number,
  onChange: (next: number) => void,
  hint?: string,
): HTMLElement =>
  el(
    'div',
    { class: 'stepper', ...(hint ? { title: hint } : {}) },
    label ? el('span', { class: 'stepper-label', text: label }) : null,
    button({
      label: '−',
      variant: 'quiet',
      onClick: () => onChange(value - 1),
      class: 'step-btn',
    }),
    el('span', { class: 'stepper-value mono', text: String(value) }),
    button({
      label: '+',
      variant: 'quiet',
      onClick: () => onChange(value + 1),
      class: 'step-btn',
    }),
  );
