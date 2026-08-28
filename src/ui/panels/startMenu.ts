/**
 * The start menu — the first thing a player sees, now that this app holds
 * two complete games and the war between them.
 *
 * Three doors: Triplanetary (the scenario picker this app has always had),
 * Ogre (the ported companion game, played whole in the embedded view), and
 * the campaign that links them. The menu itself knows nothing about either
 * engine — the Ogre door hands back to the shell, which loads the ported
 * scenarios on demand so the menu costs nobody a download.
 */

import { button, el, fill } from '../components/dom.js';
import { type Overlay, openModal } from '../components/modal.js';
import { pluralise } from '../format.js';

export interface StartMenuOpts {
  /** Whether a campaign is saved in this browser — it changes the wording. */
  readonly campaignRunning: boolean;
  readonly dismissible: boolean;
  onTriplanetary(): void;
  onOgre(): void;
  onCampaign(): void;
  onClose?(): void;
}

export const openStartMenu = (host: HTMLElement, o: StartMenuOpts): Overlay => {
  const card = (name: string, tag: string, blurb: string, onPick: () => void): HTMLElement =>
    el(
      'button',
      {
        class: 'game-card',
        type: 'button',
        onclick: () => {
          overlay.close();
          onPick();
        },
      },
      el('span', { class: 'game-name', text: name }),
      el('span', { class: 'game-tag mono', text: tag }),
      el('span', { class: 'game-blurb', text: blurb }),
    );

  const body = el(
    'div',
    { class: 'start-menu' },
    card(
      'Triplanetary',
      'the space game',
      'Vector movement in the inner system. Plot a course, spend fuel only to change it, and fight over what the orbits allow — hot seat, against the computer, or online.',
      o.onTriplanetary,
    ),
    card(
      'Ogre',
      'the ground game',
      'A cybernetic supertank against everything the defence can field. Attack its weapons or its treads — you never attack an Ogre — on the cratered map or the green one.',
      o.onOgre,
    ),
    card(
      'Two games, one war',
      o.campaignRunning ? 'the campaign — a war is saved here' : 'the campaign',
      'Triplanetary decides who gets to the ground; Ogre decides what happens when they land. Buy fleets and armour, run convoys, and hold two thirds of the inner system.',
      o.onCampaign,
    ),
  );

  const overlay = openModal(host, {
    title: 'Choose your game',
    subtitle: 'Two complete games, and the war that links them',
    body,
    width: 'wide',
    dismissible: o.dismissible,
    ...(o.onClose ? { onClose: o.onClose } : {}),
  });
  return overlay;
};

/**
 * What the Ogre picker needs to know about a scenario — structurally the
 * ported `ScenarioDef`, but declared here so importing this panel does not
 * drag the Ogre engine into the main bundle. The shell passes the real list
 * in after loading it on demand.
 */
export interface OgreScenarioInfo {
  readonly id: string;
  readonly name: string;
  readonly blurb: string;
  readonly briefing: string;
  readonly victoryConditions: readonly string[];
  readonly players: number;
}

export interface OgrePickerOpts {
  readonly scenarios: readonly OgreScenarioInfo[];
  readonly seed: number;
  newSeed(): number;
  readonly dismissible: boolean;
  onStart(id: string, seed: number): void;
  onBack(): void;
  onClose?(): void;
}

/** The Ogre scenario picker: the same two-pane shape as Triplanetary's. */
export const openOgrePicker = (host: HTMLElement, o: OgrePickerOpts): Overlay => {
  let selected = o.scenarios[0]?.id ?? '';
  let seed = o.seed;

  const list = el('div', {
    class: 'scenario-list',
    role: 'listbox',
    'aria-label': 'Ogre scenarios',
  });
  const detail = el('div', { class: 'scenario-detail' });
  const body = el('div', { class: 'scenario-picker' }, list, detail);

  const overlay = openModal(host, {
    title: 'Ogre',
    subtitle: 'The ground game — choose a scenario',
    body,
    width: 'wide',
    dismissible: o.dismissible,
    ...(o.onClose ? { onClose: o.onClose } : {}),
    actions: [
      { label: 'All games', variant: 'ghost', onClick: o.onBack },
      {
        label: 'Take the field',
        variant: 'primary',
        onClick: () => o.onStart(selected, seed),
      },
    ],
  });

  const draw = (): void => {
    fill(
      list,
      ...o.scenarios.map((s) =>
        el(
          'button',
          {
            class: `scenario-item${s.id === selected ? ' is-selected' : ''}`,
            type: 'button',
            role: 'option',
            'aria-selected': String(s.id === selected),
            onclick: () => {
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
            el('span', { text: 'hot seat' }),
          ),
          el('span', { class: 'scenario-blurb', text: s.blurb }),
        ),
      ),
    );

    const chosen = o.scenarios.find((s) => s.id === selected);
    fill(
      detail,
      chosen
        ? el(
            'div',
            { class: 'scenario-brief' },
            el('h3', { class: 'sect-title', text: chosen.name }),
            ...chosen.briefing
              .split('\n\n')
              .map((p) => el('p', { class: 'scenario-desc', text: p })),
          )
        : el('p', { class: 'empty', text: 'No scenarios are available.' }),
      chosen
        ? el(
            'div',
            { class: 'scenario-options' },
            el('h3', { class: 'sect-title', text: 'Victory' }),
            el(
              'ul',
              { class: 'help-list' },
              ...chosen.victoryConditions.map((c) => el('li', { text: c })),
            ),
          )
        : null,
      el(
        'div',
        { class: 'scenario-options' },
        el('h3', { class: 'sect-title', text: 'The table' }),
        el('p', {
          class: 'hint',
          text: 'Hot seat: pass the keyboard. The amber board takes the whole screen until the battle is decided.',
        }),
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
              seed = o.newSeed();
              draw();
            },
            title: 'A new seed gives a different setup and different die rolls',
          }),
        ),
      ),
    );
  };

  draw();
  return overlay;
};

/**
 * The way back: a ghost button in a picker's foot that returns to the start
 * menu, mounted the way the campaign door is.
 */
export const mountAllGames = (overlay: Overlay, onOpen: () => void): void => {
  const foot = overlay.el.querySelector('.modal-foot');
  if (foot === null) return;
  foot.insertBefore(
    button({
      label: 'All games',
      variant: 'ghost',
      class: 'all-games',
      title: 'Back to the start menu',
      onClick: () => {
        overlay.close();
        onOpen();
      },
    }),
    foot.firstChild,
  );
};
