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

/** Something saved in this browser that the player can pick back up. */
export interface ResumeOffer {
  /** What it is: "The Assault, turn 4" or "Orbital Drop, day 12". */
  readonly label: string;
  onResume(): void;
  onDiscard(): void;
}

/** A table this browser has sat at, to be picked up again. */
export interface TableOffer {
  /** "Mark III Attack · FGKMNP" */
  readonly label: string;
  /** "refereed table, yesterday" */
  readonly sub: string;
  onRejoin(): void;
  onForget(): void;
}

export interface StartMenuOpts {
  /** Whether a campaign is saved in this browser — it changes the wording. */
  readonly campaignRunning: boolean;
  readonly dismissible: boolean;
  /** A Triplanetary game saved mid-play, if any. */
  readonly resumeGame?: ResumeOffer | null;
  /** An Ogre battle saved mid-play, if any. */
  readonly resumeBattle?: ResumeOffer | null;
  /** Online tables this browser has sat at, newest first. */
  readonly tables?: readonly TableOffer[];
  onTriplanetary(): void;
  onOgre(): void;
  onCampaign(): void;
  onClose?(): void;
}

export const openStartMenu = (host: HTMLElement, o: StartMenuOpts): Overlay => {
  const resumeRow = (kind: string, offer: ResumeOffer): HTMLElement =>
    el(
      'div',
      { class: 'start-resume' },
      el('span', { class: 'start-resume-label', text: `${kind} in progress` }),
      el('span', { class: 'start-resume-what mono', text: offer.label }),
      button({
        label: 'Resume',
        variant: 'primary',
        onClick: () => {
          overlay.close();
          offer.onResume();
        },
      }),
      button({
        label: 'Discard',
        variant: 'quiet',
        title: 'Forget the save',
        onClick: () => {
          offer.onDiscard();
          overlay.close();
          o.onClose?.();
        },
      }),
    );
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

  const tableRow = (t: TableOffer): HTMLElement =>
    el(
      'div',
      { class: 'start-resume start-table' },
      el('span', { class: 'start-resume-label', text: t.label }),
      el('span', { class: 'start-resume-what mono', text: t.sub }),
      button({
        label: 'Rejoin',
        variant: 'primary',
        onClick: () => {
          overlay.close();
          t.onRejoin();
        },
      }),
      button({
        label: 'Forget',
        variant: 'quiet',
        title: 'Drop it from this list',
        onClick: () => {
          t.onForget();
          overlay.close();
          o.onClose?.();
        },
      }),
    );

  const body = el(
    'div',
    { class: 'start-menu-wrap' },
    o.resumeGame ? resumeRow('Game', o.resumeGame) : null,
    o.resumeBattle ? resumeRow('Battle', o.resumeBattle) : null,
    o.tables && o.tables.length > 0
      ? el(
          'div',
          { class: 'start-tables' },
          el('h3', { class: 'sect-title', text: 'Your tables' }),
          ...o.tables.map(tableRow),
        )
      : null,
    el(
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
        'Orbital Drop',
        'two games, one war',
        'Triplanetary handles everything above the atmosphere; Ogre handles everything below it. Buy tanks as cargo, run convoys under the guns, and put a cybertank on somebody else’s colony.',
        o.onCampaign,
      ),
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
  /** The seats, in the order they move: the shell reads them off a built board. */
  readonly sides?: readonly string[];
}

export interface OgrePickerOpts {
  readonly scenarios: readonly OgreScenarioInfo[];
  readonly seed: number;
  newSeed(): number;
  readonly dismissible: boolean;
  /**
   * `computer` is the index of the seat the computer plays — 0 or 1 in a
   * two-player scenario — or null for hot seat.
   */
  onStart(id: string, seed: number, computer: number | null): void;
  /**
   * Open the scenario as an online table instead. Absent when this build has
   * no referee to host it, in which case the picker offers no such door.
   */
  onHost?(id: string, seed: number, computer: number | null): void;
  /** Open the battle builder instead: any forces, either board. */
  onCustom?(): void;
  onBack(): void;
  onClose?(): void;
}

/** The Ogre scenario picker: the same two-pane shape as Triplanetary's. */
export const openOgrePicker = (host: HTMLElement, o: OgrePickerOpts): Overlay => {
  let selected = o.scenarios[0]?.id ?? '';
  let seed = o.seed;
  let computer: number | null = null;

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
      ...(o.onCustom
        ? [{ label: 'Custom battle', variant: 'quiet' as const, onClick: () => o.onCustom?.() }]
        : []),
      ...(o.onHost
        ? [
            {
              label: 'Host a table',
              variant: 'quiet' as const,
              onClick: () => o.onHost?.(selected, seed, computer),
            },
          ]
        : []),
      {
        label: 'Take the field',
        variant: 'primary',
        onClick: () => o.onStart(selected, seed, computer),
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
            el('span', { text: o.onHost ? 'hot seat, solo or online' : 'hot seat or solo' }),
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
          text: o.onHost
            ? 'Pass the keyboard, hand a seat to the computer, or host a table and send a friend the code. The amber board takes the whole screen until the battle is decided.'
            : 'Pass the keyboard, or hand a seat to the computer. The amber board takes the whole screen until the battle is decided.',
        }),
        el(
          'div',
          { class: 'chips seat-chips' },
          el('span', { class: 'sel-label', text: 'Seats' }),
          ...seatChoices(chosen?.sides ?? []).map((choice) =>
            button({
              label: choice.label,
              variant: computer === choice.computer ? 'primary' : 'quiet',
              title: choice.title,
              onClick: () => {
                computer = choice.computer;
                draw();
              },
            }),
          ),
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

/** Who sits where: hot seat, or you in one seat and the computer in the other. */
const seatChoices = (
  sides: readonly string[],
): { label: string; title: string; computer: number | null }[] => {
  const [first, second] = sides;
  const a = first ?? 'the first seat';
  const b = second ?? 'the second seat';
  return [
    { label: 'Hot seat', title: 'Both seats at this keyboard', computer: null },
    { label: `Play ${a}`, title: `The computer plays ${b}`, computer: 1 },
    { label: `Play ${b}`, title: `The computer plays ${a}`, computer: 0 },
  ];
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
