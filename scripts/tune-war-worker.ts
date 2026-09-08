/**
 * One core's share of the war's tuning harness: plays the wars it is sent
 * and reports a score per war. Forked by `tune-war.ts` under tsx.
 */

import { buildScenario } from '../src/scenarios/index.js';
import { playWar, scoreWar } from '../src/ai/war/simulate.js';
import { warFromVector, type WarWeights } from '../src/ai/war/weights.js';

export interface WarJob {
  readonly id: number;
  readonly seed: number;
  /** Index into the generation's tables for each seat, by player order. */
  readonly seats: readonly number[];
  /** Which seat the score is read for. */
  readonly scored: number;
  /** Days after which a war nobody has won is scored on net worth. */
  readonly maxDays: number;
}

export interface WarJobResult {
  readonly id: number;
  readonly score: number;
  readonly finished: boolean;
  readonly battles: number;
  readonly days: number;
  readonly ms: number;
  readonly error?: string;
}

let tables: WarWeights[] = [];

process.on(
  'message',
  (msg: { type: 'tables'; vectors: number[][] } | { type: 'run'; jobs: WarJob[] }) => {
    if (msg.type === 'tables') {
      tables = msg.vectors.map(warFromVector);
      process.send!({ type: 'ready' });
      return;
    }
    const results: WarJobResult[] = [];
    for (const job of msg.jobs) {
      const t0 = performance.now();
      try {
        const order = buildScenario('orbital-drop', { seed: job.seed }).playerOrder;
        const r = playWar(
          job.seed,
          (p) => {
            const seat = order.indexOf(p);
            return tables[job.seats[seat] ?? 0]!;
          },
          { maxDays: job.maxDays },
        );
        results.push({
          id: job.id,
          score: scoreWar(r, order[job.scored]!),
          finished: r.finished,
          battles: r.battles,
          days: r.days,
          ms: performance.now() - t0,
          ...(r.refused !== undefined ? { error: r.refused } : {}),
        });
      } catch (e) {
        results.push({
          id: job.id,
          score: -1,
          finished: false,
          battles: 0,
          days: 0,
          ms: performance.now() - t0,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    process.send!({ type: 'done', results });
  },
);
