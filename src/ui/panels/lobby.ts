/**
 * Everything the interface shows about an online table that is not the board.
 *
 * A game played here starts the instant you press Begin. A game played with
 * other people cannot: there is a gap between "there is a table" and "there is
 * a game", and the gap is where the other people arrive. That gap is the whole
 * reason this module exists, and it is why the pieces below are shaped the way
 * they are:
 *
 *  - **The code is the invitation.** Six characters out of an alphabet with no
 *    `0/O` and no `1/I/L`, because a code exists to be read off somebody else's
 *    screen or repeated down a phone. It is offered as a text field rather than
 *    a label so that a browser which refuses the clipboard — every page served
 *    over plain http does — still leaves something a player can select.
 *  - **The roster is the answer to "is anyone else here yet".** So a seat shows
 *    presence, not merely occupancy: the referee marks a seat present while it
 *    has been heard from inside `PRESENCE_MS`, and a player who shut their lid
 *    should read as away rather than as gone.
 *  - **Start belongs to one person.** "The host is `games.host_id` rather than
 *    whoever is in seat one", so the button is offered to the client that
 *    opened the table, and the referee has the last word on it regardless.
 *
 * The badge at the bottom is the same idea carried into the game. Three
 * questions get asked continuously at an online table — which side am I, whose
 * move is it, and is this thing still connected — and a player who cannot answer
 * the third mistakes the second for the interface having lost their click.
 */

import type { PlayerId } from '@engine/types.js';
import { button, el, fill } from '../components/dom.js';
import { icon } from '../components/glyphs.js';
import { type Overlay, openModal } from '../components/modal.js';
import type { LinkState, OnlineMode, SeatInfo, TableInfo } from '../ports.js';
import type { Notice } from '../viewmodel.js';

/** Everything the lobby and the badge draw themselves from. */
export interface TableView {
  readonly table: TableInfo | null;
  /** The seat this client holds, or `null` while watching. */
  readonly seat: PlayerId | null;
  readonly link: LinkState;
  /** True when this client opened the table. */
  readonly host: boolean;
  readonly scenarioName: string;
  readonly joinLink: string;
  /** Whose move it is, once there is a game. Null in the lobby. */
  readonly turn: { readonly name: string; readonly mine: boolean } | null;
}

export interface TableActions {
  /** Take an open seat, or stand up to watch with `null`. */
  sit(seat: PlayerId | null): void;
  /**
   * Take back a seat somebody's browser still holds — this player's own, from
   * before their storage was cleared or their phone died. The table password
   * is the proof, so only a locked table offers it.
   */
  reclaim?(seat: PlayerId): void;
  start(): void;
  leave(): void;
  notify(text: string, tone?: Notice['tone']): void;
}

const LINK_TEXT: Record<LinkState, string> = {
  live: 'live',
  reconnecting: 'reconnecting',
  offline: 'offline',
};

// ---------------------------------------------------------------------------
// Copying
// ---------------------------------------------------------------------------

/**
 * Put something on the clipboard, and say whether it went.
 *
 * `navigator.clipboard` is absent on an insecure origin and rejects without a
 * user gesture, and a join code that silently failed to copy is worse than one
 * that never offered to: the player pastes the last thing they cut. So the
 * caller is told, and shows the field instead.
 */
const toClipboard = async (text: string): Promise<boolean> => {
  try {
    await navigator.clipboard?.writeText(text);
    return navigator.clipboard !== undefined;
  } catch {
    return false;
  }
};

/** A read-only field with a copy button, for the code and for the link. */
const copyField = (
  label: string,
  value: string,
  act: TableActions,
  extra?: string,
): HTMLElement => {
  const field = el('input', {
    class: `copy-input mono${extra ? ` ${extra}` : ''}`,
    type: 'text',
    readonly: true,
    value,
    'aria-label': label,
    onclick: () => field.select(),
  });
  return el(
    'div',
    { class: 'copy-row' },
    el('span', { class: 'sel-label', text: label }),
    field,
    button({
      label: 'Copy',
      variant: 'quiet',
      onClick: () => {
        void toClipboard(value).then((ok) => {
          field.select();
          act.notify(ok ? `${label} copied.` : `${label} selected — copy it by hand.`, 'info');
        });
      },
    }),
  );
};

