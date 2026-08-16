/**
 * The scenario picker — the first thing a player sees.
 *
 * It carries the three optional rules the rulebook keeps separate from the
 * basic game: the advanced combat system (p. 16), fog of war (detection, p. 8),
 * and nukes, which "are available only if the scenario specifies."
 */

import { DEFAULT_OPTIONS, type GameOptions } from '@engine/types.js';
import { button, el, fill, toggle } from '../components/dom.js';
import { type Overlay, openModal } from '../components/modal.js';
import { pluralise } from '../format.js';
import type { ScenarioBuildOptions, ScenarioDescriptor } from '../ports.js';

export interface PickerResult {
  readonly id: string;
  readonly opts: ScenarioBuildOptions;
}

export const openScenarioPicker = (
  host: HTMLElement,
  scenarios: readonly ScenarioDescriptor[],
  defaults: {
    readonly id?: string;
    readonly options: GameOptions;
    readonly seed: number;
  },
  onStart: (result: PickerResult) => void,
  dismissible: boolean,
  onClose?: () => void,
): Overlay => {
  let selected = defaults.id ?? scenarios[0]?.id ?? '';
  let options: GameOptions = { ...defaults.options };
  let seed = defaults.seed;
  /** Hulls bought on the point-buy screen, by player id. Empty means "printed". */
  let fleets: Record<string, string[]> = {};

  const list = el('div', {
    class: 'scenario-list',
    role: 'listbox',
    'aria-label': 'Scenarios',
  });
  const detail = el('div', { class: 'scenario-detail' });
  const body = el('div', { class: 'scenario-picker' }, list, detail);

  const overlay = openModal(host, {
    title: 'Triplanetary',
    subtitle: 'Vector movement in the inner system — choose a scenario',
    body,
    width: 'wide',
    dismissible,
    ...(onClose ? { onClose } : {}),
    actions: [
      {
        label: 'Begin',
        variant: 'primary',
        onClick: () =>
          onStart({
            id: selected,
            // An empty selection is not a choice — it means the player never
            // opened the buy screen, and the scenario should field its own list.
            opts: {
              seed,
              options,
              ...(Object.values(fleets).some((f) => f.length > 0) ? { fleets } : {}),
            },
          }),
      },
    ],
  });

  const draw = (): void => {
    fill(
      list,
      ...scenarios.map((s) =>
        el(
          'button',
          {
            class: `scenario-item${s.id === selected ? ' is-selected' : ''}`,
            type: 'button',
            role: 'option',
            'aria-selected': String(s.id === selected),
            onclick: () => {
              if (s.id !== selected) fleets = {};
              selected = s.id;
              draw();
            },
          },
          el('span', { class: 'scenario-name', text: s.name }),
          el(
            'span',
            { class: 'scenario-meta mono' },
            el('span', { text: pluralise(s.players, 'player') }),
            el('span', { class: 'dot-sep', text: '·' }),
            el('span', {
              text: typeof s.length === 'number' ? pluralise(s.length, 'turn') : s.length,
            }),
          ),
          el('span', { class: 'scenario-blurb', text: s.blurb }),
        ),
      ),
    );

    const chosen = scenarios.find((s) => s.id === selected);
    fill(
      detail,
      chosen
        ? el(
            'div',
            { class: 'scenario-brief' },
            el('h3', { class: 'sect-title', text: chosen.name }),
            el('p', { class: 'scenario-desc', text: chosen.description }),
          )
        : el('p', { class: 'empty', text: 'No scenarios are available.' }),
      ...(chosen?.pointBuy ? [pointBuyPane(chosen.pointBuy)] : []),
      el(
        'div',
        { class: 'scenario-options' },
        el('h3', { class: 'sect-title', text: 'Optional rules' }),
        optionToggle(
          'Advanced combat',
          'advancedCombat',
          'Separate weapon, drive and structure damage instead of one disablement track.',
        ),
        optionToggle(
          'Fog of war',
          'fogOfWar',
          'Hide enemy ships until they are detected — 3 hexes from a ship, 5 from a planetary base.',
        ),
        optionToggle(
          'Nukes',
          'nukesAllowed',
          'Allow nuclear ordnance, if the scenario provides it.',
        ),
        optionToggle(
          'Orbital bases everywhere',
          'orbitalBasesVariant',
          'The p.15 variant: every planetary base has an orbital base overhead.',
        ),
        optionToggle(
          'Warn on fatal plots',
          'confirmFatalPlots',
          'Confirm before committing a course that crashes or leaves the chart.',
        ),
        el(
          'label',
          { class: 'seed-row' },
          el('span', { class: 'seed-label', text: 'Die seed' }),
          el('input', {
            class: 'seed-input mono',
            type: 'number',
            value: String(seed),
            'aria-label': 'Random seed',
            oninput: (ev: Event) => {
              const n = Number((ev.target as HTMLInputElement).value);
              if (Number.isFinite(n)) seed = Math.floor(n);
            },
          }),
          button({
            label: 'Roll',
            variant: 'quiet',
            onClick: () => {
              seed = Math.floor(Math.random() * 0xffffffff);
              draw();
            },
            title: 'A new seed gives a different sequence of die rolls',
          }),
        ),
      ),
    );
  };

  /**
   * The combat strength point system, as a setup screen (p. 9).
   *
   *   "Ships are acquired on the basis of combat strength points. Basically, a
   *    ship costs points equal to its combat strength; a liner costs 1 point, a
   *    transport or tanker costs 1/2 point."
   *
   * Each side spends its own budget. Leaving a side untouched leaves it with the
   * fleet the scenario prints, which is what a player who does not care wants —
   * and what a player who overspends gets, since the engine refuses a fleet over
   * budget rather than trimming one.
   */
  const pointBuyPane = (buy: NonNullable<ScenarioDescriptor['pointBuy']>): HTMLElement =>
    el(
      'div',
      { class: 'scenario-options' },
      el('h3', { class: 'sect-title', text: 'Fleets' }),
      el('p', {
        class: 'hint',
        text: 'Ships cost points equal to their combat strength; a liner costs 1, a transport or tanker 1/2. Leave a side alone to use the printed fleet.',
      }),
      ...buy.sides.map((side) => {
        const chosenFleet = fleets[side.id] ?? [];
        const spent = chosenFleet.reduce(
          (n, id) => n + (buy.catalogue.find((c) => c.id === id)?.cost ?? 0),
          0,
        );
        const left = side.budget - spent;
        return el(
          'div',
          { class: 'buy-side' },
          el(
            'div',
            { class: 'row-inline' },
            el('span', { class: 'sel-label', text: side.name }),
            el('span', {
              class: `mono${left < 0 ? ' tone-bad' : ''}`,
              text: `${spent} / ${side.budget} points`,
            }),
            chosenFleet.length > 0
              ? button({
                  label: 'Clear',
                  variant: 'quiet',
                  onClick: () => {
                    fleets = { ...fleets, [side.id]: [] };
                    draw();
                  },
                })
              : null,
          ),
          el(
            'div',
            { class: 'chips' },
            ...buy.catalogue.map((entry) => {
              const owned = chosenFleet.filter((id) => id === entry.id).length;
              return button({
                label: `${entry.name} ${entry.cost}${owned > 0 ? ` ×${owned}` : ''}`,
                variant: owned > 0 ? 'primary' : 'quiet',
                disabled: entry.cost > left,
                title:
                  entry.cost > left
                    ? `${entry.cost} points; ${left} left`
                    : `Add a ${entry.name} for ${entry.cost} points`,
                onClick: () => {
                  fleets = { ...fleets, [side.id]: [...chosenFleet, entry.id] };
                  draw();
                },
              });
            }),
          ),
          chosenFleet.length > 0
            ? el(
                'div',
                { class: 'chips' },
                ...[...new Set(chosenFleet)].map((id) =>
                  button({
                    label: `− ${buy.catalogue.find((c) => c.id === id)?.name ?? id}`,
                    variant: 'ghost',
                    onClick: () => {
                      const next = [...chosenFleet];
                      next.splice(next.lastIndexOf(id), 1);
                      fleets = { ...fleets, [side.id]: next };
                      draw();
                    },
                  }),
                ),
              )
            : null,
        );
      }),
    );

  const optionToggle = (label: string, key: keyof GameOptions, hint: string): HTMLElement =>
    toggle(
      label,
      options[key],
      (on) => {
        options = { ...options, [key]: on };
        draw();
      },
      hint,
    );

  draw();
  return overlay;
};

export const defaultGameOptions = (): GameOptions => ({ ...DEFAULT_OPTIONS });
