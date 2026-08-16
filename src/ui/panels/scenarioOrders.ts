/**
 * Orders that exist only inside one scenario.
 *
 * Three printed scenarios ask a player to do something no general rule
 * describes: announce a cargo's destination and deliver it (Piracy), and muster
 * the Freedom Fleet (Retribution). The engine routes those through a per-scenario
 * command hook; this is the other end of the same wire, and it is deliberately
 * driven by `state.scenarioData` rather than by a switch on the scenario id, so a
 * scenario that publishes the right data gets its controls without touching the
 * interface.
 *
 * Nothing here decides whether an order is legal. It offers the button; the
 * engine refuses it, with a reason, exactly as it does for every other order.
 */

import { combatStrength } from '@engine/combat.js';
import { DEFAULT_MAP } from '@engine/map.js';
import { cargoCount } from '@engine/state.js';
import { FLIGHT_SCHOOL_EXERCISES, flightSchoolProgress } from '../../scenarios/flightSchool.js';
import { fuelBurned } from '../../scenarios/helpers.js';
import { type GameState, type Ship, activePlayer, controllerOf } from '@engine/types.js';
import { type Child, button, el } from '../components/dom.js';
import { note, section, statRow } from '../components/meters.js';
import type { Ctx } from '../viewmodel.js';

const piracyData = (state: GameState): Record<string, unknown> =>
  (state.scenarioData['piracy'] ?? {}) as Record<string, unknown>;

/** The worlds a cargo may be sent to, straight from the scenario's own list. */
const inhabitedWorlds = (state: GameState): readonly string[] =>
  (piracyData(state)['inhabitedWorlds'] ?? []) as readonly string[];

const cycleDeliveries = (state: GameState): readonly string[] =>
  (piracyData(state)['cycleDeliveries'] ?? []) as readonly string[];

const destinations = (state: GameState): Readonly<Record<string, string>> =>
  (piracyData(state)['destinations'] ?? {}) as Readonly<Record<string, string>>;

const worldName = (id: string): string => DEFAULT_MAP.body(id)?.name ?? id;

/**
 * Piracy's cargo run.
 *
 *   "The Merchant must announce the destination when a ship takes off... The
 *    Merchant earns 2 points for each cargo delivered... Cargo is delivered in
 *    'cycles' — once a planet has received a cargo, it may not get another cargo
 *    until all worlds have received a cargo in that cycle. Exception: Terra may
 *    always receive a cargo from any other world."
 *
 * Worlds already served this cycle are shown as such rather than hidden: a run
 * to one is legal and simply pays nothing, and a merchant weighing a short unpaid
 * hop against a long paid one is making the decision the cycle rule exists to
 * create.
 */
const piracySection = (ctx: Ctx, ship: Ship): Child[] => {
  const { state, act } = ctx;
  const worlds = inhabitedWorlds(state);
  if (worlds.length === 0) return [];

  const by = activePlayer(state);
  if (controllerOf(ship) !== by) return [];
  // "The Merchant's objective is to deliver cargoes" — and only the Merchant's.
  // The engine refuses anybody else, so offering the controls to the Patrol
  // would be a button that exists only to be turned down.
  if (piracyData(state)['cargoPlayer'] !== by) return [];

  const announced = destinations(state)[ship.id];
  const served = cycleDeliveries(state);
  const carrying = cargoCount(ship, 'freight') > 0;

  const rows: Child[] = [];

  if (announced !== undefined) {
    rows.push(
      note(
        'good',
        `Announced for ${worldName(announced)}${carrying ? '' : ' — but the hold is empty'}.`,
      ),
    );
  }

  if (carrying) {
    rows.push(
      el(
        'div',
        { class: 'actions' },
        button({
          label: announced ? `Deliver at ${worldName(announced)}` : 'Deliver cargo',
          variant: 'primary',
          title:
            'The ship must be at the announced world — landed, or in orbit under the p. 15 variant',
          onClick: () => act.dispatch({ type: 'deliverCargo', by, ship: ship.id }),
        }),
      ),
    );
  }

  if (state.phase === 'astrogation') {
    rows.push(
      el(
        'div',
        { class: 'chips' },
        el('span', { class: 'sel-label', text: 'Announce' }),
        ...worlds.map((world) =>
          button({
            label: worldName(world),
            variant: announced === world ? 'primary' : 'quiet',
            title: served.includes(world)
              ? `${worldName(world)} has already taken a cargo this cycle — the run pays nothing`
              : `${worldName(world)} is still owed a cargo this cycle: 2 points`,
            onClick: () =>
              act.dispatch({
                type: 'announceDestination',
                by,
                ship: ship.id,
                destination: world,
              }),
          }),
        ),
      ),
    );
    const outstanding = worlds.filter((w) => w !== 'terra' && !served.includes(w));
    rows.push(
      note(
        'info',
        outstanding.length === 0
          ? 'Every world has taken a cargo; the next delivery starts a new cycle.'
          : `${outstanding.length} world(s) still owed a cargo this cycle. Terra always pays.`,
      ),
    );
  }

  return rows.length > 0 ? [section('Cargo run', ...rows)] : [];
};

