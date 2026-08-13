/**
 * The rules drawer.
 *
 * Enough of Triplanetary to play a whole game without the booklet open. The
 * tables are built from `crt.ts` and `ships.ts` rather than retyped, so the
 * reference can never drift from the engine that rolls against it.
 */

import { GUN_DAMAGE, ODDS_COLUMNS, OTHER_DAMAGE } from '@engine/crt.js';
import { DETECTION_RANGE_PLANETARY_BASE, DETECTION_RANGE_SHIP } from '@engine/map.js';
import { ORDNANCE_LIFETIME } from '@engine/ordnance.js';
import { SHIP_CLASSES, type ShipClass } from '@engine/ships.js';
import { PHASES, PHASE_LABELS } from '@engine/types.js';
import { type Child, el } from '../components/dom.js';
import { type Overlay, openDrawer } from '../components/modal.js';
import { damageText, num } from '../format.js';

const PHASE_TEXT: Readonly<Record<string, string>> = {
  astrogation:
    'Plot every ship’s predicted course, then alter it. One fuel point moves the arrowhead one hex in any direction; an overload (warships only, once between maintenance stopovers) spends two fuel to move it two. Landing and takeoff are declared now.',
  ordnance:
    'Each ship may release one mine, torpedo or nuke — never while at a base, refuelling, taking off or landing. A torpedo may accelerate one or two hexes, on its launch turn only.',
  movement:
    'Ships fly their plotted courses. Mines, torpedoes and nukes belonging to the phasing player move too, and detonate on contact. Rams and asteroid strikes happen here.',
  combat:
    'Guns fire. Ships that are attacked may return fire before any damage is applied. Astrogation hazards are rolled for now.',
  resupply:
    'Refuel, rearm, transfer cargo, loot, rescue and capture. At the end of the phase every damaged ship recovers one D.',
};

const heading = (text: string): HTMLElement => el('h3', { class: 'help-h', text });
const para = (text: string): HTMLElement => el('p', { class: 'help-p', text });

const bullets = (...items: string[]): HTMLElement =>
  el('ul', { class: 'help-list' }, ...items.map((t) => el('li', { text: t })));

const gunTable = (): HTMLElement =>
  el(
    'table',
    { class: 'help-table' },
    el(
      'thead',
      {},
      el(
        'tr',
        {},
        el('th', { text: 'Roll' }),
        ...ODDS_COLUMNS.map((c) => el('th', { class: 'mono', text: c })),
      ),
    ),
    el(
      'tbody',
      {},
      ...[1, 2, 3, 4, 5, 6].map((roll) =>
        el(
          'tr',
          {},
          el('th', { class: 'mono', text: String(roll) }),
          ...ODDS_COLUMNS.map((c) => {
            const r = GUN_DAMAGE[c][roll - 1] ?? null;
            return el('td', {
              class: `mono${r === null ? ' is-null' : ''}${r === 'E' ? ' is-kill' : ''}`,
              text: damageText(r),
            });
          }),
        ),
      ),
    ),
  );

const otherTable = (): HTMLElement => {
  const kinds = ['torpedo', 'mine', 'asteroid', 'ram'] as const;
  return el(
    'table',
    { class: 'help-table' },
    el(
      'thead',
      {},
      el('tr', {}, el('th', { text: 'Roll' }), ...kinds.map((k) => el('th', { text: k }))),
    ),
    el(
      'tbody',
      {},
      ...[1, 2, 3, 4, 5, 6].map((roll) =>
        el(
          'tr',
          {},
          el('th', { class: 'mono', text: String(roll) }),
          ...kinds.map((k) => {
            const r = OTHER_DAMAGE[k][roll - 1] ?? null;
            return el('td', {
              class: `mono${r === null ? ' is-null' : ''}`,
              text: damageText(r),
            });
          }),
        ),
      ),
    ),
  );
};

const shipTable = (): HTMLElement => {
  const order: readonly ShipClass[] = [
    'transport',
    'packet',
    'tanker',
    'liner',
    'corvette',
    'corsair',
    'frigate',
    'dreadnaught',
    'torch',
    'orbitalBase',
  ];
  return el(
    'table',
    { class: 'help-table help-table-ships' },
    el(
      'thead',
      {},
      el(
        'tr',
        {},
        el('th', { text: 'Ship' }),
        el('th', { text: 'Combat' }),
        el('th', { text: 'Fuel' }),
        el('th', { text: 'Cargo' }),
        el('th', { text: 'Cost' }),
      ),
    ),
    el(
      'tbody',
      {},
      ...order.map((id) => {
        const d = SHIP_CLASSES[id];
        return el(
          'tr',
          {},
          el('th', { text: d.name }),
          el('td', {
            class: 'mono',
            text: `${d.combatStrength}${d.defensiveOnly ? 'D' : ''}`,
          }),
          el('td', { class: 'mono', text: num(d.fuelCapacity) }),
          el('td', { class: 'mono', text: num(d.cargoCapacity) }),
          el('td', { class: 'mono', text: num(d.cost) }),
        );
      }),
    ),
  );
};

const KEYS: readonly (readonly [string, string])[] = [
  ['Tab / Shift+Tab', 'cycle through your ships'],
  ['Space', 'end the current phase'],
  ['G', 'gravity arrows'],
  ['D', 'detection ranges'],
  ['H', 'course history'],
  ['F', 'fit the whole chart'],
  ['+ / −', 'zoom in and out'],
  ['Escape', 'clear the selection'],
  ['?', 'this drawer'],
];