// ---------------------------------------------------------------------------
// The choice on the scenario screen
// ---------------------------------------------------------------------------

export interface OnlineChoices {
  /**
   * Where a follow-up dialog is mounted.
   *
   * The shell keeps every overlay in one container so they stack and style
   * together; `document.body` would put this one outside it, which looks fine
   * until something else is already open.
   */
  readonly host: HTMLElement;
  /** Why online play is off, or null when it is on. */
  readonly reason: string | null;
  /** The arrangements this build can offer. Empty when online play is off. */
  readonly modes?: readonly OnlineMode[];
  /** Open a table with whatever the picker currently has selected. */
  onHost(mode: OnlineMode, password: string): void;
  onJoin(): void;
}

const MODE_TITLE: Record<OnlineMode, string> = {
  quick: 'Quick table',
  refereed: 'Refereed table',
};

const MODE_BLURB: Record<OnlineMode, string> = {
  quick:
    'Share a code and a password. Everyone’s browser runs the rules, so play with people you trust — and the two hidden-information scenarios are not offered.',
  refereed:
    'A judge on the server checks every order and keeps each side’s secrets. Needs the referee deployed to your project.',
};

/**
 * Ask which kind of table, and for the password one of them needs.
 *
 * A dialog rather than two buttons, because the choice is not about
 * convenience — it decides whether the rules are enforced and whether a fogged
 * scenario can be played at all. A player picking it deserves to read what
 * they are picking. When a build only offers one arrangement the choice is not
 * shown at all, and a quick table drops straight to asking for a password.
 */
export const openHostDialog = (
  host: HTMLElement,
  o: {
    modes: readonly OnlineMode[];
    onHost(mode: OnlineMode, password: string): void;
    onCancel?(): void;
  },
): Overlay => {
  let mode: OnlineMode = o.modes[0] ?? 'quick';
  let submitted = false;

  const password = el('input', {
    class: 'pass-entry',
    type: 'text',
    autocapitalize: 'none',
    spellcheck: 'false',
    'aria-label': 'Table password',
    placeholder: 'a word you can read out',
    onkeydown: (ev: Event) => {
      if ((ev as KeyboardEvent).key === 'Enter') submit();
    },
  });

  const passwordHint = el('p', { class: 'hint' });
  const passwordRow = el(
    'div',
    { class: 'join-form password-row' },
    el('p', { class: 'sel-hint', text: 'Password for the table' }),
    password,
    passwordHint,
  );

  // Every table has a password now. At a quick table it is the only lock on
  // the door; at a refereed one it also lets a player who lost their browser
  // prove a seat is theirs — so the wording says which job it is doing.
  const showPassword = (): void => {
    passwordHint.textContent =
      mode === 'quick'
        ? 'Anyone with the code and this password can sit down. Read them both out together.'
        : 'Anyone with the code and this password can sit down, and a player who comes back on a different browser types it to take their seat again.';
  };

  const choices = o.modes.map((m) =>
    el(
      'label',
      { class: 'row-inline mode-row' },
      el('input', {
        type: 'radio',
        name: 'online-mode',
        checked: m === mode ? 'checked' : null,
        onchange: () => {
          mode = m;
          showPassword();
        },
      }),
      el(
        'span',
        {},
        el('span', { class: 'sel-title', text: MODE_TITLE[m] }),
        el('span', { class: 'sel-hint', text: MODE_BLURB[m] }),
      ),
    ),
  );

  const submit = (): void => {
    const pw = password.value.trim();
    if (pw === '') {
      password.focus();
      return;
    }
    submitted = true;
    overlay.close();
    o.onHost(mode, pw);
  };

  const overlay = openModal(host, {
    title: 'Play online',
    subtitle:
      o.modes.length > 1 ? 'Two ways to sit at a table' : 'Open a table and invite somebody',
    body: el('div', { class: 'host-form' }, ...(o.modes.length > 1 ? choices : []), passwordRow),
    onClose: () => {
      if (!submitted) o.onCancel?.();
    },
    actions: [{ label: 'Open the table', variant: 'primary', closes: false, onClick: submit }],
  });

  showPassword();
  password.focus();
  return overlay;
};

