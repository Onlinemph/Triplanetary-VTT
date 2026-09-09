/**
 * One core's share of the tuning harness: plays the games it is sent and
 * reports a score per game. Forked by `tune-ai.ts` under tsx.
 */

import { SCENARIOS } from '../src/ogre/scenarios/index.js';
import { playGame, scoreFor } from '../src/ogre/ai/simulate.js';
import { fromVector, type Weights } from '../src/ogre/ai/weights.js';

export interface Job {
  readonly id: number;
  readonly scenario: string;
  readonly seed: number;
  /** Index into the generation's tables for each seat, by player order. */
  readonly seats: readonly number[];
  /** Which seat the score is read for. */
  readonly scored: number;
  /** Turns after which a game nobody has won is scored on points. */
  readonly maxTurns: number;
}

export interface JobResult {
  readonly id: number;
  readonly score: number;
  readonly finished: boolean;
  readonly turns: number;
  readonly ms: number;
  readonly error?: string;
}

let tables: Weights[] = [];

process.on(
  'message',
  (msg: { type: 'tables'; vectors: number[][] } | { type: 'run'; jobs: Job[] }) => {
    if (msg.type === 'tables') {
      tables = msg.vectors.map(fromVector);
      process.send!({ type: 'ready' });
      return;
    }
    const results: JobResult[] = [];
    for (const job of msg.jobs) {
      const def = SCENARIOS.find((s) => s.id === job.scenario);
      if (!def) {
        results.push({
          id: job.id,
          score: 0,
          finished: false,
          turns: 0,
          ms: 0,
          error: 'no scenario',
        });
        continue;
      }
      const t0 = performance.now();
      try {
        const order = def.build({ seed: job.seed }).playerOrder;
        const r = playGame(
          def,
          job.seed,
          (p) => {
            const seat = order.indexOf(p);
            return tables[job.seats[seat] ?? 0]!;
          },
          { maxTurns: job.maxTurns },
        );
        results.push({
          id: job.id,
          score: scoreFor(r, order[job.scored]!),
          finished: r.finished,
          turns: r.turns,
          ms: performance.now() - t0,
        });
      } catch (e) {
        results.push({
          id: job.id,
          score: -1,
          finished: false,
          turns: 0,
          ms: performance.now() - t0,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    process.send!({ type: 'done', results });
  },
);
