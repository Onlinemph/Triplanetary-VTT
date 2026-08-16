/**
 * The context inspector: everything true about one ship, plus the orders that
 * are legal for it in the phase the game is actually in.
 *
 * The rule the layout follows is that a player should never have to open the
 * rulebook to know why a button is missing — capability checks come from the
 * engine, and their refusal text is shown as the button's tooltip.
 */

import { combatStrength, isDisabled, repairTarget, repairableTracks } from '@engine/combat.js';
import { isZero } from '@engine/hex.js';
import { cargoMass } from '@engine/logistics.js';

import { CARGO, SHIP_CLASSES } from '@engine/ships.js';
import { PHASE_LABELS, activePlayer, controllerOf } from '@engine/types.js';
import { type Child, button, el, fill } from '../components/dom.js';
import { shipGlyph } from '../components/glyphs.js';
import { advancedTracks, damagePips, empty, note, section, statRow } from '../components/meters.js';
import { className, hexText, num, shipLabel, statusOf, vectorText } from '../format.js';
import type { Ctx, Panel } from '../viewmodel.js';
import { astrogationActions } from './astrogation.js';
import { createLogisticsSection, supplyStats } from './logistics.js';
import { ordnanceActions } from './ordnance.js';
import { scenarioOrders } from './scenarioOrders.js';