/**
 * Add "play online" beside the picker's own Begin button.
 *
 * The picker owns the scenario, the optional rules, the seed and the fleets,
 * and it hands them out through exactly one door: its Begin button. Rather than
 * keep a second copy of that state here, the online button sets what the answer
 * is going to mean and then presses Begin — which is why `onHost` takes no
 * arguments, and why the shell decides between hosting and playing here inside
 * the picker's own callback.
 *
 * A build with no credentials gets the same two buttons, disabled, and a line
 * saying what is missing. Hiding them would leave a player who came for online
 * play with nothing to read.
 */
export const mountOnlineChoices = (overlay: Overlay, o: OnlineChoices): void => {
  const foot = overlay.el.querySelector('.modal-foot');
  if (foot === null) return;
  const off = o.reason !== null;

  const group = el(
    'div',
    { class: 'online-choices' },
    button({
      label: 'Play online',
      variant: 'ghost',
      class: 'play-online',
      disabled: off,
      title: o.reason ?? 'Open a table and invite somebody with a code',
      onClick: () => {
        const modes = o.modes ?? ['refereed'];
        // A build offering only a refereed table has nothing to ask: no mode
        // to choose and no password to set. Straight through, as before.
        if (modes.length === 1 && modes[0] === 'refereed') {
          o.onHost('refereed', '');
          return;
        }
        openHostDialog(o.host, { modes, onHost: o.onHost });
      },
    }),
    button({
      label: 'Join with a code',
      variant: 'quiet',
      class: 'join-table',
      disabled: off,
      title: o.reason ?? 'Sit down at somebody else’s table',
      onClick: o.onJoin,
    }),
  );

  foot.insertBefore(group, foot.firstChild);
  if (o.reason !== null) {
    foot.insertBefore(el('p', { class: 'hint online-off', text: o.reason }), group);
  }
};

// ---------------------------------------------------------------------------
// Joining
// ---------------------------------------------------------------------------

export interface JoinPrompt {
  /** Prefilled from a `?join=` link. */
  readonly code?: string | null;
  /** Prefilled from the link's fragment, which never leaves the browser. */
  readonly password?: string | null;
  /**
   * True when this build can open tables at all, which are the ones with a
   * password. The field is offered rather than demanded: an old refereed table
   * may have none, and a watcher needs only the code.
   */
  readonly wantsPassword?: boolean;
  onJoin(code: string, watchOnly: boolean, password: string): void;
  onCancel?(): void;
}

export const openJoinDialog = (host: HTMLElement, o: JoinPrompt): Overlay => {
  let watching = false;
  /** Submitting closes the dialog, and a close that we asked for is not a cancel. */
  let submitted = false;

  const field = el('input', {
    class: 'code-entry mono',
    type: 'text',
    // The alphabet is upper case, and a player who types the code in lower case
    // has not made a mistake worth an error message.
    value: (o.code ?? '').toUpperCase(),
    maxlength: '8',
    autocapitalize: 'characters',
    spellcheck: 'false',
    'aria-label': 'Join code',
    placeholder: 'ABC234',
    oninput: () => {
      field.value = field.value.toUpperCase();
    },
    onkeydown: (ev: Event) => {
      if ((ev as KeyboardEvent).key === 'Enter') submit();
    },
  });

  const secret = el('input', {
    class: 'pass-entry',
    type: 'text',
    value: o.password ?? '',
    autocapitalize: 'none',
    spellcheck: 'false',
    'aria-label': 'Table password',
    placeholder: 'table password',
    onkeydown: (ev: Event) => {
      if ((ev as KeyboardEvent).key === 'Enter') submit();
    },
  });

  const submit = (): void => {
    const code = field.value.trim().toUpperCase();
    if (code === '') return;
    submitted = true;
    overlay.close();
    o.onJoin(code, watching, secret.value.trim());
  };

  const overlay = openModal(host, {
    title: 'Join a table',
    subtitle: 'Type the code the host read you',
    body: el(
      'div',
      { class: 'join-form' },
      field,
      ...(o.wantsPassword === true ? [secret] : []),
      el('p', {
        class: 'hint',
        text:
          o.wantsPassword === true
            ? 'The host read you a password with the code. You will land in the lobby, where you can see the scenario, the roster, and take a seat — or take yours back, if you are returning on a different browser.'
            : 'You will land in the lobby, where you can see the scenario, the roster, and take a seat.',
      }),
      el(
        'label',
        { class: 'row-inline watch-row' },
        el('input', {
          type: 'checkbox',
          onchange: (ev: Event) => {
            watching = (ev.target as HTMLInputElement).checked;
          },
        }),
        el('span', { class: 'sel-hint', text: 'Watch only — do not take a seat' }),
      ),
    ),
    onClose: () => {
      if (!submitted) o.onCancel?.();
    },
    actions: [{ label: 'Join', variant: 'primary', closes: false, onClick: submit }],
  });

  field.focus();
  field.select();
  return overlay;
};

