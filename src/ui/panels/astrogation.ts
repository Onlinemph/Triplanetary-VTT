/**
 * Astrogation controls.
 *
 * "The player examines the map and ship positions and plots the predicted
 * courses of all their ships... Working from these predicted courses, the player
 * determines what changes (if any) to make." The map does the plotting — this
 * panel shows what the plot *costs* and what it will do, and carries the orders
 * that are not a click on a hex: landing, takeoff, ramming, weak gravity.
 */

import {
  type Hex,
  distance,
  eq,
  hexSide,
  isZero,
  key,
  sideKey,
  length as hexLength,
} from '@engine/hex.js';
import { prospectingEnabled } from '@engine/logistics.js';
import {
  canOverload,
  courseThroughCentre,
  hasScanners,
  movementData,
  predictedEndpoint,
  previewPlot,
  reachableEndpoints,
} from '@engine/movement.js';
import { type Ship, activePlayer, areAllied, liveShips } from '@engine/types.js';
import { type Child, button, el, toggle } from '../components/dom.js';
import { note, section, statRow } from '../components/meters.js';
import { hexText, shipLabel, vectorText } from '../format.js';
import type { Ctx } from '../viewmodel.js';

export const astrogationActions = (ctx: Ctx, ship: Ship): Child[] => {
  const { state, map, ui, act } = ctx;
  const out: Child[] = [];

  if (ship.location.kind === 'landed') {
    // "Ships blast off using boosters, available only at friendly bases...
    // takeoff requires no fuel points."
    const side = ship.location.side;
    const base = Object.values(state.bases).find(
      (b) => b.side !== undefined && sideKey(b.side) === sideKey(side),
    );
    const body = map.bodyAt(side.hex);
    out.push(
      section(
        'Landed',
        statRow('World', body?.name ?? '—'),
        statRow('Hexside', String(side.dir)),
        base
          ? note(
              'info',
              'Boosters lift the ship one hex to the gravity hex above this hexside, leaving it stationary.',
            )
          : note('warn', 'There is no base on this hexside — the ship cannot take off again.'),
        el(
          'div',
          { class: 'actions' },
          button({
            label: 'Take off',
            variant: 'primary',
            disabled: !base || base.destroyed || ship.disabled > 0,
            onClick: () =>
              act.dispatch({
                type: 'takeOff',
                by: activePlayer(state),
                ship: ship.id,
              }),
            title: 'Free booster launch from a friendly base',
          }),
        ),
      ),
    );
    return out;
  }

  // --- The course ----------------------------------------------------------

  const predicted = predictedEndpoint(state, ship, map);
  const options = reachableEndpoints(state, ship, map);
  const plotted = ship.plottedEndpoint;
  const shown = plotted ?? ui.hoverEndpoint ?? predicted;
  const preview = previewPlot(state, ship, shown, map, distance(predicted, shown) === 2);

  const warnings: Child[] = [];
  if (preview.crashesInto) {
    warnings.push(
      note(
        'bad',
        `Course intersects ${map.body(preview.crashesInto)?.name ?? preview.crashesInto} — the ship is destroyed.`,
      ),
    );
  }
  if (preview.exitsMap) {
    // "Any ship whose final course places it off the map is considered eliminated."
    warnings.push(note('bad', 'The arrowhead falls off the chart — the ship is eliminated.'));
  }
  if (preview.denseAsteroids.length > 0) {
    // "Only ships possessing scanners may enter those hexes. Other ships are
    // destroyed" — so the cordon is fatal or merely notable, depending on cargo.
    const safe = hasScanners(state, ship);
    warnings.push(
      note(
        safe ? 'info' : 'bad',
        `Course crosses ${preview.denseAsteroids.length} dense asteroid hex(es) around Clandestine — ${
          safe
            ? 'scanners aboard, so the ship may pass.'
            : 'without scanners the ship is destroyed.'
        }`,
      ),
    );
  }
  if (preview.asteroidHexes.length > 0) {
    warnings.push(
      note(
        'warn',
        `${preview.asteroidHexes.length} asteroid hex(es) entered above speed 1 — one hazard roll each.`,
      ),
    );
  }
  if (!preview.legal && preview.reason) warnings.push(note('warn', preview.reason));

  const speed = hexLength(ship.velocity);
  out.push(
    section(
      plotted ? 'Plotted course' : 'Predicted course',
      statRow('Endpoint', hexText(shown)),
      statRow('Next vector', vectorText(preview.velocity)),
      statRow('Fuel burned', String(preview.accel)),
      statRow('Fuel after', String(preview.fuelAfter)),
      preview.orbitBody
        ? statRow(
            'Result',
            `orbit of ${map.body(preview.orbitBody)?.name ?? preview.orbitBody}`,
            'good',
          )
        : null,
      ...warnings,
      // Vector movement's one genuine surprise: you cannot turn in place, and
      // at speed there is no burn that reverses you. Players reasonably read
      // that as the game being broken, so say it outright and give the count.
      speed > 0
        ? el(
            'p',
            { class: 'hint' },
            `Speed ${speed}. A burn moves the arrowhead one hex, so you cannot turn round in one turn — ` +
              `burn against your vector to shed a hex of speed at a time. ` +
              `${speed} more turn${speed === 1 ? '' : 's'} of braking to stop, then accelerate the other way. ` +
              `Each hex is labelled with the speed it leaves you at.`,
          )
        : null,
      el(
        'p',
        { class: 'hint' },
        plotted
          ? 'Click another highlighted hex to re-plot; the old burn is refunded.'
          : // Count what is actually drawn. The overload hexes are only
            // highlighted once overload is armed, so quoting the full option
            // count sent players hunting for hexes that were not on the chart.
            (() => {
              const shownCount = options.filter((o) => o.accel <= (ui.overload ? 2 : 1)).length;
              const extra = options.length - shownCount;
              return extra > 0
                ? `Click one of the ${shownCount} highlighted hexes to plot — or arm the overload below for ${extra} more.`
                : `Click one of the ${shownCount} highlighted hexes to plot.`;
            })(),
      ),
    ),
  );

  // --- Overload ------------------------------------------------------------

  if (canOverload(state, ship)) {
    out.push(
      section(
        'Overload manoeuvre',
        el(
          'div',
          { class: 'row-inline' },
          toggle(
            'Arm overload (2 fuel, 2 hexes)',
            ui.overload,
            (on) => act.setOverload(on),
            'Warships may perform one overload manoeuvre between maintenance stopovers',
          ),
        ),
        note(
          'info',
          'One overload is allowed between maintenance stopovers; resupplying at a base restores it.',
        ),
      ),
    );
  } else if (ship.overloadAvailable && ship.fuel < 2) {
    out.push(section('Overload manoeuvre', note('warn', 'Not enough fuel for an overload.')));
  }

  // --- Weak gravity --------------------------------------------------------

  if (ship.optionalGravity.length > 0) {
    // "A ship passing through one weak gravity hex may ignore it or use it, as
    // the player chooses." Only the first of a consecutive run is optional.
    const accepted = new Set(ship.acceptedOptionalGravity);
    out.push(
      section(
        'Weak gravity',
        ...ship.optionalGravity.map((h: Hex) =>
          toggle(`Accept pull at ${hexText(h)}`, accepted.has(key(h)), (on) =>
            act.dispatch({
              type: 'setOptionalGravity',
              by: activePlayer(state),
              ship: ship.id,
              hex: h,
              accept: on,
            }),
          ),
        ),
        note('info', 'Luna and Io pull weakly; the first hex of a run may be declined.'),
      ),
    );
  }

  // --- Landing -------------------------------------------------------------

  const orbit = map.orbitOf(ship.pos, ship.velocity);
  const md = movementData(state);
  const landingSide = md.landing[ship.id];

  if (landingSide) {
    out.push(
      section(
        'Landing',
        note(
          'good',
          `Committed to landing on ${map.bodyAt(landingSide.hex)?.name ?? 'the surface'}, hexside ${landingSide.dir}.`,
        ),
      ),
    );
  } else if (orbit && orbit.landing === 'hexside') {
    // "A ship may only land by expending one fuel point while in orbit. The ship
    // then moves to any hex side on the planet."
    out.push(
      section(
        'Landing',
        ui.landingPicker
          ? el(
              'div',
              { class: 'side-picker' },
              ...[0, 1, 2, 3, 4, 5].map((dir) => {
                const side = hexSide(orbit.hex, dir);
                const base = Object.values(state.bases).find(
                  (b) => b.side !== undefined && sideKey(b.side) === sideKey(side),
                );
                const devastated = state.devastatedSides.includes(sideKey(side));
                const owner = base?.owner ? state.players[base.owner] : undefined;
                return button({
                  label: el(
                    'span',
                    { class: 'side-opt' },
                    el('span', { class: 'side-dir mono', text: `#${dir}` }),
                    el('span', {
                      class: 'side-label',
                      text: devastated
                        ? 'devastated'
                        : base
                          ? (owner?.name ?? 'neutral base')
                          : 'bare hexside',
                    }),
                  ),
                  variant: 'ghost',
                  disabled: devastated,
                  onClick: () => act.land(side),
                  title: base
                    ? 'A base here can refuel and repair, and allows a later takeoff'
                    : 'Landing on a bare hexside strands the ship: there are no boosters',
                });
              }),
              button({
                label: 'Cancel',
                variant: 'quiet',
                onClick: () => act.setLandingPicker(false),
              }),
            )
          : el(
              'div',
              { class: 'actions' },
              button({
                label: 'Land (1 fuel)',
                variant: 'ghost',
                disabled: ship.fuel < 1,
                onClick: () => act.setLandingPicker(true),
                title: `In orbit around ${orbit.name} — spend one fuel point to come down on any hexside`,
              }),
            ),
      ),
    );
  }

  // --- Ramming -------------------------------------------------------------

  const courseTo = plotted ?? predicted;
  const rammable = liveShips(state).filter(
    (s) =>
      s.id !== ship.id &&
      !areAllied(state, ship.owner, s.owner) &&
      s.location.kind !== 'landed' &&
      courseThroughCentre(ship.pos, courseTo, s.pos),
  );
  const declaredRam = md.rams[ship.id];
  if (rammable.length > 0 || declaredRam) {
    out.push(
      section(
        'Ramming',
        declaredRam
          ? note('warn', `Committed to ramming ${shipLabel(state.ships[declaredRam]!)}.`)
          : null,
        ...rammable.map((t) =>
          button({
            label: `Ram ${shipLabel(t)}`,
            variant: 'danger',
            onClick: () =>
              act.dispatch({
                type: 'declareRam',
                by: activePlayer(state),
                ship: ship.id,
                target: t.id,
              }),
            title: "The ramming ship's course must pass through the centre of the target's hex",
          }),
        ),
        note('info', 'Both ships roll on the ram column; a ram is rarely survived by either.'),
      ),
    );
  }

  // --- Prospecting ---------------------------------------------------------

  if (
    prospectingEnabled(state) &&
    isZero(ship.velocity) &&
    map.isAsteroid(ship.pos, new Set(state.clearedAsteroids))
  ) {
    const surveyed = state.prospected[key(ship.pos)];
    out.push(
      section(
        'Prospecting',
        statRow('Survey', surveyed ?? 'unsurveyed'),
        el(
          'div',
          { class: 'actions' },
          button({
            label: 'Mine ore',
            variant: 'ghost',
            disabled:
              ship.disabled > 0 ||
              (ship.plottedEndpoint !== undefined && !eq(ship.plottedEndpoint, ship.pos)),
            onClick: () =>
              act.dispatch({
                type: 'mineOre',
                by: activePlayer(state),
                ship: ship.id,
              }),
            title: 'Mining takes the place of movement: 0.1 ton per turn',
          }),
          ...(['automatedMine', 'robotGuards'] as const)
            .filter((k) => ship.cargo.some((c) => c.kind === k && c.quantity > 0))
            .map((k) =>
              button({
                label: k === 'automatedMine' ? 'Drop automated mine' : 'Drop robot guards',
                variant: 'ghost',
                onClick: () =>
                  act.dispatch({
                    type: 'emplaceEquipment',
                    by: activePlayer(state),
                    ship: ship.id,
                    kind: k,
                  }),
              }),
            ),
        ),
      ),
    );
  }

  return out;
};
