/**
 * The wire format for orders and results.
 *
 * A battle order leaves this app on a URL (`?battle=…`) or a clipboard, and a
 * result comes back the same way, so both are encoded as a single pasteable
 * token: JSON, UTF-8, base64url. The envelope carries a version and a kind so
 * a token pasted into the wrong box fails with a sentence rather than a
 * half-built battle.
 *
 * This file is duplicated, byte for byte in intent, in OGRE-VTT. The
 * two copies *are* the compatibility contract between the apps — change one
 * and the same change belongs in the other, and both codec tests pin the
 * envelope so an accidental drift fails a build rather than a hand-off.
 */

import type { BattleResult, OrderOfBattle } from './orders.js';

const VERSION = 1;

type Kind = 'order' | 'result';

interface Envelope {
  readonly v: number;
  readonly kind: Kind;
  readonly body: unknown;
}

// ---------------------------------------------------------------------------
// base64url, by hand
//
// `btoa` wants latin1, campaign text is UTF-8, and pulling a dependency for
// thirty lines is worse than the thirty lines.
// ---------------------------------------------------------------------------

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

const toBase64url = (bytes: Uint8Array): string => {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    out += ALPHABET[a >> 2]! + ALPHABET[((a & 0x03) << 4) | (b >> 4)]!;
    if (i + 1 < bytes.length) out += ALPHABET[((b & 0x0f) << 2) | (c >> 6)]!;
    if (i + 2 < bytes.length) out += ALPHABET[c & 0x3f]!;
  }
  return out;
};

const fromBase64url = (text: string): Uint8Array => {
  const clean = text.trim();
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of clean) {
    const value = ALPHABET.indexOf(ch);
    if (value < 0) throw new Error(`this is not a campaign token (unexpected "${ch}")`);
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
};

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

const seal = (kind: Kind, body: unknown): string => {
  const envelope: Envelope = { v: VERSION, kind, body };
  return toBase64url(new TextEncoder().encode(JSON.stringify(envelope)));
};

const open = (text: string, kind: Kind): unknown => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(fromBase64url(text)));
  } catch (err) {
    throw new Error(
      err instanceof Error && err.message.startsWith('this is not')
        ? err.message
        : 'this is not a campaign token (it does not decode to JSON)',
    );
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('this is not a campaign token (no envelope)');
  }
  const envelope = parsed as Partial<Envelope>;
  if (envelope.v !== VERSION) {
    throw new Error(`this token is version ${String(envelope.v)}; this app speaks ${VERSION}`);
  }
  if (envelope.kind !== kind) {
    const found = envelope.kind === 'order' ? 'a battle order' : 'a battle result';
    const wanted = kind === 'order' ? 'a battle order' : 'a battle result';
    throw new Error(`this token is ${found}, and this box wants ${wanted}`);
  }
  return envelope.body;
};

// ---------------------------------------------------------------------------
// Validation
//
// Enough to reject a mangled paste with a reason; the scenario that consumes
// the order still checks every unit id against its own tables.
// ---------------------------------------------------------------------------

const isRecordOfNumbers = (value: unknown): value is Record<string, number> =>
  typeof value === 'object' &&
  value !== null &&
  Object.values(value).every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0);

const asOrder = (body: unknown): OrderOfBattle => {
  const o = body as Partial<OrderOfBattle>;
  if (typeof o.battleId !== 'string' || o.battleId === '')
    throw new Error('the order has no battleId');
  if (typeof o.seed !== 'number' || !Number.isFinite(o.seed))
    throw new Error('the order has no seed');
  if (typeof o.scenarioId !== 'string') throw new Error('the order names no scenario');
  if (!Array.isArray(o.sides) || o.sides.length !== 2) {
    throw new Error('the order must have exactly two sides');
  }
  for (const side of o.sides) {
    if (typeof side.player !== 'string' || side.player === '')
      throw new Error('a side has no player');
    if (typeof side.faction !== 'string') throw new Error('a side has no faction');
    if (!isRecordOfNumbers(side.forces)) throw new Error('a side’s forces are not unit counts');
  }
  if (typeof o.terms !== 'object' || o.terms === null) throw new Error('the order has no terms');
  return o as OrderOfBattle;
};

const LEVELS = ['complete', 'standard', 'marginal'] as const;

const asResult = (body: unknown): BattleResult => {
  const r = body as Partial<BattleResult>;
  if (typeof r.battleId !== 'string' || r.battleId === '')
    throw new Error('the result has no battleId');
  if (!Array.isArray(r.winners) || !r.winners.every((w) => typeof w === 'string')) {
    throw new Error('the result names no winners list');
  }
  if (!LEVELS.includes(r.level as (typeof LEVELS)[number])) {
    throw new Error('the result has no victory level');
  }
  if (typeof r.survivors !== 'object' || r.survivors === null) {
    throw new Error('the result has no survivors');
  }
  for (const side of Object.values(r.survivors)) {
    if (!isRecordOfNumbers(side)) throw new Error('a survivor list is not unit counts');
  }
  if (!isRecordOfNumbers(r.victoryPoints ?? {}))
    throw new Error('the victory points are not numbers');
  if (typeof r.replay !== 'object' || r.replay === null || !Array.isArray(r.replay.log)) {
    throw new Error('the result carries no replay');
  }
  return r as BattleResult;
};

// ---------------------------------------------------------------------------
// The four verbs
// ---------------------------------------------------------------------------

export const encodeOrder = (order: OrderOfBattle): string => seal('order', order);

export const decodeOrder = (text: string): OrderOfBattle => asOrder(open(text, 'order'));

export const encodeResult = (result: BattleResult): string => seal('result', result);

export const decodeResult = (text: string): BattleResult => asResult(open(text, 'result'));