// ---------------------------------------------------------------------------
// The lobby
// ---------------------------------------------------------------------------

export interface Lobby {
  readonly el: HTMLElement;
  update(view: TableView): void;
  close(): void;
}

const holderText = (s: SeatInfo): string => {
  if (s.kind === 'computer') return 'Computer';
  if (s.kind === 'open') return 'Open';
  return s.name;
};

/**
 * Who may press Start.
 *
 * `TableInfo` does not carry the host's account id, so the certain answer is
 * only available to the client that opened the table. Seat one is the seat the
 * creator takes, which makes its holder the best available guess for everybody
 * else — including for the host themselves after a reload, when the certainty
 * is gone but the seat is not. The referee refuses anybody wrong, and the
 * refusal is shown, so a wrong guess costs a notice rather than a game.
 */
const mayStart = (v: TableView): boolean =>
  v.host || v.table?.seats.find((s) => s.ordinal === 0)?.mine === true;

const openSeatsIn = (table: TableInfo): readonly SeatInfo[] =>
  table.seats.filter((s) => s.kind === 'open');

/**
 * Everything either of these two draws from, as one comparable value.
 *
 * Both rebuild their whole subtree, and both are repainted on every frame the
 * shell draws. Rebuilding a field somebody is selecting the join code out of —
 * or a button they have just tabbed to — would undo them sixty times a second,
 * so a repaint that would change nothing does not happen.
 */
const paintKey = (v: TableView): string =>
  JSON.stringify([v.table, v.seat, v.link, v.host, v.scenarioName, v.joinLink, v.turn]);

export const openLobby = (host: HTMLElement, act: TableActions, initial: TableView): Lobby => {
  const body = el('div', { class: 'lobby' });
  let painted: string | null = null;

  const overlay = openModal(host, {
    title: 'Table',
    subtitle: 'Waiting for the game to begin',
    body,
    width: 'wide',
    dismissible: false,
  });

  const update = (v: TableView): void => {
    const key = paintKey(v);
    if (key === painted) return;
    painted = key;

    const table = v.table;
    if (table === null) {
      fill(body, el('p', { class: 'empty', text: 'Opening the table…' }));
      return;
    }

    const empty = openSeatsIn(table);
    const ready = empty.length === 0;

    fill(
      body,
      el(
        'div',
        { class: 'lobby-head' },
        el(
          'div',
          { class: 'lobby-ident' },
          el('h3', { class: 'sect-title', text: 'Scenario' }),
          el('span', { class: 'scenario-name', text: v.scenarioName }),
          table.fog ? el('span', { class: 'lobby-tag', text: 'fog of war' }) : null,
        ),
        linkChip(v.link),
      ),

      el(
        'div',
        { class: 'lobby-invite' },
        copyField('Code', table.code, act, 'code-big'),
        copyField('Link', v.joinLink, act),
      ),

      el(
        'div',
        { class: 'lobby-roster' },
        el('h3', { class: 'sect-title', text: 'Seats' }),
        ...table.seats.map((s) => seatRow(s, v, act)),
      ),

      el(
        'div',
        { class: 'lobby-foot' },
        el('p', {
          class: 'hint',
          text: ready
            ? 'Every seat is filled. The host may begin.'
            : `${empty.map((s) => s.faction).join(', ')} still ${empty.length === 1 ? 'has' : 'have'} nobody in ${empty.length === 1 ? 'it' : 'them'}. A seat can only be given to the computer when the table is opened, so either somebody joins or the host opens a new table.`,
        }),
        el(
          'div',
          { class: 'row-inline lobby-actions' },
          button({ label: 'Leave table', variant: 'quiet', onClick: act.leave }),
          v.seat === null
            ? el('span', { class: 'sel-hint', text: 'Watching — take a seat above to play.' })
            : null,
          mayStart(v)
            ? button({
                label: 'Start the game',
                variant: 'primary',
                disabled: !ready,
                title: ready ? 'Close the lobby and begin' : 'Every seat has to be filled first',
                onClick: act.start,
              })
            : el('span', { class: 'sel-hint', text: 'Waiting for the host to start.' }),
        ),
      ),
    );
  };

  update(initial);
  return { el: overlay.el, update, close: overlay.close };
};

