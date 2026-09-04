/**
 * Teach the computer opponent by playing it against itself.
 *
 * A cross-entropy search over the weight table in `src/ogre/ai/weights.ts`:
 * each generation samples a population of tables around the current mean,
 * plays every one of them through every scenario from every seat against
 * the reigning table (and the hand-set baseline, so progress is measured
 * against something that does not move), keeps the best, and moves the mean
 * toward them. The games are the tuner's only teacher: it never sees a rule
 * of thumb, only wins, losses and margins.
 *
 *   npx tsx scripts/tune-ai.ts --generations 12 --population 24 --seeds 2
 *
 * Writes `src/ogre/ai/tuned.ts` (the learned table) and a report to
 * `docs/ai-tuning-report.md`. A checkpoint in `.tune/` lets a run resume.
 */

import { fork, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { cpus } from 'node:os';
import { fileURLToPath } from 'node:url';
import { SCENARIOS } from '../src/ogre/scenarios/index.js';
import {
  BASE_WEIGHTS,
  DEFAULT_WEIGHTS,
  WEIGHT_KEYS,
  WEIGHT_SPEC,
  type Weights,
  fromVector,
  toVector,
} from '../src/ogre/ai/weights.js';
import type { Job, JobResult } from './tune-worker.js';

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const arg = (name: string, fallback: number): number => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : fallback;
};
const flag = (name: string): boolean => process.argv.includes(`--${name}`);
const listArg = (name: string): string[] | null => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]!.split(',') : null;
};

const GENERATIONS = arg('generations', 10);
const POPULATION = arg('population', 24);
const ELITE = arg('elite', Math.max(3, Math.round(POPULATION / 4)));
const SEEDS = arg('seeds', 2);
const SIGMA0 = arg('sigma', 0.25);
const WORKERS = arg('workers', Math.max(1, cpus().length));
const CAP_TURNS = arg('cap', 40);
const SCENARIO_IDS = listArg('scenarios') ?? SCENARIOS.map((s) => s.id);
const RESUME = flag('resume');
const EVALUATE = arg('evaluate', 0);
const DRY = flag('dry');

const here = fileURLToPath(new URL('.', import.meta.url));
const ROOT = `${here}..`;
const STATE_DIR = `${ROOT}/.tune`;
const STATE_FILE = `${STATE_DIR}/state.json`;
const OUT_FILE = `${ROOT}/src/ogre/ai/tuned.ts`;
const REPORT_FILE = `${ROOT}/docs/ai-tuning-report.md`;

// ---------------------------------------------------------------------------
// The search space: every weight mapped to [0, 1] across its allowed range
// ---------------------------------------------------------------------------

const N = WEIGHT_KEYS.length;
const lo = WEIGHT_KEYS.map((k) => WEIGHT_SPEC[k].min);
const hi = WEIGHT_KEYS.map((k) => WEIGHT_SPEC[k].max);

const normalise = (w: Weights): number[] =>
  toVector(w).map((v, i) => (hi[i]! === lo[i]! ? 0 : (v - lo[i]!) / (hi[i]! - lo[i]!)));
const denormalise = (x: readonly number[]): number[] =>
  x.map((v, i) => lo[i]! + Math.min(1, Math.max(0, v)) * (hi[i]! - lo[i]!));
const clip01 = (x: number[]): number[] => x.map((v) => Math.min(1, Math.max(0, v)));

