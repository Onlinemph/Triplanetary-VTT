/**
 * The read-outs: fuel, hold, damage tracks and the label/value rows that make up
 * the inspector. All pure functions of their arguments — they never look at the
 * game state, so a panel can show a hypothetical as easily as the real thing.
 */

import { ADVANCED_TRACK_LIMIT } from '@engine/combat.js';
import { DESTRUCTION_THRESHOLD } from '@engine/crt.js';
import type { Ship } from '@engine/types.js';
import { num } from '../format.js';
import { type Child, el } from './dom.js';

/**
 * A hairline bar with a filled portion. `max` may be Infinity (torch fuel,
 * orbital-base hold), in which case the bar is drawn full and marked ∞.
 */
export const bar = (
  value: number,
  max: number,
  opts: { readonly tone?: string; readonly label?: string } = {},
): HTMLElement => {
  const infinite = !Number.isFinite(max);
  const pct = infinite ? 100 : max <= 0 ? 0 : Math.max(0, Math.min(100, (value / max) * 100));
  const tone = opts.tone ?? (infinite || pct > 40 ? 'ok' : pct > 15 ? 'warn' : 'bad');
  return el(
    'div',
    {
      class: 'meter',
      role: 'img',
      'aria-label': opts.label ?? `${num(value)} of ${num(max)}`,
    },
    el(
      'div',
      { class: 'meter-track' },
      el('div', {
        class: `meter-fill tone-${tone}`,
        style: { width: `${pct}%` },
      }),
    ),
    el(
      'div',
      { class: 'meter-value mono' },
      `${num(value)}`,
      el('span', { class: 'meter-max', text: `/${num(max)}` }),
    ),
  );
};

/** The compact fuel bar used on fleet rows: no numbers, just the level. */
export const miniBar = (value: number, max: number): HTMLElement => {
  const infinite = !Number.isFinite(max);
  const pct = infinite ? 100 : max <= 0 ? 0 : Math.max(0, Math.min(100, (value / max) * 100));
  const tone = infinite || pct > 40 ? 'ok' : pct > 15 ? 'warn' : 'bad';
  return el(
    'div',
    { class: 'minibar', title: `Fuel ${num(value)} / ${num(max)}` },
    el('i', {
      class: `minibar-fill tone-${tone}`,
      style: { width: `${pct}%` },
    }),
  );
};

/**
 * The disablement track. "Damage is cumulative... If a ship ever reaches a
 * condition of D6 or greater, it is destroyed" — so the track is six long and
 * the sixth pip is the death mark.
 */
export const damagePips = (disabled: number, limit = DESTRUCTION_THRESHOLD): HTMLElement => {
  const pips: HTMLElement[] = [];
  for (let i = 0; i < limit; i++) {
    const filled = i < disabled;
    const fatal = i === limit - 1;
    pips.push(
      el('i', {
        class: `pip${filled ? ' is-on' : ''}${fatal ? ' is-fatal' : ''}`,
      }),
    );
  }
  return el(
    'div',
    {
      class: 'pips',
      role: 'img',
      'aria-label': disabled > 0 ? `Disabled ${disabled} more turns` : 'Undamaged',
      title: disabled > 0 ? `D${disabled} — disabled for ${disabled} more turn(s)` : 'Undamaged',
    },
    ...pips,
  );
};

/** Advanced combat: three separate tracks (rulebook p. 16). */
export const advancedTracks = (ship: Ship): HTMLElement =>
  el(
    'div',
    { class: 'tracks' },
    ...(['weapon', 'drive', 'structure'] as const).map((k) =>
      el(
        'div',
        { class: 'track' },
        el('span', { class: 'track-name', text: k }),
        damagePips(ship.advancedDamage[k], ADVANCED_TRACK_LIMIT),
      ),
    ),
  );

export const statRow = (label: string, value: unknown, tone?: string): HTMLElement =>
  el(
    'div',
    { class: 'stat' },
    el('span', { class: 'stat-label', text: label }),
    typeof value === 'object' && value instanceof Node
      ? el('span', { class: 'stat-value mono' }, value)
      : el('span', {
          class: `stat-value mono${tone ? ` tone-${tone}` : ''}`,
          text: String(value),
        }),
  );

export const section = (title: string, ...children: Child[]): HTMLElement =>
  el(
    'section',
    { class: 'sect' },
    el('h3', { class: 'sect-title', text: title }),
    el('div', { class: 'sect-body' }, ...children),
  );

export const chip = (
  text: string,
  opts: {
    readonly tone?: string;
    readonly color?: string;
    readonly title?: string;
  } = {},
): HTMLElement =>
  el('span', {
    class: `chip${opts.tone ? ` tone-${opts.tone}` : ''}`,
    text,
    ...(opts.title ? { title: opts.title } : {}),
    ...(opts.color ? { style: { '--chip': opts.color } } : {}),
  });

export const empty = (text: string): HTMLElement => el('p', { class: 'empty', text });

export const note = (tone: 'warn' | 'bad' | 'info' | 'good', text: string): HTMLElement =>
  el('p', { class: `note tone-${tone}`, text });
