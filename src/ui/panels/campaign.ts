/**
 * The war room — the campaign screen, and the shell that hands off between
 * three engines: the campaign's own, this game's, and Ogre's.
 *
 * One overlay, rendered from `CampaignState` on every change, the same way
 * the panels render from `GameState`. It decides nothing: every order leaves
 * as a `CampaignCommand` through the handle, and a refusal comes back as a
 * notice in the campaign engine's own words.
 *
 * The two hand-offs look different on purpose. A **space battle** is this
 * app's own game, so the primary verbs are "fight it here" and "host an
 * online table" — the campaign lives beside the online play precisely so a
 * contested transfer can be contested by somebody on another machine, over
 * the same tables every other scenario uses. A **ground battle** belongs to
 * the companion Ogre app, so it travels as a token: a link opens the landing
 * over there, and the result token comes home through a paste box. Both
 * battles also offer the token route, because the token *is* the protocol
 * and the buttons are conveniences over it.
 */

import { type Force, describeForce, forceIsEmpty, lotsOf } from '@campaign/convert.js';
import {
  type CampaignSideId,
  CAMPAIGN_SIDES,
  GROUND_CATALOGUE,
  SHIP_CATALOGUE,
  SITES,
  TOTAL_PRODUCTION,
  VICTORY_PRODUCTION,
  shipEntry,
  siteDef,
} from '@campaign/data.js';
import type { CampaignState, PendingOperation } from '@campaign/engine.js';
import type { OrderOfBattle } from '@campaign/orders.js';
import { button, el, fill } from '../components/dom.js';
import { type Overlay, openModal } from '../components/modal.js';
import type { CampaignDeps, CampaignHandle } from '../ports.js';

export interface WarRoomHooks {
  /** Start the pending space battle in this app (asks who plays each seat). */
  fightHere(order: OrderOfBattle): void;
  /** Start the pending ground battle in this app's embedded Ogre view. */
  fightGround(order: OrderOfBattle): void;
  /** Host the pending space battle as an online table. Absent = no server. */
  hostOnline: ((order: OrderOfBattle) => void) | null;
  /** Why hosting is off, when it is. */
  readonly onlineReason?: string;
  notify(text: string, tone: 'info' | 'warn' | 'bad'): void;
  newSeed(): number;
  /** The campaign changed under the war room — the shell's chart pins follow. */
  onChanged?(): void;
  onClose?(): void;
}

/**
 * The picker's door into the war room: a ghost button in the modal foot,
 * beside the online choices, reading "Open the campaign" or "Return to the
 * war" depending on whether one is saved in this browser.
 */
export const mountCampaignChoice = (
  overlay: Overlay,
  o: { running: boolean; onOpen(): void },
): void => {
  const foot = overlay.el.querySelector('.modal-foot');
  if (foot === null) return;
  foot.insertBefore(
    button({
      label: o.running ? 'Return to the war' : 'Open the campaign',
      variant: 'ghost',
      class: 'open-campaign',
      title: 'Two games, one war: the inner system, fought with Ogre',
      onClick: o.onOpen,
    }),
    foot.firstChild,
  );
};

