/**
 * Teach the general staff by playing the war against itself.
 *
 * A cross-entropy search over the weight table in `src/ai/war/weights.ts`,
 * the same search `tune-ai.ts` runs over the ground game's table: each
 * generation samples a population of tables around the current mean, plays
 * every one of them through Orbital Drop from both seats against the
 * reigning table (and the hand-set baseline, so progress is measured against
 * something that does not move), keeps the best, and moves the mean toward
 * them. The wars are the tuner's only teacher: it never sees a rule of
 * thumb, only net worth, bases held, and the knife.
 *
 * The ground battles inside every war are fought by the ground game's own
 * computer with its shipped table on both sides, so the search is over the
 * staff alone.
 *
 *   npx tsx scripts/tune-war.ts --generations 8 --population 12 --seeds 1 --days 60
 *
 * Writes `src/ai/war/tuned.ts` (the learned table) and a report to
 * `docs/war-tuning-report.md`. A checkpoint in `.tune-war/` lets a run resume.
 */

import { fork, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { cpus } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  BASE_WAR_WEIGHTS,
  DEFAULT_WAR_WEIGHTS,
  WAR_WEIGHT_KEYS,
  WAR_WEIGHT_SPEC,
  type WarWeights,
  warFromVector,
  warToVector,
} from '../src/ai/war/weights.js';
import type { WarJob, WarJobResult } from './tune-war-worker.js';

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const arg = (name: string, fallback: number): number => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : fallback;
};
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const GENERATIONS = arg('generations', 8);
const POPULATION = arg('population', 12);
const ELITE = arg('elite', Math.max(3, Math.round(POPULATION / 4)));
const SEEDS = arg('seeds', 1);
const SIGMA0 = arg('sigma', 0.25);
const WORKERS = arg('workers', Math.max(1, cpus().length));
const DAYS = arg('days', 60);
const SEATS = 2;
const RESUME = flag('resume');
const EVALUATE = arg('evaluate', 0);
const DRY = flag('dry');

const here = fileURLToPath(new URL('.', import.meta.url));
const ROOT = `${here}..`;
const STATE_DIR = `${ROOT}/.tune-war`;
const STATE_FILE = `${STATE_DIR}/state.json`;
const OUT_FILE = `${ROOT}/src/ai/war/tuned.ts`;
const REPORT_FILE = `${ROOT}/docs/war-tuning-report.md`;

// ---------------------------------------------------------------------------
// The search space: every weight mapped to [0, 1] across its allowed range
// ---------------------------------------------------------------------------

const N = WAR_WEIGHT_KEYS.length;
const lo = WAR_WEIGHT_KEYS.map((k) => WAR_WEIGHT_SPEC[k].min);
const hi = WAR_WEIGHT_KEYS.map((k) => WAR_WEIGHT_SPEC[k].max);

const normalise = (w: WarWeights): number[] =>
  warToVector(w).map((v, i) => (hi[i]! === lo[i]! ? 0 : (v - lo[i]!) / (hi[i]! - lo[i]!)));
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
    proc: fork(`${here}tune-war-worker.ts`, [], { execArgv: ['--import', 'tsx'] }),
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

