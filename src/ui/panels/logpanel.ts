/**
 * The log: a running account of the game in rules language.
 *
 * Append-only rendering, because the log is the one panel that must not jump
 * while you are reading it. Hovering an entry pulses the hexes it happened in —
 * the cheapest possible bridge between "a corvette was destroyed" and *where*.
 */

import { PHASE_LABELS, type LogEntry } from '@engine/types.js';
import { button, el, fill } from '../components/dom.js';
import { empty } from '../components/meters.js';
import type { Ctx, Panel } from '../viewmodel.js';

const NEAR_BOTTOM_PX = 48;

export const createLogPanel = (): Panel => {
  const list = el('div', {
    class: 'log-list',
    role: 'log',
    'aria-live': 'polite',
  });
  const head = el('div', { class: 'panel-head' });
  const root = el('section', { class: 'panel panel-bottom', 'aria-label': 'Log' }, head, list);

  let renderedCount = 0;
  let renderedFirstId: number | null = null;

  const update = (ctx: Ctx): void => {
    const { state, act } = ctx;

    fill(
      head,
      el('h2', { class: 'panel-title', text: 'Log' }),
      el('span', { class: 'panel-count mono', text: String(state.log.length) }),
      button({
        label: el('span', { class: 'collapse-glyph', text: '⌄' }),
        onClick: () => root.classList.toggle('is-min'),
        variant: 'quiet',
        class: 'icon-btn collapse-btn',
        title: 'Minimise the log',
      }),
    );

    const first = state.log[0]?.id ?? null;
    // Undo (or a new game) can shorten or replace the log; only then rebuild.
    if (state.log.length < renderedCount || first !== renderedFirstId) {
      fill(list);
      renderedCount = 0;
      renderedFirstId = first;
    }

    if (state.log.length === 0) {
      if (list.childElementCount === 0) list.appendChild(empty('The game has not begun.'));
      return;
    }
    if (renderedCount === 0) fill(list);

    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < NEAR_BOTTOM_PX;

    for (let i = renderedCount; i < state.log.length; i++) {
      const entry = state.log[i]!;
      list.appendChild(row(ctx, entry));
    }
    renderedCount = state.log.length;

    if (nearBottom) list.scrollTop = list.scrollHeight;
    void act;
  };

  return { el: root, update };
};

const row = (ctx: Ctx, entry: LogEntry): HTMLElement => {
  const { state, act } = ctx;
  const player = entry.player ? state.players[entry.player] : undefined;
  const focus = entry.focus ?? [];

  return el(
    'div',
    {
      class: `log-row sev-${entry.severity}${focus.length > 0 ? ' has-focus' : ''}`,
      style: player ? { '--player': player.color } : {},
      onmouseenter: () => {
        if (focus.length > 0) act.flash(focus);
      },
      onmouseleave: () => {
        if (focus.length > 0) act.flash([]);
      },
      onclick: () => {
        const first = focus[0];
        if (first) {
          act.focusOn(first);
          act.flash(focus);
        }
      },
      title: `${PHASE_LABELS[entry.phase]} phase${player ? ` · ${player.name}` : ''}`,
    },
    el('span', { class: 'log-turn mono', text: String(entry.turn) }),
    el('i', { class: 'log-dot' }),
    el('span', { class: 'log-text', text: entry.text }),
  );
};
