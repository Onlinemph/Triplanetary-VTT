/**
 * The fleet list: every ship you are allowed to see, grouped by player.
 *
 * Fog of war is applied here rather than in the renderer's shadow, because a
 * contact you have never made should not appear in a list either — "once a ship
 * has been detected... it remains detected (regardless of range) until it
 * arrives at a friendly base."
 */

import { combatStrength } from '@engine/combat.js';
import { visibleShips } from '@engine/detection.js';
import { fuelCapacity } from '@engine/logistics.js';
import { ORDNANCE_LIFETIME, ordnanceLabel } from '@engine/ordnance.js';
import { SHIP_CLASSES } from '@engine/ships.js';
import { type Ship, activePlayer, areAllied, liveShips } from '@engine/types.js';
import { button, el, fill } from '../components/dom.js';
import { icon, ordnanceGlyph, shipGlyph } from '../components/glyphs.js';
import { empty, miniBar } from '../components/meters.js';
import { className, shipLabel, statusOf } from '../format.js';
import type { Ctx, Panel } from '../viewmodel.js';

export const createFleetPanel = (): Panel => {
  const body = el('div', { class: 'panel-body' });
  const head = el('div', { class: 'panel-head' });
  const root = el('aside', { class: 'panel panel-left', 'aria-label': 'Fleets' }, head, body);

  const update = (ctx: Ctx): void => {
    const { state, ui, act, viewer } = ctx;

    const ships = state.options.fogOfWar ? visibleShips(state, viewer) : liveShips(state);
    const byPlayer = new Map<string, Ship[]>();
    for (const id of state.playerOrder) byPlayer.set(id, []);
    for (const s of ships) {
      const list = byPlayer.get(s.owner);
      if (list) list.push(s);
      else byPlayer.set(s.owner, [s]);
    }

    fill(
      head,
      el('h2', { class: 'panel-title', text: 'Fleets' }),
      el('span', { class: 'panel-count mono', text: String(ships.length) }),
      button({
        label: icon('chevron'),
        onClick: () => act.togglePanel('left'),
        variant: 'quiet',
        class: 'icon-btn collapse-btn',
        title: 'Collapse the fleet list',
      }),
    );

    const groups: HTMLElement[] = [];

    for (const playerId of state.playerOrder) {
      const player = state.players[playerId];
      if (!player) continue;
      const list = (byPlayer.get(playerId) ?? []).slice().sort((a, b) => {
        const rank =
          SHIP_CLASSES[b.shipClass].combatStrength - SHIP_CLASSES[a.shipClass].combatStrength;
        return rank !== 0 ? rank : a.number - b.number;
      });
      if (list.length === 0 && player.eliminated) continue;

      const collapsed = ui.collapsedPlayers.includes(playerId);
      const isActive = playerId === activePlayer(state);
      const strength = list.reduce((n, s) => n + combatStrength(s), 0);

      const header = el(
        'button',
        {
          class: `group-head${isActive ? ' is-active' : ''}${collapsed ? ' is-collapsed' : ''}`,
          type: 'button',
          'aria-expanded': String(!collapsed),
          onclick: () => act.togglePlayerGroup(playerId),
        },
        el('span', { class: 'group-caret' }, icon('chevron', 12)),
        el('i', { class: 'player-dot' }),
        el('span', { class: 'group-name', text: player.name }),
        // "2 · 4" read as a score, a ratio, or a version number to everyone who
        // saw it. Say which number is which.
        el(
          'span',
          {
            class: 'group-meta',
            title: `${list.length} ship${list.length === 1 ? '' : 's'}, ${strength} combat strength between them`,
          },
          el('span', { class: 'meta-num mono', text: String(list.length) }),
          el('span', { class: 'meta-unit', text: list.length === 1 ? 'ship' : 'ships' }),
          el('span', { class: 'meta-num mono', text: String(strength) }),
          el('span', { class: 'meta-unit', text: 'str' }),
        ),
      );

      const rows = collapsed ? [] : list.map((ship) => shipRow(ctx, ship));

      groups.push(
        el(
          'div',
          {
            class: 'group',
            style: { '--player': player.color },
          },
          header,
          collapsed ? null : el('div', { class: 'group-body' }, ...rows),
        ),
      );
    }

    // Ordnance in flight — mines, torpedoes and nukes are live for five turns and
    // are easy to lose track of, so they get their own group.
    const ordnance = Object.values(state.ordnance).filter(
      (o) => !state.options.fogOfWar || areAllied(state, viewer, o.owner),
    );
    if (ordnance.length > 0) {
      groups.push(
        el(
          'div',
          { class: 'group group-ordnance' },
          el(
            'div',
            { class: 'group-head is-static' },
            el('span', { class: 'group-name', text: 'Ordnance in flight' }),
            el('span', {
              class: 'group-meta mono',
              text: String(ordnance.length),
            }),
          ),
          el(
            'div',
            { class: 'group-body' },
            ...ordnance.map((o) => {
              const player = state.players[o.owner];
              return el(
                'div',
                {
                  class: 'row row-ordnance',
                  style: player ? { '--player': player.color } : {},
                  onclick: () => {
                    act.focusOn(o.pos);
                    act.flash([o.pos]);
                  },
                  title: `${ordnanceLabel(o)} — ${o.turnsRemaining} of ${ORDNANCE_LIFETIME} turns left`,
                },
                el('span', { class: 'row-glyph' }, ordnanceGlyph(o.kind)),
                el('span', { class: 'row-name', text: ordnanceLabel(o) }),
                el('span', {
                  class: 'row-status mono',
                  text: `${o.turnsRemaining}t`,
                }),
              );
            }),
          ),
        ),
      );
    }

    fill(body, ...(groups.length > 0 ? groups : [empty('No contacts.')]));
  };

  return { el: root, update };
};

