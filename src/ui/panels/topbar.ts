/**
 * The top bar: where you are in the sequence of play, whose turn it is, and the
 * one button that moves the game forward.
 *
 * "Each player-turn is composed of five phases" — the five pips are the whole
 * rulebook sequence, always visible, so a player never has to guess what the
 * game is waiting for.
 */

import { hasPendingAttack } from '@engine/combat.js';
import { PHASES, PHASE_LABELS, activePlayer } from '@engine/types.js';
import { button, el, fill } from '../components/dom.js';
import { icon } from '../components/glyphs.js';
import { dayText } from '../format.js';
import type { Ctx, Panel } from '../viewmodel.js';

export const createTopBar = (getScenarioName: () => string): Panel => {
  const left = el('div', { class: 'top-left' });
  const centre = el('nav', {
    class: 'phases',
    'aria-label': 'Sequence of play',
  });
  const right = el('div', { class: 'top-right' });

  const root = el('header', { class: 'topbar' }, left, centre, right);

  const update = (ctx: Ctx): void => {
    const { state, ui, act } = ctx;
    const player = state.players[activePlayer(state)];
    const phaseIndex = PHASES.indexOf(state.phase);

    fill(
      left,
      el(
        'div',
        { class: 'title-block' },
        el('span', { class: 'scenario-name', text: getScenarioName() }),
        el('span', { class: 'day mono', text: dayText(state.turn) }),
      ),
    );

    fill(
      centre,
      ...PHASES.map((phase, i) => {
        const done = i < phaseIndex;
        const current = i === phaseIndex;
        return el(
          'div',
          {
            class: `phase${current ? ' is-current' : ''}${done ? ' is-done' : ''}`,
            title: `${i + 1}. ${PHASE_LABELS[phase]} phase`,
            'aria-current': current ? 'step' : 'false',
          },
          el('i', { class: 'phase-pip' }),
          el('span', { class: 'phase-name', text: PHASE_LABELS[phase] }),
        );
      }),
    );

    const pending = hasPendingAttack(state);
    const over = state.victory !== null;

    fill(
      right,
      player
        ? el(
            'div',
            {
              class: 'player-chip',
              style: { '--player': player.color },
              title: `${player.name} — ${player.faction}`,
            },
            el('i', { class: 'player-dot' }),
            el('span', { class: 'player-name', text: player.name }),
          )
        : null,
      el(
        'div',
        { class: 'toolbar' },
        button({
          label: icon('gravity'),
          onClick: () => act.toggleFlag('gravity'),
          variant: 'quiet',
          class: 'icon-btn',
          pressed: ui.flags.gravity,
          title: 'Gravity arrows (G)',
        }),
        button({
          label: icon('detection'),
          onClick: () => act.toggleFlag('detection'),
          variant: 'quiet',
          class: 'icon-btn',
          pressed: ui.flags.detection,
          title: 'Detection range (D)',
        }),
        button({
          label: icon('history'),
          onClick: () => act.toggleFlag('history'),
          variant: 'quiet',
          class: 'icon-btn',
          pressed: ui.flags.history,
          title: 'Course history (H)',
        }),
        button({
          label: icon('skip'),
          onClick: () => act.toggleFlag('autoSkip'),
          variant: 'quiet',
          class: 'icon-btn',
          pressed: ui.flags.autoSkip,
          title: 'Skip phases with nothing to do (K)',
        }),
        el('i', { class: 'toolbar-rule' }),
        button({
          label: icon('fit'),
          onClick: () => act.fit(),
          variant: 'quiet',
          class: 'icon-btn',
          title: 'Fit the whole chart (F)',
        }),
        button({
          label: icon('undo'),
          onClick: () => act.undo(),
          variant: 'quiet',
          class: 'icon-btn',
          title: 'Undo the last order',
        }),
        button({
          label: icon('scenarios'),
          onClick: () => act.openScenarios(),
          variant: 'quiet',
          class: 'icon-btn',
          title: 'Scenarios',
        }),
        button({
          label: icon('help'),
          onClick: () => act.openHelp(),
          variant: 'quiet',
          class: 'icon-btn',
          title: 'Rules summary (?)',
        }),
      ),
      button({
        label: over
          ? 'Game over'
          : pending
            ? 'Awaiting return fire'
            : state.phase === 'resupply'
              ? 'End turn'
              : 'End phase',
        onClick: () => act.endPhase(),
        variant: 'primary',
        disabled: over || pending,
        title: pending
          ? 'The defender must answer the attack before the phase can end'
          : 'Advance the sequence of play (Space)',
        key: 'Space',
        class: 'end-phase',
      }),
    );
  };

  return { el: root, update };
};