export const createInspector = (): Panel => {
  const head = el('div', { class: 'panel-head' });
  const body = el('div', { class: 'panel-body' });
  const root = el('div', { class: 'inspector' }, head, body);
  const logisticsSection = createLogisticsSection();

  const update = (ctx: Ctx): void => {
    const { state, map, ui, act } = ctx;
    const ship = ui.selected ? state.ships[ui.selected] : undefined;

    fill(
      head,
      el('h2', { class: 'panel-title', text: ship ? 'Ship' : 'Inspector' }),
      button({
        label: el('span', { class: 'collapse-glyph', text: '›' }),
        onClick: () => act.togglePanel('right'),
        variant: 'quiet',
        class: 'icon-btn collapse-btn',
        title: 'Collapse the inspector',
      }),
    );

    if (!ship || ship.destroyed) {
      fill(
        body,
        empty('Select a ship from the fleet list or the chart.'),
        section(
          `${PHASE_LABELS[state.phase]} phase`,
          el('p', { class: 'hint', text: PHASE_HINT[state.phase] }),
        ),
      );
      return;
    }

    const def = SHIP_CLASSES[ship.shipClass];
    const owner = state.players[ship.owner];
    const status = statusOf(state, map, ship);
    const orbit = map.orbitOf(ship.pos, ship.velocity);
    const controller = controllerOf(ship);
    const mine = controller === activePlayer(state);

    const nodes: Child[] = [];
    // Orders come first. The thing a player has to *do* this phase — plot a
    // course, pick a target, refuel — was previously last, under five blocks of
    // reference stats, and on a short window it sat below the fold with the
    // scrollbar easy to miss. Reference material can be scrolled to; the action
    // cannot be, because you do not know it is there.
    const orders: Child[] = [];

    nodes.push(
      el(
        'div',
        {
          class: 'ship-head',
          style: { '--player': owner?.color ?? '' },
        },
        el('span', { class: 'ship-glyph' }, shipGlyph(ship.shipClass, 30)),
        el(
          'div',
          { class: 'ship-ident' },
          el('span', { class: 'ship-name', text: shipLabel(ship) }),
          el('span', {
            class: 'ship-class',
            text: `${className(ship.shipClass)} · ${owner?.name ?? ship.owner}`,
          }),
        ),
        el('span', {
          class: `ship-status tone-${status.tone}`,
          text: status.word,
        }),
      ),
    );

    if (ship.capturedBy) {
      nodes.push(
        note(
          'warn',
          `Prize crew from ${state.players[ship.capturedBy]?.name ?? ship.capturedBy}. It must reach a base friendly to the captor before it can be used.`,
        ),
      );
    }
    if (ship.surrenderedTo.length > 0) {
      nodes.push(note('warn', 'This ship has surrendered — the bargain is binding.'));
    }

    nodes.push(
      section(
        'Class',
        statRow('Combat strength', `${def.combatStrength}${def.defensiveOnly ? 'D' : ''}`),
        statRow('Effective now', combatStrength(ship)),
        statRow('Fuel capacity', num(def.fuelCapacity)),
        statRow('Cargo capacity', `${num(def.cargoCapacity)} t`),
        statRow('Type', def.warship ? 'warship' : 'commercial'),
        el('p', { class: 'blurb', text: def.blurb }),
      ),
    );

    nodes.push(section('Supply', ...supplyStats(ship)));

    nodes.push(
      section(
        'Vector',
        statRow('Position', hexText(ship.pos)),
        statRow('Velocity', vectorText(ship.velocity)),
        statRow(
          'Gravity carried',
          isZero(ship.pendingGravity) ? 'none' : vectorText(ship.pendingGravity),
        ),
        orbit
          ? statRow(
              'Orbit',
              `${orbit.name}, ${map.orbitSense(ship.pos, ship.velocity) > 0 ? 'counter-clockwise' : 'clockwise'}`,
              'good',
            )
          : statRow('Orbit', 'not in orbit'),
        ship.optionalGravity.length > 0
          ? statRow('Weak gravity', `${ship.optionalGravity.length} optional`, 'warn')
          : null,
      ),
    );

    nodes.push(
      section(
        'Condition',
        state.options.advancedCombat
          ? advancedTracks(ship)
          : el(
              'div',
              { class: 'row-inline' },
              damagePips(ship.disabled),
              el('span', {
                class: 'mono',
                text: ship.disabled > 0 ? `D${ship.disabled}` : 'undamaged',
              }),
            ),
        isDisabled(ship, state.options.advancedCombat)
          ? note(
              'bad',
              ship.shipClass === 'dreadnaught'
                ? 'Disabled: it may not manoeuvre or launch ordnance, but a dreadnaught may still fire its guns.'
                : 'Disabled: it cannot manoeuvre, launch ordnance, or attack. It may only drift.',
            )
          : null,
        ship.heroic ? note('good', 'Heroic — +1 to every gun attack roll, permanently.') : null,
        // "A ship recovers from 1 D a turn ... The owner chooses what kind of
        // damage to recover from." Only worth asking when more than one track is
        // still worth working on; with one there is no choice to make.
        mine && state.options.advancedCombat && repairableTracks(ship).length > 1
          ? el(
              'div',
              { class: 'chips' },
              el('span', { class: 'sel-label', text: 'Repair' }),
              ...repairableTracks(ship).map((track) =>
                button({
                  label: track,
                  variant: repairTarget(ship) === track ? 'primary' : 'quiet',
                  title:
                    repairTarget(ship) === track
                      ? 'The damage-control party is working on this'
                      : `Work on the ${track} instead, one D at the end of each resupply phase`,
                  onClick: () =>
                    act.dispatch({
                      type: 'chooseRepair',
                      by: activePlayer(state),
                      ship: ship.id,
                      track,
                    }),
                }),
              ),
            )
          : null,
        statRow('Overload', ship.overloadAvailable ? 'available' : 'spent'),
        state.options.fogOfWar
          ? statRow(
              'Detected by',
              ship.detectedBy.length === 0
                ? 'nobody'
                : ship.detectedBy.map((p) => state.players[p]?.name ?? p).join(', '),
            )
          : null,
      ),
    );

    nodes.push(
      section(
        'Cargo',
        ship.cargo.length === 0
          ? empty('Hold empty.')
          : el(
              'table',
              { class: 'manifest' },
              el(
                'tbody',
                {},
                ...ship.cargo
                  .filter((c) => c.quantity > 0)
                  .map((c) =>
                    el(
                      'tr',
                      {},
                      el('td', {
                        class: 'manifest-name',
                        text: CARGO[c.kind].name,
                      }),
                      el('td', {
                        class: 'manifest-qty mono',
                        text: num(c.quantity),
                      }),
                      el('td', {
                        class: 'manifest-mass mono',
                        text: `${num(c.quantity * CARGO[c.kind].mass)} t`,
                      }),
                    ),
                  ),
              ),
            ),
        statRow('Total mass', `${num(cargoMass(ship))} t`),
      ),
    );

    // --- Orders ------------------------------------------------------------

    if (!mine) {
      nodes.push(
        section(
          'Orders',
          note('info', `${state.players[controller]?.name ?? controller} commands this ship.`),
        ),
      );
    } else if (state.victory) {
      orders.push(section('Orders', note('info', 'The game is over.')));
    } else {
      switch (state.phase) {
        case 'astrogation':
          orders.push(...astrogationActions(ctx, ship));
          break;
        case 'ordnance':
          orders.push(...ordnanceActions(ctx, ship));
          break;
        case 'movement':
          orders.push(
            section(
              'Movement',
              note(
                'info',
                'Ships and this player’s ordnance travel their plotted courses when the phase ends.',
              ),
            ),
          );
          break;
        case 'combat':
          orders.push(
            section(
              'Combat',
              ship.firedThisPhase
                ? note(
                    'warn',
                    'This ship has already fired: no ship may attack more than once per combat phase.',
                  )
                : note(
                    'info',
                    'Click ships on the chart to build an attack. The odds board is below.',
                  ),
              el(
                'div',
                { class: 'actions' },
                button({
                  label: ui.attackers.includes(ship.id) ? 'Remove from attack' : 'Add as attacker',
                  variant: 'ghost',
                  disabled: def.defensiveOnly || ship.firedThisPhase,
                  title: def.defensiveOnly
                    ? 'A "D" strength is defensive only and may not attack'
                    : undefined,
                  onClick: () => act.toggleAttacker(ship.id),
                }),
              ),
            ),
          );
          break;
        case 'resupply':
          orders.push(...logisticsSection(ctx, ship));
          break;
      }
      // Orders a single scenario adds — a cargo run, a muster. They belong with
      // the rest of this ship's orders rather than in a panel of their own.
      orders.push(...scenarioOrders(ctx, ship));
    }

    // Header, then orders, then the reference stats.
    fill(body, nodes[0]!, ...orders, ...nodes.slice(1));
  };

  return { el: root, update };
};

const PHASE_HINT: Readonly<Record<string, string>> = {
  astrogation:
    'Plot each ship’s course. One fuel point shifts the arrowhead one hex; an overload shifts it two.',
  ordnance: 'Each ship may release one mine, torpedo or nuke — not while at a base or landing.',
  movement: 'Ships fly their plotted courses. Ordnance of the phasing player moves with them.',
  combat: 'Guns fire. Targets may return fire before damage is applied.',
  resupply: 'Refuel, rearm, transfer, loot — then damage recovers by one D.',
};