const shipRow = (ctx: Ctx, ship: Ship): HTMLElement => {
  const { state, map, ui, act } = ctx;
  const def = SHIP_CLASSES[ship.shipClass];
  const status = statusOf(state, map, ship);
  const selected = ui.selected === ship.id;
  const attacker = ui.attackers.includes(ship.id);
  const target = ui.targets.includes(ship.id);
  const capacity = fuelCapacity(ship);

  const classes = ['row'];
  if (selected) classes.push('is-selected');
  if (attacker) classes.push('is-attacker');
  if (target) classes.push('is-target');
  if (ship.disabled > 0) classes.push('is-disabled');
  if (ship.heroic) classes.push('is-heroic');

  return el(
    'div',
    {
      class: classes.join(' '),
      role: 'button',
      tabindex: '0',
      'aria-pressed': String(selected),
      title: `${className(ship.shipClass)} — combat ${def.combatStrength}${def.defensiveOnly ? 'D' : ''}`,
      onclick: () => act.select(ship.id, true),
      onkeydown: (ev: KeyboardEvent) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          act.select(ship.id, true);
        }
      },
    },
    el('span', { class: 'row-glyph' }, shipGlyph(ship.shipClass, 18)),
    el(
      'span',
      { class: 'row-main' },
      el(
        'span',
        { class: 'row-name' },
        shipLabel(ship),
        ship.heroic
          ? el('i', {
              class: 'heroic-mark',
              title: 'Heroic: +1 to gun attacks',
              text: '★',
            })
          : null,
        ship.capturedBy ? el('i', { class: 'prize-mark', title: 'Prize crew', text: '⚑' }) : null,
      ),
      miniBar(ship.fuel, capacity),
    ),
    el(
      'span',
      { class: 'row-side' },
      el('span', {
        class: `row-status tone-${status.tone}`,
        text: status.word,
      }),
      ship.disabled > 0
        ? el('span', { class: 'row-damage mono', text: `D${ship.disabled}` })
        : null,
    ),
  );
};