/** One war at a time per worker: wars are long and few, so the chunk is one. */
const runJobs = async (
  workers: Worker[],
  jobs: WarJob[],
  onProgress: (n: number) => void,
): Promise<WarJobResult[]> => {
  const results: WarJobResult[] = [];
  let next = 0;
  let done = 0;
  await Promise.all(
    workers.map(async (w) => {
      while (next < jobs.length) {
        const batch = jobs.slice(next, next + 1);
        next += 1;
        const reply = (await send(w, { type: 'run', jobs: batch })) as {
          results: WarJobResult[];
        };
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
  keys?: string[];
  mu: number[];
  sigma: number[];
  history: {
    generation: number;
    best: number;
    mean: number;
    muVsBase: number;
    wars: number;
    battles: number;
    seconds: number;
  }[];
  wars: number;
}

const fresh = (): Checkpoint => ({
  generation: 0,
  keys: [...WAR_WEIGHT_KEYS],
  mu: normalise(DEFAULT_WAR_WEIGHTS),
  sigma: Array.from({ length: N }, () => SIGMA0),
  history: [],
  wars: 0,
});

/** A checkpoint against an older table is remapped by key; new weights start fresh. */
const load = (): Checkpoint => {
  if (RESUME && existsSync(STATE_FILE)) {
    const cp = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as Checkpoint;
    if (cp.keys) {
      const start = fresh();
      const index = new Map(cp.keys.map((k, i) => [k, i]));
      let kept = 0;
      const mu = WAR_WEIGHT_KEYS.map((k, i) => {
        const j = index.get(k);
        if (j === undefined) return start.mu[i]!;
        kept++;
        return cp.mu[j]!;
      });
      const sigma = WAR_WEIGHT_KEYS.map((k, i) => {
        const j = index.get(k);
        return j === undefined ? start.sigma[i]! : cp.sigma[j]!;
      });
      if (kept < N) console.log(`checkpoint remapped: ${kept} weights kept, ${N - kept} new`);
      return { ...cp, keys: [...WAR_WEIGHT_KEYS], mu, sigma };
    }
    console.log('checkpoint has no keys; starting over');
  }
  return fresh();
};

const save = (cp: Checkpoint): void => {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(cp));
};

const fmt = (n: number): string => (n >= 0 ? '+' : '') + n.toFixed(3);

const main = async (): Promise<void> => {
  const warsPerTable = SEATS * SEEDS;
  console.log(
    `tuning ${N} weights · population ${POPULATION}, elite ${ELITE}, ${SEEDS} seed(s) per seat, ${DAYS} days · ${warsPerTable * (POPULATION + 1)} wars a generation on ${WORKERS} workers`,
  );
  if (DRY) return;
  if (EVALUATE > 0) {
    await evaluate(EVALUATE);
    return;
  }

  const cp = load();
  const workers = spawnWorkers();
  const baseline = normalise(BASE_WAR_WEIGHTS);

  try {
    for (let g = cp.generation; g < GENERATIONS; g++) {
      const t0 = performance.now();
      const population: number[][] = [cp.mu.slice()];
      while (population.length < POPULATION) {
        population.push(clip01(cp.mu.map((m, i) => m + cp.sigma[i]! * gaussian())));
      }
      const OPP = population.length;
      const BASE = population.length + 1;
      const vectors = [...population, cp.mu.slice(), baseline].map(denormalise);
      await loadTables(workers, vectors);

      const jobs: WarJob[] = [];
      let id = 0;
      const seeds = Array.from({ length: SEEDS }, (_, i) => 1000 * (g + 1) + i);
      for (let c = 0; c < population.length; c++) {
        for (let seat = 0; seat < SEATS; seat++) {
          for (const seed of seeds) {
            const seatTables = Array.from({ length: SEATS }, (_, i) => (i === seat ? c : OPP));
            jobs.push({ id: id++, seed, seats: seatTables, scored: seat, maxDays: DAYS });
          }
        }
      }
      const yardstick: WarJob[] = [];
      for (let seat = 0; seat < SEATS; seat++) {
        for (const seed of seeds) {
          const seatTables = Array.from({ length: SEATS }, (_, i) => (i === seat ? OPP : BASE));
          yardstick.push({ id: id++, seed, seats: seatTables, scored: seat, maxDays: DAYS });
        }
      }

      const all = [...jobs, ...yardstick];
      process.stdout.write(`gen ${g + 1}/${GENERATIONS}: 0/${all.length} wars`);
      const results = await runJobs(workers, all, (n) => {
        process.stdout.write(`\rgen ${g + 1}/${GENERATIONS}: ${n}/${all.length} wars`);
      });
      process.stdout.write('\n');

      const byId = new Map(results.map((r) => [r.id, r]));
      const errors = results.filter((r) => r.error);
      if (errors.length) console.log(`  ${errors.length} wars errored, e.g. ${errors[0]!.error}`);
      const battles = results.reduce((n, r) => n + r.battles, 0);

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
      cp.mu = cp.mu.map((m, i) => 0.3 * m + 0.7 * mean[i]!);
      cp.sigma = cp.sigma.map((s, i) => Math.max(0.02, 0.6 * s + 0.4 * std[i]!));
      cp.generation = g + 1;
      cp.wars += all.length;
      const seconds = (performance.now() - t0) / 1000;
      const avgMs = results.reduce((n, r) => n + r.ms, 0) / results.length;
      cp.history.push({
        generation: g + 1,
        best: ranked[0]!.f,
        mean: fitness.reduce((a, b) => a + b, 0) / fitness.length,
        muVsBase,
        wars: all.length,
        battles,
        seconds,
      });
      save(cp);
      console.log(
        `  best ${fmt(ranked[0]!.f)} (candidate ${ranked[0]!.c}${ranked[0]!.c === 0 ? ', the mean' : ''}) · population mean ${fmt(cp.history[cp.history.length - 1]!.mean)} · reigning table vs baseline ${fmt(muVsBase)} · ${battles} battles · ${(avgMs / 1000).toFixed(1)} s/war · ${seconds.toFixed(0)} s`,
      );
    }
  } finally {
    for (const w of workers) w.proc.kill();
  }

  if (!flag('nowrite')) writeOutputs(cp);
  else console.log('(--nowrite: leaving tuned.ts and the report alone)');
};

/** The shipped table against the hand-set baseline, both seats, `seeds` wars each. */
const evaluate = async (seeds: number): Promise<void> => {
  const workers = spawnWorkers();
  try {
    await loadTables(workers, [warToVector(DEFAULT_WAR_WEIGHTS), warToVector(BASE_WAR_WEIGHTS)]);
    const jobs: WarJob[] = [];
    let id = 0;
    for (let seat = 0; seat < SEATS; seat++) {
      for (let seed = 1; seed <= seeds; seed++) {
        const seatTables = Array.from({ length: SEATS }, (_, i) => (i === seat ? 0 : 1));
        jobs.push({ id: id++, seed: 5000 + seed, seats: seatTables, scored: seat, maxDays: DAYS });
      }
    }
    process.stdout.write(`evaluating: 0/${jobs.length} wars`);
    const results = await runJobs(workers, jobs, (n) => {
      process.stdout.write(`\revaluating: ${n}/${jobs.length} wars`);
    });
    process.stdout.write('\n');
    const byId = new Map(results.map((r) => [r.id, r]));
    let total = 0;
    console.log('seat      wins  losses  draws   mean  battles');
    for (let seat = 0; seat < SEATS; seat++) {
      const own = jobs.filter((j) => j.scored === seat);
      let wins = 0;
      let losses = 0;
      let draws = 0;
      let sum = 0;
      let battles = 0;
      for (const j of own) {
        const r = byId.get(j.id);
        const score = r?.score ?? 0;
        sum += score;
        battles += r?.battles ?? 0;
        if (score > 0.5) wins++;
        else if (score < -0.5) losses++;
        else draws++;
      }
      total += sum;
      console.log(
        `${String(seat).padEnd(8)} ${String(wins).padStart(4)} ${String(losses).padStart(7)} ${String(draws).padStart(6)}  ${fmt(sum / own.length)}  ${battles}`,
      );
    }
    console.log(
      `overall: ${fmt(total / jobs.length)} per war over ${jobs.length} wars (learned table vs hand-set baseline)`,
    );
  } finally {
    for (const w of workers) w.proc.kill();
  }
};

const writeOutputs = (cp: Checkpoint): void => {
  const learned = warFromVector(denormalise(cp.mu));
  const lines = WAR_WEIGHT_KEYS.map((k) => `  '${k}': ${round(learned[k])},`);
  const last = cp.history[cp.history.length - 1];
  const note = `${cp.generation} generations, ${cp.wars} wars of ${DAYS} days; reigning table vs the hand-set baseline ${last ? fmt(last.muVsBase) : 'n/a'} per war`;
  writeFileSync(
    OUT_FILE,
    `/**
 * Weights learned by \`scripts/tune-war.ts\`. Generated; do not edit by hand —
 * run the tuner and commit what it writes.
 */

import type { WarWeights } from './weights.js';

export const WAR_TUNED: Partial<WarWeights> = {
${lines.join('\n')}
};

/** A note on the run that produced these, for the record. */
export const WAR_TUNED_NOTE = ${JSON.stringify(note)};
`,
  );

  const deltas = WAR_WEIGHT_KEYS.map((k) => {
    const base = BASE_WAR_WEIGHTS[k];
    const span = WAR_WEIGHT_SPEC[k].max - WAR_WEIGHT_SPEC[k].min;
    return { k, base, now: learned[k], shift: span ? (learned[k] - base) / span : 0 };
  }).sort((a, b) => Math.abs(b.shift) - Math.abs(a.shift));
  const report = [
    '# War tuning report',
    '',
    `Generated by \`scripts/tune-war.ts\`: ${note}.`,
    '',
    '## Progress',
    '',
    '| Generation | Best candidate | Population mean | Reigning vs baseline | Wars | Battles | Seconds |',
    '|---:|---:|---:|---:|---:|---:|---:|',
    ...cp.history.map(
      (h) =>
        `| ${h.generation} | ${fmt(h.best)} | ${fmt(h.mean)} | ${fmt(h.muVsBase)} | ${h.wars} | ${h.battles} | ${h.seconds.toFixed(0)} |`,
    ),
    '',
    'Scores are per war from the scored seat: a war won to the knife counts +1 and a war lost −1, each shaded by half the net-worth margin; a war still running at the day cap is scored on the net-worth margin alone, at ±1 for six hundred MegaCredits — two planetary bases — in either direction.',
    '',
    '## What moved most',
    '',
    '| Weight | Hand-set | Learned | Shift across its range | What it does |',
    '|---|---:|---:|---:|---|',
    ...deltas
      .slice(0, 20)
      .map(
        (d) =>
          `| \`${d.k}\` | ${round(d.base)} | ${round(d.now)} | ${(d.shift * 100).toFixed(0)}% | ${WAR_WEIGHT_SPEC[d.k].about} |`,
      ),
    '',
    '## The whole table',
    '',
    '| Weight | Learned | What it does |',
    '|---|---:|---|',
    ...WAR_WEIGHT_KEYS.map(
      (k) => `| \`${k}\` | ${round(learned[k])} | ${WAR_WEIGHT_SPEC[k].about} |`,
    ),
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