export const openWarRoom = (
  host: HTMLElement,
  deps: CampaignDeps,
  hooks: WarRoomHooks,
): Overlay => {
  // --- Composer state: half-built orders that have not been given yet ------
  let activeSide: CampaignSideId = 'combine';
  let garrisonSite: string | null = null;
  let attack: {
    site: string;
    fleet: Record<string, number>;
    cargo: Record<string, number>;
  } | null = null;
  let interceptFleet: Record<string, number> = {};
  let pasteValue = '';
  let confirmAbandon = false;

  const body = el('div', { class: 'war-room' });

  const overlay = openModal(host, {
    title: 'Two games, one war',
    subtitle:
      'Triplanetary decides who gets to the ground; Ogre decides what happens when they land',
    body,
    width: 'wide',
    ...(hooks.onClose ? { onClose: hooks.onClose } : {}),
  });
  // The war room docks beside the chart instead of covering it: the scrim
  // goes transparent and lets the pointer through, so the inner system stays
  // visible — and pannable — with the campaign's sites pinned to it.
  overlay.el.parentElement?.classList.add('war-scrim');

  const handleOrBust = (): CampaignHandle => {
    const handle = deps.current();
    if (!handle) throw new Error('no campaign is running');
    return handle;
  };

  const give = (cmd: Parameters<CampaignHandle['dispatch']>[0]): boolean => {
    const result = handleOrBust().dispatch(cmd);
    if (!result.ok) hooks.notify(result.reason ?? 'The campaign refused that.', 'bad');
    draw();
    return result.ok;
  };

  const copy = (text: string, box: HTMLTextAreaElement): void => {
    const clipboard = navigator.clipboard;
    if (!clipboard) {
      box.select();
      hooks.notify('Select the token and copy it by hand.', 'warn');
      return;
    }
    clipboard.writeText(text).then(
      () => hooks.notify('Copied.', 'info'),
      () => {
        box.select();
        hooks.notify('Select the token and copy it by hand.', 'warn');
      },
    );
  };

  const tokenBox = (value: string): HTMLTextAreaElement => {
    const box = el('textarea', { class: 'battle-token', readonly: true, rows: '3' });
    box.value = value;
    box.addEventListener('focus', () => box.select());
    return box;
  };

  const pasteBox = (): HTMLTextAreaElement => {
    const box = el('textarea', { class: 'battle-token', rows: '3' });
    box.value = pasteValue;
    box.placeholder = 'Paste the battle result token here';
    box.addEventListener('input', () => {
      pasteValue = box.value;
    });
    return box;
  };

  const shipName = (id: string): string => shipEntry(id)?.name ?? id;

  const describeFleet = (fleet: Force): string => {
    const parts = Object.entries(fleet)
      .filter(([, n]) => n > 0)
      .map(([id, n]) => `${shipName(id)} ×${n}`);
    return parts.length > 0 ? parts.join(', ') : 'nothing';
  };

  // --- Steppers: the +/- lines the composers are made of -------------------

  const stepper = (
    label: string,
    inPool: number,
    value: number,
    set: (n: number) => void,
  ): HTMLElement =>
    el(
      'div',
      { class: 'row-inline' },
      el('span', { class: 'sel-label', text: label }),
      el('span', { class: 'sel-hint mono', text: `${inPool} in the pool` }),
      button({
        label: '−',
        variant: 'quiet',
        disabled: value === 0,
        onClick: () => set(value - 1),
      }),
      el('span', { class: 'mono war-count', text: String(value) }),
      button({
        label: '+',
        variant: 'quiet',
        disabled: value >= inPool,
        onClick: () => set(value + 1),
      }),
    );

  const forceSteppers = (
    pool: Force,
    chosen: Record<string, number>,
    label: (id: string) => string,
  ): HTMLElement[] =>
    Object.entries(pool)
      .filter(([, n]) => n > 0)
      .map(([id, n]) =>
        stepper(label(id), n, chosen[id] ?? 0, (value) => {
          chosen[id] = Math.max(0, Math.min(n, value));
          if (chosen[id] === 0) delete chosen[id];
          draw();
        }),
      );

  // --- Cards ----------------------------------------------------------------

  const sideCard = (state: CampaignState, id: CampaignSideId): HTMLElement => {
    const def = CAMPAIGN_SIDES[id];
    const side = state.sides[id];
    const active = id === activeSide;

    const buys: (HTMLElement | null)[] = [];
    if (active && !state.victory) {
      buys.push(
        el(
          'div',
          { class: 'chips' },
          ...SHIP_CATALOGUE.map((s) =>
            button({
              label: `${s.name} ${s.pp}`,
              variant: 'quiet',
              disabled: s.pp > side.production,
              title: s.lots > 0 ? `Lifts ${s.lots} lots` : 'No hold',
              onClick: () => give({ type: 'buyShips', by: id, ship: s.id, count: 1 }),
            }),
          ),
        ),
        el(
          'div',
          { class: 'chips' },
          ...GROUND_CATALOGUE.map((g) =>
            button({
              label: `${g.name} ${g.pp}`,
              variant: 'quiet',
              disabled: g.pp > side.production,
              onClick: () => give({ type: 'buyGround', by: id, unit: g.id, count: 1 }),
            }),
          ),
        ),
      );
    }

    return el(
      'div',
      {
        class: `war-side${active ? ' is-active' : ''}`,
        style: { '--player': def.color },
      },
      el(
        'div',
        { class: 'row-inline' },
        el('span', { class: 'sel-label', text: def.faction }),
        el('span', { class: 'mono', text: `${side.production} PP` }),
      ),
      el('p', { class: 'hint', text: `Fleet: ${describeFleet(side.fleet)}` }),
      el('p', { class: 'hint', text: `Ground pool: ${describeForce(side.ground)}` }),
      ...buys,
    );
  };

  const siteRows = (state: CampaignState): HTMLElement[] =>
    SITES.map((def) => {
      const site = state.sites[def.id]!;
      const holder = site.holder ? CAMPAIGN_SIDES[site.holder] : null;
      const actions: (HTMLElement | null)[] = [];
      if (!state.victory && !state.pending) {
        if (site.holder === activeSide) {
          actions.push(
            button({
              label: 'Reinforce',
              variant: 'quiet',
              onClick: () => {
                garrisonSite = garrisonSite === def.id ? null : def.id;
                attack = null;
                draw();
              },
            }),
          );
        } else {
          actions.push(
            button({
              label: 'Invade',
              variant: 'quiet',
              onClick: () => {
                attack = attack?.site === def.id ? null : { site: def.id, fleet: {}, cargo: {} };
                garrisonSite = null;
                draw();
              },
            }),
          );
        }
      }
      return el(
        'div',
        { class: 'war-site', 'data-site': def.id },
        el(
          'div',
          { class: 'war-site-name' },
          el('span', { class: 'sel-label', text: def.name }),
          el('span', { class: 'mono', text: `${def.production} PP/turn` }),
        ),
        el(
          'div',
          { class: 'war-site-hold' },
          holder
            ? el('span', {
                class: 'war-holder',
                style: { '--player': holder.color },
                text: holder.name,
              })
            : el('span', { class: 'hint', text: 'unclaimed' }),
          el('span', {
            class: 'hint',
            text: forceIsEmpty(site.garrison) ? 'no garrison' : describeForce(site.garrison),
          }),
        ),
        el('div', { class: 'war-site-actions' }, ...actions),
      );
    });

  const garrisonComposer = (state: CampaignState): HTMLElement | null => {
    if (!garrisonSite) return null;
    const site = state.sites[garrisonSite];
    if (!site || site.holder !== activeSide) {
      garrisonSite = null;
      return null;
    }
    const pool = state.sides[activeSide].ground;
    return el(
      'div',
      { class: 'scenario-options' },
      el('h3', { class: 'sect-title', text: `Reinforce ${siteDef(garrisonSite)?.name ?? ''}` }),
      el('p', {
        class: 'hint',
        text: 'Shipping between friendly ports is below the campaign’s resolution: only contested transfers are fought.',
      }),
      el('p', { class: 'hint', text: `Garrison: ${describeForce(site.garrison)}` }),
      el(
        'div',
        { class: 'chips' },
        ...Object.entries(pool)
          .filter(([, n]) => n > 0)
          .map(([id, n]) =>
            button({
              label: `Send 1 ${id} (${n} in the pool)`,
              variant: 'quiet',
              onClick: () =>
                give({ type: 'garrison', by: activeSide, site: garrisonSite!, unit: id, count: 1 }),
            }),
          ),
        button({
          label: 'Done',
          variant: 'primary',
          onClick: () => {
            garrisonSite = null;
            draw();
          },
        }),
      ),
    );
  };

  const attackComposer = (state: CampaignState): HTMLElement | null => {
    if (!attack) return null;
    const composing = attack;
    const side = state.sides[activeSide];
    const lift = Object.entries(composing.fleet).reduce(
      (n, [id, count]) => n + (shipEntry(id)?.lots ?? 0) * count,
      0,
    );
    const need = lotsOf(composing.cargo);
    return el(
      'div',
      { class: 'scenario-options' },
      el('h3', { class: 'sect-title', text: `Invade ${siteDef(composing.site)?.name ?? ''}` }),
      el('h3', { class: 'sect-title war-sub', text: 'The convoy' }),
      ...forceSteppers(side.fleet, composing.fleet, shipName),
      el('h3', { class: 'sect-title war-sub', text: 'The landing force' }),
      ...forceSteppers(side.ground, composing.cargo, (id) => id),
      el('p', {
        class: `hint${lift < need ? ' tone-bad' : ''}`,
        text: `Lift: ${lift} lots for ${need} needed`,
      }),
      el(
        'div',
        { class: 'chips' },
        button({
          label: 'Launch the offensive',
          variant: 'primary',
          onClick: () => {
            if (
              give({
                type: 'launchOffensive',
                by: activeSide,
                site: composing.site,
                fleet: { ...composing.fleet },
                cargo: { ...composing.cargo },
              })
            ) {
              attack = null;
              draw();
            }
          },
        }),
        button({
          label: 'Never mind',
          variant: 'quiet',
          onClick: () => {
            attack = null;
            draw();
          },
        }),
      ),
    );
  };

  const pendingCard = (state: CampaignState, pending: PendingOperation): HTMLElement => {
    const siteName = siteDef(pending.site)?.name ?? pending.site;
    const attacker = CAMPAIGN_SIDES[pending.attacker];
    const kids: (HTMLElement | null)[] = [];

    if (pending.stage === 'intercept') {
      const defenderId = state.sites[pending.site]!.holder!;
      const defender = CAMPAIGN_SIDES[defenderId];
      kids.push(
        el('p', {
          class: 'hint',
          text:
            `${attacker.faction} is inbound for ${siteName} with ${describeForce(pending.cargo)} aboard. ` +
            `The decision is ${defender.faction}'s: come out to meet it, or let it land.`,
        }),
        ...forceSteppers(state.sides[defenderId].fleet, interceptFleet, shipName),
        el(
          'div',
          { class: 'chips' },
          button({
            label: 'Intercept',
            variant: 'primary',
            onClick: () => {
              if (give({ type: 'intercept', by: defenderId, fleet: { ...interceptFleet } })) {
                interceptFleet = {};
                draw();
              }
            },
          }),
          button({
            label: 'Let it pass',
            variant: 'quiet',
            onClick: () => give({ type: 'stand', by: defenderId }),
          }),
        ),
      );
    } else {
      const order = pending.order!;
      const inThisApp = pending.stage === 'space';
      const token = deps.orderToken(order);
      const orderField = tokenBox(token);

      if (inThisApp) {
        kids.push(
          el('p', {
            class: 'hint',
            text:
              `The convoy action off ${siteName} is this game. Fight it at this keyboard, ` +
              `host it as an online table and hand the other side the code, or carry the ` +
              `order token to another machine.`,
          }),
          el(
            'div',
            { class: 'chips' },
            button({
              label: 'Fight it here',
              variant: 'primary',
              onClick: () => hooks.fightHere(order),
            }),
            button({
              label: 'Host an online table',
              variant: 'quiet',
              disabled: hooks.hostOnline === null,
              title:
                hooks.hostOnline === null
                  ? (hooks.onlineReason ?? 'No server')
                  : 'Open a table for this battle and share the code',
              onClick: () => hooks.hostOnline?.(order),
            }),
          ),
        );
      } else {
        kids.push(
          el('p', {
            class: 'hint',
            text:
              `${describeForce(pending.landed ?? {})} is ashore on ${siteName} against a garrison of ` +
              `${describeForce(state.sites[pending.site]!.garrison)}. The landing is an Ogre battle. ` +
              `Fight it right here at this keyboard, host it as an online table and hand the other ` +
              `side the code, or send the order token to whoever commands it and paste the result back.`,
          }),
          el(
            'div',
            { class: 'chips' },
            button({
              label: 'Fight it here',
              variant: 'primary',
              onClick: () => hooks.fightGround(order),
            }),
            button({
              label: 'Host an online table',
              variant: 'quiet',
              disabled: hooks.hostOnline === null,
              title:
                hooks.hostOnline === null
                  ? (hooks.onlineReason ?? 'No server')
                  : 'Open a table for this battle and share the code',
              onClick: () => hooks.hostOnline?.(order),
            }),
          ),
        );
      }

      kids.push(
        el('h3', { class: 'sect-title war-sub', text: 'The order' }),
        orderField,
        el(
          'div',
          { class: 'chips' },
          button({
            label: 'Copy the order',
            variant: 'quiet',
            onClick: () => copy(token, orderField),
          }),
        ),
        el('h3', { class: 'sect-title war-sub', text: 'The result' }),
        pasteBox(),
        el(
          'div',
          { class: 'chips' },
          button({
            label: 'Report the result',
            variant: 'primary',
            onClick: () => {
              try {
                const result = deps.parseResult(pasteValue);
                if (give({ type: 'reportBattle', result })) {
                  pasteValue = '';
                  draw();
                }
              } catch (err) {
                hooks.notify(
                  err instanceof Error ? err.message : 'that token does not parse',
                  'bad',
                );
              }
            },
          }),
        ),
      );
    }

    return el(
      'div',
      { class: 'scenario-options' },
      el('h3', {
        class: 'sect-title',
        text:
          pending.stage === 'ground' ? `The landing on ${siteName}` : `The transfer to ${siteName}`,
      }),
      ...kids,
    );
  };

  const ledger = (state: CampaignState): HTMLElement =>
    el(
      'div',
      { class: 'scenario-options' },
      el('h3', { class: 'sect-title', text: 'The ledger' }),
      el(
        'ol',
        { class: 'war-ledger' },
        ...state.log
          .slice(-12)
          .reverse()
          .map((entry) =>
            el(
              'li',
              { class: `war-entry tone-${entry.severity}` },
              el('span', { class: 'mono war-turn', text: `T${entry.turn}` }),
              el('span', { text: entry.text }),
            ),
          ),
      ),
    );

  // --- The sheet ------------------------------------------------------------

  const intro = (): void => {
    fill(
      body,
      el('p', {
        class: 'scenario-desc',
        text:
          'The campaign holds the map of objectives, launches the battles, and reads the ' +
          'results back. Contested transfers are fought here — at this keyboard or across ' +
          'an online table — and landings are fought in the companion Ogre app, travelling ' +
          'as pasteable tokens.',
      }),
      el('p', {
        class: 'hint',
        text:
          `Two thirds of the off-world production (${VICTORY_PRODUCTION} of ${TOTAL_PRODUCTION} PP) ` +
          'wins the war. The campaign saves itself in this browser after every order.',
      }),
      el(
        'div',
        { class: 'chips' },
        button({
          label: 'Begin the war',
          variant: 'primary',
          onClick: () => {
            deps.start(hooks.newSeed());
            draw();
          },
        }),
        button({ label: 'Back', variant: 'quiet', onClick: () => overlay.close() }),
      ),
    );
  };

  const draw = (): void => {
    // Anything that redraws the room may have changed the war; the shell's
    // pins re-read the state on their next frame, after this one settles.
    hooks.onChanged?.();
    const handle = deps.current();
    if (!handle) {
      intro();
      return;
    }
    const state = handle.state;

    fill(
      body,
      el('p', {
        class: 'scenario-desc',
        text: state.victory
          ? state.victory.reason
          : `Turn ${state.turn}. Hold ${VICTORY_PRODUCTION} of ${TOTAL_PRODUCTION} PP of production to win. ` +
            'Hot seat: pick whose orders you are giving, then pass the keyboard.',
      }),
      el(
        'div',
        { class: 'chips' },
        ...(['combine', 'paneuro'] as const).map((id) =>
          button({
            label: `Playing: ${CAMPAIGN_SIDES[id].name}`,
            variant: activeSide === id ? 'primary' : 'quiet',
            onClick: () => {
              activeSide = id;
              garrisonSite = null;
              attack = null;
              draw();
            },
          }),
        ),
      ),
      el('div', { class: 'war-sides' }, sideCard(state, 'combine'), sideCard(state, 'paneuro')),
      el(
        'div',
        { class: 'scenario-options' },
        el('h3', { class: 'sect-title', text: 'The map of objectives' }),
        ...siteRows(state),
      ),
      garrisonComposer(state),
      attackComposer(state),
      state.pending ? pendingCard(state, state.pending) : null,
      ledger(state),
      el(
        'div',
        { class: 'chips war-foot' },
        button({
          label: 'End the turn',
          variant: 'primary',
          disabled: !!state.pending || !!state.victory,
          title: state.pending ? 'A battle is being fought' : '',
          onClick: () => give({ type: 'endTurn' }),
        }),
        button({
          label: 'Undo',
          variant: 'quiet',
          disabled: !handle.canUndo,
          onClick: () => {
            handle.undo();
            draw();
          },
        }),
        button({ label: 'Close', variant: 'quiet', onClick: () => overlay.close() }),
        button({
          label: confirmAbandon ? 'Really abandon the war?' : 'Abandon the war',
          variant: 'ghost',
          class: 'war-abandon',
          onClick: () => {
            if (!confirmAbandon) {
              confirmAbandon = true;
              draw();
              return;
            }
            confirmAbandon = false;
            deps.abandon();
            draw();
          },
        }),
      ),
    );
  };

  draw();
  return overlay;
};