const seatRow = (s: SeatInfo, v: TableView, act: TableActions): HTMLElement =>
  el(
    'div',
    { class: `lobby-seat${s.mine ? ' is-mine' : ''}` },
    el('i', {
      class: `lobby-dot${s.present ? ' is-present' : ''}`,
      title: s.present ? 'Here now' : 'Not heard from recently',
      'aria-hidden': 'true',
    }),
    el(
      'div',
      { class: 'lobby-who' },
      el('span', { class: 'lobby-faction', text: s.faction }),
      el('span', { class: 'lobby-holder', text: holderText(s) }),
    ),
    // Seat one is the seat the table's creator takes; see `mayStart`.
    s.ordinal === 0 ? el('span', { class: 'lobby-tag', text: 'host' }) : null,
    s.mine ? el('span', { class: 'lobby-tag is-you', text: 'you' }) : null,
    s.kind === 'open' && v.table?.status !== 'finished'
      ? button({
          label: 'Sit here',
          variant: 'quiet',
          class: 'sit-here',
          onClick: () => act.sit(s.seat),
        })
      : null,
    // A held seat on a locked table can be taken back with the password: the
    // player who lost their browser sees their own name here and says so.
    s.kind === 'human' &&
      !s.mine &&
      v.table?.locked === true &&
      act.reclaim !== undefined &&
      v.table.status !== 'finished'
      ? button({
          label: 'This is me',
          variant: 'quiet',
          class: 'sit-here',
          title: `Take ${s.name}’s seat back with the table password`,
          onClick: () => act.reclaim?.(s.seat),
        })
      : null,
  );

const linkChip = (link: LinkState): HTMLElement =>
  el(
    'span',
    { class: `link-chip is-${link}`, title: `Connection: ${LINK_TEXT[link]}` },
    el('i', { class: 'link-dot' }),
    el('span', { text: LINK_TEXT[link] }),
  );

// ---------------------------------------------------------------------------
// The badge
// ---------------------------------------------------------------------------

export interface TableBadge {
  readonly el: HTMLElement;
  update(view: TableView | null): void;
}

/**
 * The persistent indicator: your seat, whose move it is, and the wire.
 *
 * It stays out of the top bar deliberately. The top bar is the sequence of
 * play, which is the same in every game; this is the part that is only true
 * online, and a player glancing at it should not have to separate the two.
 */
export const createTableBadge = (act: TableActions): TableBadge => {
  const root = el('div', { class: 'table-badge', role: 'status', 'aria-live': 'polite' });
  let painted: string | null = null;

  const update = (v: TableView | null): void => {
    const key = v === null ? '' : paintKey(v);
    if (key === painted) return;
    painted = key;

    if (v === null || v.table === null) {
      root.classList.remove('is-on');
      fill(root);
      return;
    }
    root.classList.add('is-on');
    const seat = v.table.seats.find((s) => s.seat === v.seat);
    fill(
      root,
      el(
        'span',
        { class: 'badge-seat' },
        el('span', { class: 'sel-label', text: 'Seat' }),
        el('span', { text: seat ? seat.faction : 'watching' }),
      ),
      el('i', { class: 'badge-rule' }),
      el(
        'span',
        { class: `badge-turn${v.turn?.mine ? ' is-mine' : ''}` },
        v.turn === null ? 'in the lobby' : v.turn.mine ? 'your move' : `waiting on ${v.turn.name}`,
      ),
      el('i', { class: 'badge-rule' }),
      linkChip(v.link),
      el('span', { class: 'badge-code mono', text: v.table.code }),
      button({
        label: icon('close'),
        variant: 'quiet',
        class: 'icon-btn',
        title: 'Leave the table',
        onClick: act.leave,
      }),
    );
  };

  update(null);
  return { el: root, update };
};