export const openHelpDrawer = (host: HTMLElement, onClose?: () => void): Overlay => {
  const body: Child[] = [
    heading('Sequence of play'),
    para(
      'A turn is one day, and contains one player-turn for each player. Each player-turn has five phases.',
    ),
    el(
      'ol',
      { class: 'help-phases' },
      ...PHASES.map((p) =>
        el(
          'li',
          {},
          el('strong', { text: PHASE_LABELS[p] }),
          el('span', { text: ` — ${PHASE_TEXT[p] ?? ''}` }),
        ),
      ),
    ),

    heading('Vector movement'),
    bullets(
      'A ship that is not accelerated by thrust or gravity moves exactly as it did last turn: same direction, same distance.',
      'The predicted endpoint is position + velocity + the gravity picked up last turn. One fuel point shifts that endpoint one hex; an overload shifts it two.',
      'Gravity arrows point at the body and take effect the turn after the ship enters the hex. They are cumulative and mandatory — except that the first of a consecutive run of weak-gravity hexes (Luna, Io) may be declined.',
      'A ship moving one hex per turn between adjacent gravity hexes of the same body is in orbit, and stays there for free.',
      'If a course vector intersects the printed disc of an astral body, the ship has crashed. If the arrowhead ends off the chart, the ship is eliminated — though the predicted course may leave the map and come back.',
      'Takeoff is free from a friendly base: boosters lift the ship to the gravity hex above its hexside, where it sits stationary. Landing costs one fuel point and may be done only from orbit.',
      'Entering an asteroid hex at a speed greater than one hex per turn calls for one hazard roll per hex entered. Travelling along the hexside between two asteroid hexes counts as one hex.',
    ),

    heading('Gun combat'),
    bullets(
      'Express attacker strength against defender strength as a ratio and reduce it to a column. Rounding is always in the defender’s favour. Better than 4:1 is 4:1; worse than 1:4 has no effect at all.',
      'Range: −1 per hex, measured from the attacker’s closest approach along its course to the target’s final position.',
      'Relative velocity: −1 for each hex of velocity difference in excess of two.',
      'Attacks may be made through ships, ordnance and asteroids, but never through a moon, a planet, or Sol.',
      'Attackers may pool their strength; ships attacked together defend with the sum of theirs. With several ships involved, use the greatest range and velocity penalties.',
      'No ship may attack or be attacked more than once per combat phase.',
      'Attacked ships may return fire before damage is applied, joined by any ship in the victim’s hex sharing its course. Odds are recomputed in favour of the new defender.',
      'Ships with a D strength — transport, tanker, liner — may never attack or counterattack.',
      'A ship that attacks at worse than 1:1 and scores D2 or better becomes heroic: +1 to its gun rolls thereafter, once only.',
    ),
    heading('Gun combat damage'),
    gunTable(),
    para(
      'D1–D5 disable for that many turns; damage is cumulative and D6 or more destroys. A disabled ship cannot manoeuvre, launch ordnance, or attack — though a dreadnaught may still fire its guns, and an orbital base works at D1. Ships repair one D at the end of each resupply phase.',
    ),

    heading('Torpedoes, mines, asteroids and rams'),
    otherTable(),

    heading('Ordnance'),
    bullets(
      `Mines, torpedoes and nukes stay live for ${ORDNANCE_LIFETIME} turns, are affected by gravity, and move in the launching player’s movement phase.`,
      'A mine takes the launcher’s vector, and the launcher must change course so as not to share its hex. It detonates when a course passes through any portion of its hex.',
      'A torpedo may accelerate one or two hexes on its launch turn only, and hits a single target: ships in the hex are rolled for in random order until one is damaged.',
      'A nuke destroys everything in its hex automatically, and may be shot at 2:1 odds. Reaching a world, it devastates one hexside. Non-warships carry only one at a time.',
    ),

    heading('Detection and resupply'),
    bullets(
      `Ships detect at ${DETECTION_RANGE_SHIP} hexes, planetary bases at ${DETECTION_RANGE_PLANETARY_BASE}. Once detected, a ship stays detected until it reaches a friendly base.`,
      'Matching courses with a friendly base gives unlimited fuel, mines and torpedoes, repairs all damage, and restores the overload manoeuvre.',
      'A ship that resupplies may not fire its guns or launch ordnance in that player-turn.',
      'Planetary defences fire at 2:1 into the gravity hex directly above their hexside, with no range or velocity modifiers.',
      'Looting, rescue, capture and cargo transfer all require matched courses: the same hex and the same vector. Only disabled or surrendered ships may be looted, and a captured ship must reach a base friendly to the captor.',
    ),

    heading('Ship types'),
    shipTable(),

    heading('Keyboard'),
    el(
      'dl',
      { class: 'help-keys' },
      ...KEYS.flatMap(([k, v]) => [el('dt', {}, el('kbd', { text: k })), el('dd', { text: v })]),
    ),

    el('p', {
      class: 'help-colophon',
      text: 'Triplanetary is a trademark of Steve Jackson Games. This is a fan-made virtual tabletop; the rules summarised here are for play reference only.',
    }),
  ];

  return openDrawer(host, {
    title: 'Rules reference',
    body,
    side: 'right',
    ...(onClose ? { onClose } : {}),
  });
};
