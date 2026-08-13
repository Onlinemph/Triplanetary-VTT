/**
 * Ordnance phase controls.
 *
 * "Each ship may release only one item per turn (one mine, one torpedo, or one
 * nuke). Ordnance may not be launched while the ship is at a base, refueling...
 * or taking off from or landing on a planet." All of that is checked by
 * `canLaunch`; this panel's job is to *show the reason* rather than grey a
 * button out silently.
 */

import {
  ORDNANCE_LIFETIME,
  canLaunch,
  launcherOf,
  ordnanceLabel,
  ownMineConflict,
} from '@engine/ordnance.js';
import { cargoCount } from '@engine/state.js';
import { CARGO } from '@engine/ships.js';
import { type OrdnanceKind, type Ship, activePlayer } from '@engine/types.js';
import { type Child, button, el } from '../components/dom.js';
import { ordnanceGlyph } from '../components/glyphs.js';
import { empty, note, section, statRow } from '../components/meters.js';
import { hexText } from '../format.js';
import type { Ctx } from '../viewmodel.js';

const KINDS: readonly OrdnanceKind[] = ['mine', 'torpedo', 'nuke'];

export const ordnanceActions = (ctx: Ctx, ship: Ship): Child[] => {
  const { state, map, ui, act } = ctx;
  const out: Child[] = [];
  const by = activePlayer(state);

  const held = KINDS.map((kind) => ({
    kind,
    count: cargoCount(ship, kind),
  })).filter((h) => h.count > 0);

  out.push(
    section(
      'Magazine',
      held.length === 0
        ? empty('No ordnance aboard.')
        : el(
            'div',
            { class: 'magazine' },
            ...held.map(({ kind, count }) => {
              const check = canLaunch(state, ship, kind, map);
              const aiming = ui.aiming === kind;
              return el(
                'div',
                { class: 'mag-row' },
                el('span', { class: 'mag-glyph' }, ordnanceGlyph(kind)),
                el('span', { class: 'mag-name', text: CARGO[kind].name }),
                el('span', { class: 'mag-count mono', text: `×${count}` }),
                kind === 'torpedo'
                  ? button({
                      label: aiming ? 'Cancel aim' : 'Aim',
                      variant: aiming ? 'quiet' : 'ghost',
                      disabled: !check.ok,
                      title: check.ok
                        ? 'A torpedo may accelerate one or two hexes on its launch turn, and only then'
                        : check.reason,
                      onClick: () => act.setAiming(aiming ? null : 'torpedo'),
                    })
                  : null,
                button({
                  label: 'Launch',
                  variant: 'ghost',
                  disabled: !check.ok,
                  title: check.ok
                    ? kind === 'mine'
                      ? 'The mine takes this ship’s vector; the ship must then change course'
                      : 'Launch on the current vector'
                    : check.reason,
                  onClick: () => {
                    act.setAiming(null);
                    act.dispatch({
                      type: 'launchOrdnance',
                      by,
                      ship: ship.id,
                      kind,
                    });
                  },
                }),
              );
            }),
          ),
      ui.aiming === 'torpedo'
        ? note(
            'info',
            'Click a highlighted hex to set the torpedo’s vector, or launch unaccelerated.',
          )
        : null,
    ),
  );

  // "That ship must execute an immediate course change to insure that it does not
  // remain in the same hex as the mine."
  const conflict = ownMineConflict(state, ship, map);
  if (conflict) {
    out.push(
      note(
        'bad',
        `${ship.name ?? 'This ship'} shares its endpoint (${hexText(conflict.hex)}) with the mine it just laid — change course before the movement phase.`,
      ),
    );
  }

  const own = Object.values(state.ordnance).filter((o) => launcherOf(state, o.id) === ship.id);
  if (own.length > 0) {
    out.push(
      section(
        'Launched by this ship',
        ...own.map((o) =>
          el(
            'div',
            { class: 'mag-row' },
            el('span', { class: 'mag-glyph' }, ordnanceGlyph(o.kind)),
            el('span', { class: 'mag-name', text: ordnanceLabel(o) }),
            el('span', {
              class: 'mag-count mono',
              text: `${o.turnsRemaining}/${ORDNANCE_LIFETIME}`,
            }),
            button({
              label: 'Scuttle',
              variant: 'quiet',
              onClick: () => act.dispatch({ type: 'scuttleOrdnance', by, ordnance: o.id }),
              title: 'Detonate it harmlessly rather than keep tracking it',
            }),
          ),
        ),
        statRow('Active life', `${ORDNANCE_LIFETIME} turns, then self-destruct`),
      ),
    );
  }

  return out;
};
