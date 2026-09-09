/**
 * Presentation-layer formatting. Nothing here decides anything about the rules;
 * it only turns engine values into the words and numbers on the panels.
 */

import { isDisabled } from '@engine/combat.js';
import { type Hex, ORIGIN, distance, isZero, toPixel } from '@engine/hex.js';
import type { GameMap } from '@engine/map.js';
import { SHIP_CLASSES, type ShipClass } from '@engine/ships.js';
import type { GameState, Ship } from '@engine/types.js';

export { shipLabel } from '@engine/movement.js';

export type Tone = 'good' | 'warn' | 'bad' | 'info' | 'muted';

export const className = (c: ShipClass): string => SHIP_CLASSES[c].name;

/** Infinity is a real value in the ship table (torch fuel, orbital-base hold). */
export const num = (n: number): string =>
  n === Infinity ? '∞' : String(Math.round(n * 100) / 100);

export const signed = (n: number): string => (n > 0 ? `+${n}` : String(n));

export const hexText = (h: Hex): string => `${h.q}, ${h.r}`;

/** Eight-point arrow for a course vector; pointy-top hexes, screen y grows down. */
export const headingGlyph = (v: Hex): string => {
  if (isZero(v)) return '·';
  const p = toPixel(v, 1);
  const octant = Math.round(Math.atan2(p.y, p.x) / (Math.PI / 4));
  const arrows = ['→', '↘', '↓', '↙', '←', '↖', '↑', '↗'];
  return arrows[((octant % 8) + 8) % 8]!;
};

/** "3 hexes/turn ↗ (2, 1)" — speed, heading and the raw vector. */
export const vectorText = (v: Hex): string => {
  const speed = distance(ORIGIN, v);
  if (speed === 0) return 'stationary';
  return `${speed} ${headingGlyph(v)} (${v.q}, ${v.r})`;
};

export interface StatusWord {
  readonly word: string;
  readonly tone: Tone;
}

/**
 * The one-word condition shown on every fleet row.
 *
 * Orbit is derived, never stored — "a ship which moves at one hex per turn from
 * one gravity hex to an adjacent gravity hex of the same body is in orbit" — so
 * we ask the map rather than reading a flag.
 */
export const statusOf = (state: GameState, map: GameMap, ship: Ship): StatusWord => {
  if (ship.destroyed) return { word: 'lost', tone: 'bad' };
  if (isDisabled(ship, state.options.advancedCombat)) {
    return {
      word: ship.disabled > 0 ? `disabled ${ship.disabled}` : 'disabled',
      tone: 'bad',
    };
  }
  if (ship.location.kind === 'landed') return { word: 'landed', tone: 'muted' };
  if (ship.location.kind === 'asteroidBase') return { word: 'moored', tone: 'muted' };
  const orbit = map.orbitOf(ship.pos, ship.velocity);
  if (orbit) return { word: `orbiting ${orbit.name}`, tone: 'good' };
  if (isZero(ship.velocity)) return { word: 'adrift', tone: 'warn' };
  return { word: 'drifting', tone: 'info' };
};

/** "Day 4" — "Each turn represents one day." */
export const dayText = (turn: number): string => `Day ${turn}`;

export const ordinal = (n: number): string => {
  const rem10 = n % 10;
  const rem100 = n % 100;
  if (rem10 === 1 && rem100 !== 11) return `${n}st`;
  if (rem10 === 2 && rem100 !== 12) return `${n}nd`;
  if (rem10 === 3 && rem100 !== 13) return `${n}rd`;
  return `${n}th`;
};

export const pluralise = (n: number, one: string, many = `${one}s`): string =>
  `${n} ${n === 1 ? one : many}`;

/** Damage-result shorthand as printed on the tables: "–", "D3", "E". */
export const damageText = (r: number | 'E' | null): string =>
  r === null ? '–' : r === 'E' ? 'E' : `D${r}`;