// A small, seeded generator so a run is repeatable.
let rngState = arg('rng', 0x9e3779b9) >>> 0;
const rand = (): number => {
  rngState = (rngState + 0x6d2b79f5) >>> 0;
  let t = rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const gaussian = (): number => {
  const u = 1 - rand();
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

// ---------------------------------------------------------------------------
// Workers
// ---------------------------------------------------------------------------

interface Worker {
  readonly proc: ChildProcess;
  busy: boolean;
}

const spawnWorkers = (): Worker[] =>
  Array.from({ length: WORKERS }, () => ({
    proc: fork(`${here}tune-worker.ts`, [], { execArgv: ['--import', 'tsx'] }),
    busy: false,
  }));

const send = (w: Worker, msg: object): Promise<unknown> =>
  new Promise((resolve) => {
    w.proc.once('message', resolve);
    w.proc.send(msg);
  });

const loadTables = async (workers: Worker[], vectors: number[][]): Promise<void> => {
  await Promise.all(workers.map((w) => send(w, { type: 'tables', vectors })));
};

/** Spread the jobs over the workers in chunks, gathering results as they come. */
const runJobs = async (
  workers: Worker[],
  jobs: Job[],
  onProgress: (n: number) => void,
): Promise<JobResult[]> => {
  const results: JobResult[] = [];
  const chunk = Math.max(1, Math.ceil(jobs.length / (workers.length * 6)));
  let next = 0;
  let done = 0;
  await Promise.all(
    workers.map(async (w) => {
      while (next < jobs.length) {
        const batch = jobs.slice(next, next + chunk);
        next += chunk;
        const reply = (await send(w, { type: 'run', jobs: batch })) as { results: JobResult[] };
        results.push(...reply.results);
        done += batch.length;
        onProgress(done);
      }
    }),
  );
  return results;
};

// ---------------------------------------------------------------------------
// The generation
// ---------------------------------------------------------------------------

interface Checkpoint {
  generation: number;
  /** The weight keys `mu` and `sigma` are indexed by, so a changed table can be picked up. */
  keys?: string[];
  mu: number[];
  sigma: number[];
  history: {
    generation: number;
    best: number;
    mean: number;
    muVsBase: number;
    games: number;
    seconds: number;
  }[];
  games: number;
}

const fresh = (): Checkpoint => ({
  generation: 0,
  keys: [...WEIGHT_KEYS],
  mu: normalise(DEFAULT_WEIGHTS),
  sigma: Array.from({ length: N }, () => SIGMA0),
  history: [],
  games: 0,
});

/**
 * A checkpoint written against an older table is remapped by key: weights
 * it knew keep their mean and spread, new ones start from the shipped
 * default at the starting spread.
 */
const load = (): Checkpoint => {
  if (RESUME && existsSync(STATE_FILE)) {
    const cp = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as Checkpoint;
    if (!cp.keys && cp.mu.length === N) return { ...cp, keys: [...WEIGHT_KEYS] };
    if (cp.keys) {
      const start = fresh();
      const index = new Map(cp.keys.map((k, i) => [k, i]));
      let kept = 0;
      const mu = WEIGHT_KEYS.map((k, i) => {
        const j = index.get(k);
        if (j === undefined) return start.mu[i]!;
        kept++;
        return cp.mu[j]!;
      });
      const sigma = WEIGHT_KEYS.map((k, i) => {
        const j = index.get(k);
        return j === undefined ? start.sigma[i]! : cp.sigma[j]!;
      });
      if (kept < N) console.log(`checkpoint remapped: ${kept} weights kept, ${N - kept} new`);
      return { ...cp, keys: [...WEIGHT_KEYS], mu, sigma };
    }
    console.log('checkpoint has a different weight table and no keys; starting over');
  }
  return fresh();
};

const save = (cp: Checkpoint): void => {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(cp));
};

const fmt = (n: number): string => (n >= 0 ? '+' : '') + n.toFixed(3);

const main = async (): Promise<void> => {
  const scenarios = SCENARIOS.filter((s) => SCENARIO_IDS.includes(s.id));
  const seats = Object.fromEntries(
    scenarios.map((s) => [s.id, s.build({ seed: 1 }).playerOrder.length]),
  ) as Record<string, number>;
  const gamesPerTable = scenarios.reduce((n, s) => n + seats[s.id]! * SEEDS, 0);
  console.log(
    `tuning ${N} weights over ${scenarios.length} scenarios · population ${POPULATION}, elite ${ELITE}, ${SEEDS} seed(s) per seat · ${gamesPerTable * (POPULATION + 1)} games a generation on ${WORKERS} workers`,
  );
  if (DRY) return;
  if (EVALUATE > 0) {
    await evaluate(scenarios, seats, EVALUATE);
    return;
  }

  const cp = load();
  const workers = spawnWorkers();
  const baseline = normalise(BASE_WEIGHTS);

  try {
    for (let g = cp.generation; g < GENERATIONS; g++) {
      const t0 = performance.now();
      // The population: the mean itself, then samples around it.
      const population: number[][] = [cp.mu.slice()];
      while (population.length < POPULATION) {
        population.push(clip01(cp.mu.map((m, i) => m + cp.sigma[i]! * gaussian())));
      }
      // Tables: candidates, then the reigning mean (opponent), then the baseline.
      const OPP = population.length;
      const BASE = population.length + 1;
      const vectors = [...population, cp.mu.slice(), baseline].map(denormalise);
      await loadTables(workers, vectors);

      const jobs: Job[] = [];
      let id = 0;
      const seeds = Array.from({ length: SEEDS }, (_, i) => 1000 * (g + 1) + i);
      for (let c = 0; c < population.length; c++) {
        for (const s of scenarios) {
          for (let seat = 0; seat < seats[s.id]!; seat++) {
            for (const seed of seeds) {
              const seatTables = Array.from({ length: seats[s.id]! }, (_, i) =>
                i === seat ? c : OPP,
              );
              jobs.push({
                id: id++,
                scenario: s.id,
                seed,
                seats: seatTables,
                scored: seat,
                maxTurns: CAP_TURNS,
              });
            }
          }
        }
      }
      // The mean against the fixed baseline, for a yardstick that does not move.
      const yardstick: Job[] = [];
      for (const s of scenarios) {
        for (let seat = 0; seat < seats[s.id]!; seat++) {
          for (const seed of seeds) {
            const seatTables = Array.from({ length: seats[s.id]! }, (_, i) =>
              i === seat ? OPP : BASE,
            );
            yardstick.push({
              id: id++,
              scenario: s.id,
              seed,
              seats: seatTables,
              scored: seat,
              maxTurns: CAP_TURNS,
            });
          }
        }
      }

      const all = [...jobs, ...yardstick];
      process.stdout.write(`gen ${g + 1}/${GENERATIONS}: 0/${all.length} games`);
      const results = await runJobs(workers, all, (n) => {
        process.stdout.write(`\rgen ${g + 1}/${GENERATIONS}: ${n}/${all.length} games`);
      });
      process.stdout.write('\n');

      const byId = new Map(results.map((r) => [r.id, r]));
      const errors = results.filter((r) => r.error);
      if (errors.length) console.log(`  ${errors.length} games errored, e.g. ${errors[0]!.error}`);
      const unfinished = results.filter((r) => !r.finished && !r.error).length;

      const fitness = population.map((_, c) => {
        const own = jobs.filter((j) => j.seats[j.scored] === c);
        return own.reduce((n, j) => n + (byId.get(j.id)?.score ?? -1), 0) / own.length;
      });
      const muVsBase =
        yardstick.reduce((n, j) => n + (byId.get(j.id)?.score ?? -1), 0) / yardstick.length;

      const ranked = fitness.map((f, c) => ({ f, c })).sort((a, b) => b.f - a.f);
      const elite = ranked.slice(0, ELITE).map((r) => population[r.c]!);
      const mean = elite[0]!.map((_, i) => elite.reduce((n, e) => n + e[i]!, 0) / elite.length);
      const std = elite[0]!.map((_, i) =>
        Math.sqrt(elite.reduce((n, e) => n + (e[i]! - mean[i]!) ** 2, 0) / elite.length),
      );
      // Move the mean toward the elite; let the spread shrink where they agree.
      cp.mu = cp.mu.map((m, i) => 0.3 * m + 0.7 * mean[i]!);
      cp.sigma = cp.sigma.map((s, i) => Math.max(0.02, 0.6 * s + 0.4 * std[i]!));
      cp.generation = g + 1;
      cp.games += all.length;
      const seconds = (performance.now() - t0) / 1000;
      const avgMs = results.reduce((n, r) => n + r.ms, 0) / results.length;
      cp.history.push({
        generation: g + 1,
        best: ranked[0]!.f,
        mean: fitness.reduce((a, b) => a + b, 0) / fitness.length,
        muVsBase,
        games: all.length,
        seconds,
      });
      save(cp);
      console.log(
        `  best ${fmt(ranked[0]!.f)} (candidate ${ranked[0]!.c}${ranked[0]!.c === 0 ? ', the mean' : ''}) · population mean ${fmt(cp.history[cp.history.length - 1]!.mean)} · reigning table vs baseline ${fmt(muVsBase)} · ${unfinished} unfinished · ${avgMs.toFixed(0)} ms/game · ${seconds.toFixed(0)} s`,
      );
    }
  } finally {
    for (const w of workers) w.proc.kill();
  }

  if (!flag('nowrite')) writeOutputs(cp);
  else console.log('(--nowrite: leaving tuned.ts and the report alone)');
};

/**
 * The shipped table against the hand-set baseline, every scenario from every
 * seat, `seeds` games each: the number the report should quote, from many
 * more games than one generation's yardstick.
 */
const evaluate = async (
  scenarios: readonly (typeof SCENARIOS)[number][],
  seats: Record<string, number>,
  seeds: number,
): Promise<void> => {
  const workers = spawnWorkers();
  try {
    await loadTables(workers, [toVector(DEFAULT_WEIGHTS), toVector(BASE_WEIGHTS)]);
    const jobs: Job[] = [];
    let id = 0;
    for (const s of scenarios) {
      for (let seat = 0; seat < seats[s.id]!; seat++) {
        for (let seed = 1; seed <= seeds; seed++) {
          const seatTables = Array.from({ length: seats[s.id]! }, (_, i) => (i === seat ? 0 : 1));
          jobs.push({
            id: id++,
            scenario: s.id,
            seed: 5000 + seed,
            seats: seatTables,
            scored: seat,
            maxTurns: CAP_TURNS,
          });
        }
      }
    }
    process.stdout.write(`evaluating: 0/${jobs.length} games`);
    const results = await runJobs(workers, jobs, (n) => {
      process.stdout.write(`\revaluating: ${n}/${jobs.length} games`);
    });
    process.stdout.write('\n');
    const byId = new Map(results.map((r) => [r.id, r]));
    let total = 0;
    console.log('scenario           seat   wins  losses  draws   mean');
    for (const s of scenarios) {
      const order = s.build({ seed: 1 }).playerOrder;
      for (let seat = 0; seat < seats[s.id]!; seat++) {
        const own = jobs.filter((j) => j.scenario === s.id && j.scored === seat);
        let wins = 0;
        let losses = 0;
        let draws = 0;
        let sum = 0;
        for (const j of own) {
          const r = byId.get(j.id);
          const score = r?.score ?? 0;
          sum += score;
          if (score > 0.5) wins++;
          else if (score < -0.5) losses++;
          else draws++;
        }
        total += sum;
        console.log(
          `${s.id.padEnd(18)} ${order[seat]!.padEnd(8)} ${String(wins).padStart(4)} ${String(losses).padStart(7)} ${String(draws).padStart(6)}  ${fmt(sum / own.length)}`,
        );
      }
    }
    console.log(
      `overall: ${fmt(total / jobs.length)} per game over ${jobs.length} games (learned table vs hand-set baseline)`,
    );
  } finally {
    for (const w of workers) w.proc.kill();
  }
};

const writeOutputs = (cp: Checkpoint): void => {
  const learned = fromVector(denormalise(cp.mu));
  const lines = WEIGHT_KEYS.map((k) => `  '${k}': ${round(learned[k])},`);
  const last = cp.history[cp.history.length - 1];
  const note = `${cp.generation} generations, ${cp.games} games; reigning table vs the hand-set baseline ${last ? fmt(last.muVsBase) : 'n/a'} per game`;
  writeFileSync(
    OUT_FILE,
    `/**
 * Weights learned by \`scripts/tune-ai.ts\`. Generated; do not edit by hand —
 * run the tuner and commit what it writes.
 */

import type { Weights } from './weights.js';

export const TUNED: Partial<Weights> = {
${lines.join('\n')}
};

/** A note on the run that produced these, for the record. */
export const TUNED_NOTE = ${JSON.stringify(note)};
`,
  );

  const deltas = WEIGHT_KEYS.map((k) => {
    const base = BASE_WEIGHTS[k];
    const span = WEIGHT_SPEC[k].max - WEIGHT_SPEC[k].min;
    return { k, base, now: learned[k], shift: span ? (learned[k] - base) / span : 0 };
  }).sort((a, b) => Math.abs(b.shift) - Math.abs(a.shift));
  const report = [
    '# AI tuning report',
    '',
    `Generated by \`scripts/tune-ai.ts\`: ${note}.`,
    '',
    '## Progress',
    '',
    '| Generation | Best candidate | Population mean | Reigning vs baseline | Games | Seconds |',
    '|---:|---:|---:|---:|---:|---:|',
    ...cp.history.map(
      (h) =>
        `| ${h.generation} | ${fmt(h.best)} | ${fmt(h.mean)} | ${fmt(h.muVsBase)} | ${h.games} | ${h.seconds.toFixed(0)} |`,
    ),
    '',
    'Scores are per game from the scored seat: a win counts +1 (complete), +0.85 (standard) or +0.7 (marginal), a loss the same below zero, with the victory-point margin as a tie-breaker of up to ±0.3.',
    '',
    '## What moved most',
    '',
    '| Weight | Hand-set | Learned | Shift across its range | What it does |',
    '|---|---:|---:|---:|---|',
    ...deltas
      .slice(0, 30)
      .map(
        (d) =>
          `| \`${d.k}\` | ${round(d.base)} | ${round(d.now)} | ${(d.shift * 100).toFixed(0)}% | ${WEIGHT_SPEC[d.k].about} |`,
      ),
    '',
    '## The whole table',
    '',
    '| Weight | Learned | What it does |',
    '|---|---:|---|',
    ...WEIGHT_KEYS.map((k) => `| \`${k}\` | ${round(learned[k])} | ${WEIGHT_SPEC[k].about} |`),
    '',
  ].join('\n');
  writeFileSync(REPORT_FILE, report);
  console.log(`wrote ${OUT_FILE} and ${REPORT_FILE}`);
  console.log('biggest shifts:');
  for (const d of deltas.slice(0, 12)) {
    console.log(
      `  ${d.k.padEnd(28)} ${String(round(d.base)).padStart(8)} → ${String(round(d.now)).padStart(8)}  (${(d.shift * 100).toFixed(0)}%)`,
    );
  }
};

const round = (n: number): number => Number(n.toPrecision(3));

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