/**
 * Retribution's muster.
 *
 *   "After all ten corvettes have appeared (or, at the Sons of Liberty player's
 *    option, at any time prior), all corvettes which have stopped at Clandestine
 *    may be converted into the Freedom Fleet. Total the combat strength of all
 *    corvettes at Clandestine, and double it."
 */
const retributionSection = (ctx: Ctx, ship: Ship): Child[] => {
  const { state, act } = ctx;
  const data = state.scenarioData['retribution'] as
    | {
        freedomFleet?: { formed?: boolean; multiplier?: number };
        securityPatrol?: readonly string[];
      }
    | undefined;
  if (!data) return [];

  const by = activePlayer(state);
  const rows: Child[] = [];

  if (data.freedomFleet?.formed === true) {
    rows.push(note('good', 'The Freedom Fleet has been raised; spend its points at Clandestine.'));
  } else if (controllerOf(ship) === by && state.phase === 'resupply') {
    const clandestine = DEFAULT_MAP.body('clandestine');
    const mustered = Object.values(state.ships).filter(
      (s) =>
        !s.destroyed &&
        controllerOf(s) === by &&
        s.shipClass === 'corvette' &&
        s.location.kind === 'asteroidBase' &&
        clandestine !== undefined &&
        s.pos.q === clandestine.hex.q &&
        s.pos.r === clandestine.hex.r,
    );
    if (mustered.length > 0) {
      const multiplier = data.freedomFleet?.multiplier ?? 2;
      // "Total the combat strength of all corvettes at Clandestine, and double it."
      const points = mustered.reduce((n, s) => n + combatStrength(s), 0) * multiplier;
      rows.push(
        el(
          'div',
          { class: 'actions' },
          button({
            label: `Raise the Freedom Fleet (${mustered.length} corvettes → ${points} points)`,
            variant: 'primary',
            title: 'The corvettes are refitted into the new fleet and are spent doing it',
            onClick: () => act.dispatch({ type: 'convertFleet', by }),
          }),
        ),
      );
    }
  }

  if ((data.securityPatrol ?? []).includes(ship.id) && data.freedomFleet?.formed !== true) {
    rows.push(
      note(
        'warn',
        'On the Terra Security Patrol: this ship may not venture beyond detector range of Terra or Luna until the Freedom Fleet has been formed.',
      ),
    );
  }

  return rows.length > 0 ? [section('Freedom Fleet', ...rows)] : [];
};

/**
 * Flight School's course card.
 *
 * The only "order" here is knowing what to do next, so this is a checklist
 * rather than a row of buttons: every exercise, in order, with the rulebook
 * clause it teaches and — for the one you are on — how to actually fly it. The
 * hint for a finished exercise is folded away; the hint for the next one is the
 * whole point of the panel.
 */
const flightSchoolSection = (ctx: Ctx): Child[] => {
  const { state } = ctx;
  const progress = flightSchoolProgress(state);
  if (state.scenarioId !== 'flight-school') return [];

  const done = new Set(progress.done);
  const next = FLIGHT_SCHOOL_EXERCISES.find((e) => !done.has(e.id));
  const burned = Object.values(state.ships).reduce((n, s) => n + fuelBurned(s), 0);

  return [
    section(
      'Course card',
      ...FLIGHT_SCHOOL_EXERCISES.map((exercise) => {
        const finished = done.has(exercise.id);
        const current = next?.id === exercise.id;
        return el(
          'div',
          { class: `course-step${finished ? ' is-done' : ''}${current ? ' is-current' : ''}` },
          el(
            'div',
            { class: 'row-inline' },
            el('span', { class: 'course-tick', text: finished ? '✓' : current ? '›' : '·' }),
            el('span', { class: 'course-name', text: exercise.name }),
          ),
          current ? el('p', { class: 'hint', text: exercise.hint }) : null,
          current ? el('p', { class: 'blurb', text: exercise.clause }) : null,
        );
      }),
      statRow(
        'Fuel burned',
        `${burned} / ${progress.par} par`,
        burned > progress.par ? 'warn' : 'good',
      ),
      next === undefined
        ? note('good', 'Course complete.')
        : note('info', `${FLIGHT_SCHOOL_EXERCISES.length - done.size} exercise(s) to go.`),
    ),
  ];
};

/** Every scenario-only control that applies to this ship, right now. */
export const scenarioOrders = (ctx: Ctx, ship: Ship): Child[] => [
  ...flightSchoolSection(ctx),
  ...piracySection(ctx, ship),
  ...retributionSection(ctx, ship),
];
