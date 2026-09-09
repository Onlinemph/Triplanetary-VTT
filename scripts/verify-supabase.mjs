/**
 * Probe a live Supabase project for the things no test can reach.
 *
 * `tests/supabase-schema.test.ts` runs the migrations in real PostgreSQL and
 * attacks the policies, and it is the stronger of the two suites — it can open
 * a deliberate hole and prove the hole is caught. What it cannot do is run
 * *Supabase*. Three things only exist on the platform:
 *
 *  - **PostgREST's schema exposure.** The policies assume `anon` and
 *    `authenticated` reach `public` and nothing else, and that a table with no
 *    grant is not reachable at all. That is a server setting, not a migration.
 *  - **Realtime's row authorisation.** The whole fog design rests on "a row
 *    reaches a subscriber only if row level security would let that subscriber
 *    select it". True as documented; never observed here.
 *  - **Whether `config.toml`'s keys are the ones the cloud reads.** A key the
 *    platform ignores is a setting that silently does not apply.
 *
 * So this script is the other half of the schema suite, run against a project
 * that exists. Same cases, same names where they correspond, but the adversary
 * is a real anonymous account holding a real JWT and talking to the real API.
 * It also plays a game through the Edge Function, because the referee is the
 * one component that has never executed outside a bundler's smoke test.
 *
 * ## What it needs, and what it does not
 *
 * `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`, from `.env.local` or the
 * environment. That is all. It deliberately does **not** want the service role:
 * every check here is written from the position of an attacker who has an
 * account and nothing else, and handing this script the key that bypasses row
 * level security would let a check pass for the wrong reason.
 *
 * ## What it leaves behind
 *
 * Tables. It creates a handful of games and abandons them, which is exactly the
 * litter `reap_stale_lobbies()` exists to collect. Run it against a project you
 * are willing to leave a few dead lobbies in.
 *
 *     npm run verify:supabase
 */

import { createClient } from '@supabase/supabase-js';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * `.env.local` first, then the environment.
 *
 * Deliberately a five-line parser rather than a dependency: it reads the same
 * two `VITE_`-prefixed names Vite reads, and anything more clever would be a
 * second opinion about a file format that already has one.
 */
const loadConfig = async () => {
  const env = { ...process.env };
  const text = await readFile(join(ROOT, '.env.local'), 'utf8').catch(() => '');
  for (const line of text.split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && m[1] && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  const url = (env['VITE_SUPABASE_URL'] ?? '').trim();
  const key = (env['VITE_SUPABASE_ANON_KEY'] ?? '').trim();
  if (!url || !key) {
    throw new Error(
      'set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY, in .env.local or the environment',
    );
  }
  const secret = looksPrivileged(key);
  if (secret) {
    throw new Error(
      `that key ${secret} — this script must run as an ordinary client, or every check below passes for the wrong reason`,
    );
  }
  return { url, key };
};

/**
 * Is this a key that bypasses row level security?
 *
 * Worth more than one line, because getting it wrong is silent. Every denial
 * in this file is asserted by *attempting* the thing and finding it refused; a
 * privileged key is not refused, so the whole suite would go green while
 * proving the opposite of what it claims. A guard that fails open is worse than
 * no guard, so this errs toward refusing anything it cannot positively identify
 * as a client key.
 *
 * Two formats, because Supabase has two:
 *
 *  - the current one, where the prefix says it outright — `sb_secret_` against
 *    `sb_publishable_`;
 *  - the legacy JWT, where it does not. `service_role` lives in the *payload*,
 *    which is base64url, so searching the token text for that string finds
 *    nothing. It has to be decoded.
 */
const looksPrivileged = (key) => {
  if (key.startsWith('sb_secret_')) return 'is a secret key (sb_secret_…)';
  if (key.startsWith('sb_publishable_')) return null;

  const payload = key.split('.')[1];
  if (payload === undefined) return null; // Not a JWT and not a prefixed key.
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (claims.role === 'service_role') return 'is the service role key';
  } catch {
    // An unreadable payload is not evidence of anything. The prefix checks
    // above are the ones that matter for keys minted today.
  }
  return null;
};

// ---------------------------------------------------------------------------
// A very small harness
// ---------------------------------------------------------------------------

const cases = [];
/** Register a check. `expect` throws on failure; anything thrown is a failure. */
const check = (group, name, fn) => cases.push({ group, name, fn });

const fail = (msg) => {
  throw new Error(msg);
};
const expect = (cond, msg) => {
  if (!cond) fail(msg);
};

/**
 * A denial, asserted as a denial rather than as "not the data I wanted".
 *
 * PostgREST answers a blocked SELECT two different ways — an error for a
 * missing grant, an empty set for a policy that matched nothing — and both are
 * correct refusals. What must never happen is rows coming back.
 */
const expectNoRows = (res, what) => {
  if (res.error) return `refused (${res.error.code ?? 'error'})`;
  expect(Array.isArray(res.data), `${what}: expected rows or an error`);
  expect(res.data.length === 0, `${what}: LEAKED ${res.data.length} row(s)`);
  return 'empty';
};

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

const V = 1;

/** A fresh anonymous account. Two of these are two different players. */
const player = async ({ url, key }, label) => {
  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await supabase.auth.signInAnonymously();
  if (error) throw new Error(`${label}: anonymous sign-in failed — ${error.message}`);
  if (!data.user) throw new Error(`${label}: anonymous sign-in returned no user`);
  return { supabase, userId: data.user.id, label };
};

/**
 * Call the referee.
 *
 * `functions.invoke` turns a non-2xx into an error and discards the body, and
 * the referee's refusals *are* the interesting part, so this reads the response
 * directly the way `client.ts` does.
 */
const callReferee = async (p, cfg, body) => {
  const { data: sess } = await p.supabase.auth.getSession();
  const token = sess.session?.access_token ?? cfg.key;
  const res = await fetch(`${cfg.url}/functions/v1/game`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      apikey: cfg.key,
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`referee returned non-JSON (${res.status}): ${text.slice(0, 200)}`);
  }
  return { status: res.status, body: json };
};

const openTable = async (p, cfg, { fog, scenarioId = 'flight-school' }) => {
  const res = await callReferee(p, cfg, {
    action: 'create',
    v: V,
    scenarioId,
    options: { fogOfWar: fog },
  });
  if (!res.body?.ok) {
    throw new Error(`create failed (${res.status}): ${res.body?.reason ?? 'no reason given'}`);
  }
  return res.body.table;
};

// ---------------------------------------------------------------------------
// Platform facts
// ---------------------------------------------------------------------------

check('platform', 'anonymous sign-in is enabled', async (ctx) => {
  expect(ctx.host.userId.length > 0, 'no user id');
  return ctx.host.userId.slice(0, 8) + '…';
});

check('platform', 'the game Edge Function is deployed and answers', async (ctx) => {
  const res = await callReferee(ctx.host, ctx.cfg, { action: 'sync', v: V, gameId: 'nope' });
  expect(res.status !== 404, 'no function at /functions/v1/game — deploy it first');
  expect(res.body !== null, 'the function returned nothing parseable');
  return `HTTP ${res.status}`;
});

check('platform', 'the protocol version is enforced on the wire', async (ctx) => {
  const res = await callReferee(ctx.host, ctx.cfg, {
    action: 'create',
    v: V + 999,
    scenarioId: 'flight-school',
  });
  expect(res.body?.ok !== true, 'the referee accepted an unknown protocol version');
  return 'refused';
});

check('platform', 'PostgREST exposes public and nothing else', async (ctx) => {
  const res = await fetch(`${ctx.cfg.url}/rest/v1/`, {
    headers: { apikey: ctx.cfg.key, 'accept-profile': 'auth' },
  });
  // Reaching `auth` would mean the API is serving schemas the policies never
  // considered. A refusal — any refusal — is the right answer.
  expect(res.status >= 400, `the API served the auth schema (HTTP ${res.status})`);
  return `auth schema refused (HTTP ${res.status})`;
});

// ---------------------------------------------------------------------------
// The denial table, against the real database
// ---------------------------------------------------------------------------

check('denials', 'game_secrets is unreadable — the seed is the secret', async (ctx) => {
  const res = await ctx.host.supabase.from('game_secrets').select('*').limit(5);
  return expectNoRows(res, 'game_secrets');
});

check('denials', 'join_attempts is unreadable — the referee’s own bookkeeping', async (ctx) => {
  const res = await ctx.host.supabase.from('join_attempts').select('*').limit(5);
  return expectNoRows(res, 'join_attempts');
});

check('denials', 'a stranger cannot read a table they hold no seat at', async (ctx) => {
  const table = await openTable(ctx.host, ctx.cfg, { fog: false });
  const res = await ctx.stranger.supabase.from('games').select('*').eq('id', table.id);
  return expectNoRows(res, 'games');
});

check('denials', 'a stranger cannot read the seats of a table they are not at', async (ctx) => {
  const table = await openTable(ctx.host, ctx.cfg, { fog: false });
  const res = await ctx.stranger.supabase.from('seats').select('*').eq('game_id', table.id);
  return expectNoRows(res, 'seats');
});

check('denials', 'a fog game’s command log is unreadable, even to its own seats', async (ctx) => {
  const table = await openTable(ctx.host, ctx.cfg, { fog: true });
  const res = await ctx.host.supabase.from('commands').select('*').eq('game_id', table.id);
  return expectNoRows(res, 'commands');
});

check('denials', 'nobody may write the command log directly', async (ctx) => {
  const table = await openTable(ctx.host, ctx.cfg, { fog: false });
  const res = await ctx.host.supabase
    .from('commands')
    .insert({ game_id: table.id, idx: 1, cmd: { type: 'endPhase' }, die: 1 });
  expect(res.error !== null, 'a client INSERT into commands was ACCEPTED');
  return `refused (${res.error.code ?? 'error'})`;
});

check('denials', 'nobody may forge a seat', async (ctx) => {
  const table = await openTable(ctx.host, ctx.cfg, { fog: false });
  const res = await ctx.stranger.supabase
    .from('seats')
    .insert({ game_id: table.id, seat: 'p2', ordinal: 1, kind: 'human' });
  expect(res.error !== null, 'a client INSERT into seats was ACCEPTED');
  return `refused (${res.error.code ?? 'error'})`;
});

check('denials', 'a seat cannot read another seat’s fogged board', async (ctx) => {
  const table = await openTable(ctx.host, ctx.cfg, { fog: true });
  const res = await ctx.stranger.supabase.from('views').select('*').eq('game_id', table.id);
  return expectNoRows(res, 'views');
});

check('denials', 'a client-supplied seed is ignored for a fogged table', async (ctx) => {
  const mine = 123456789;
  const res = await callReferee(ctx.host, ctx.cfg, {
    action: 'create',
    v: V,
    scenarioId: 'escape',
    seed: mine,
    options: { fogOfWar: true },
  });
  expect(res.body?.ok === true, `create failed: ${res.body?.reason ?? ''}`);
  // The seed is not readable, which is the point — so the assertion is that
  // nothing anywhere hands it back.
  const secrets = await ctx.host.supabase
    .from('game_secrets')
    .select('*')
    .eq('game_id', res.body.table.id);
  expectNoRows(secrets, 'game_secrets after a seeded create');
  return 'seed accepted and withheld';
});

// ---------------------------------------------------------------------------
// Realtime — the claim the whole fog design rests on
// ---------------------------------------------------------------------------

check('realtime', 'a subscription delivers only rows the subscriber may select', async (ctx) => {
  const table = await openTable(ctx.host, ctx.cfg, { fog: true });
  const channel = ctx.stranger.supabase.channel(`probe:${table.id}`);
  const seen = [];

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the subscription never opened')), 15000);
    channel
      .on('postgres_changes', { event: '*', schema: 'public', table: 'views' }, (payload) =>
        seen.push(payload),
      )
      .on('postgres_changes', { event: '*', schema: 'public', table: 'commands' }, (payload) =>
        seen.push(payload),
      )
      .subscribe((status, err) => {
        if (status === 'SUBSCRIBED') {
          clearTimeout(timer);
          resolve();
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          clearTimeout(timer);
          reject(err ?? new Error(`subscription ${status}`));
        }
      });
  });

  // The host plays; the stranger is subscribed to the same tables and holds no
  // seat at this game. Nothing about this table may reach them.
  await callReferee(ctx.host, ctx.cfg, { action: 'start', v: V, gameId: table.id });
  await new Promise((r) => setTimeout(r, 4000));
  await ctx.stranger.supabase.removeChannel(channel);

  const leaked = seen.filter((p) => JSON.stringify(p).includes(table.id));
  expect(leaked.length === 0, `Realtime LEAKED ${leaked.length} row(s) to a non-seat`);
  return `${seen.length} unrelated event(s), 0 for this table`;
});

// ---------------------------------------------------------------------------
// The referee, playing a real game
// ---------------------------------------------------------------------------

check('referee', 'an open game syncs, accepts an order, and advances', async (ctx) => {
  const table = await openTable(ctx.host, ctx.cfg, { fog: false });
  const started = await callReferee(ctx.host, ctx.cfg, {
    action: 'start',
    v: V,
    gameId: table.id,
  });
  expect(started.body?.ok === true, `start refused: ${started.body?.reason ?? ''}`);

  const first = await callReferee(ctx.host, ctx.cfg, { action: 'sync', v: V, gameId: table.id });
  expect(first.body?.ok === true, `sync refused: ${first.body?.reason ?? ''}`);
  expect(first.body.initial !== undefined, 'an open game did not send its starting position');
  expect(first.body.initial.rng.seed === 0, 'the starting position arrived with an unsealed die');

  const seat = first.body.seat;
  const cmd = await callReferee(ctx.host, ctx.cfg, {
    action: 'command',
    v: V,
    gameId: table.id,
    cmd: { type: 'endPhase', by: seat },
  });
  expect(cmd.body?.ok === true, `the referee refused a legal order: ${cmd.body?.reason ?? ''}`);

  const after = await callReferee(ctx.host, ctx.cfg, {
    action: 'sync',
    v: V,
    gameId: table.id,
    since: 0,
  });
  expect(after.body?.ok === true, 'the second sync failed');
  expect(after.body.log?.length >= 1, 'the log did not grow');
  const entry = after.body.log[0];
  expect(typeof entry.die === 'number', 'the log entry carries no die');
  expect(entry.die !== 0, 'the referee rolled with a sealed generator');
  return `log idx ${entry.idx}, die ${entry.die}`;
});

check('referee', 'a fog game sends a snapshot and never the log', async (ctx) => {
  const table = await openTable(ctx.host, ctx.cfg, { fog: true, scenarioId: 'escape' });
  await callReferee(ctx.host, ctx.cfg, { action: 'start', v: V, gameId: table.id });
  const res = await callReferee(ctx.host, ctx.cfg, { action: 'sync', v: V, gameId: table.id });
  expect(res.body?.ok === true, `sync refused: ${res.body?.reason ?? ''}`);
  expect(res.body.snapshot !== undefined, 'a fog game sent no snapshot');
  expect(res.body.log === undefined, 'a fog game sent its command log');
  expect(res.body.initial === undefined, 'a fog game sent its starting position');
  expect(res.body.snapshot.rng.seed === 0, 'the snapshot arrived with an unsealed die');
  return 'snapshot only';
});

check('referee', 'a spectator cannot give an order', async (ctx) => {
  const table = await openTable(ctx.host, ctx.cfg, { fog: false });
  await callReferee(ctx.host, ctx.cfg, { action: 'start', v: V, gameId: table.id });
  const sync = await callReferee(ctx.host, ctx.cfg, { action: 'sync', v: V, gameId: table.id });
  const seat = sync.body.seat;
  const res = await callReferee(ctx.stranger, ctx.cfg, {
    action: 'command',
    v: V,
    gameId: table.id,
    cmd: { type: 'endPhase', by: seat },
  });
  expect(res.body?.ok !== true, 'a spectator ORDERED A SEAT');
  return `refused (${res.body?.reason ?? 'no reason'})`;
});

check('referee', 'a forged cmd.by is refused', async (ctx) => {
  const table = await openTable(ctx.host, ctx.cfg, { fog: false });
  await callReferee(ctx.host, ctx.cfg, { action: 'start', v: V, gameId: table.id });
  const res = await callReferee(ctx.host, ctx.cfg, {
    action: 'command',
    v: V,
    gameId: table.id,
    cmd: { type: 'endPhase', by: 'p2' },
  });
  expect(res.body?.ok !== true, 'the referee accepted an order signed by another seat');
  return `refused (${res.body?.reason ?? 'no reason'})`;
});

check('referee', 'an unknown join code is refused without saying why', async (ctx) => {
  const res = await callReferee(ctx.stranger, ctx.cfg, {
    action: 'join',
    v: V,
    code: 'ZZZZZZ',
  });
  expect(res.body?.ok !== true, 'a nonexistent table accepted a join');
  return `refused (${res.body?.reason ?? 'no reason'})`;
});

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const main = async () => {
  const cfg = await loadConfig();
  process.stdout.write(`probing ${cfg.url}\n\n`);

  const host = await player(cfg, 'host');
  const stranger = await player(cfg, 'stranger');
  const ctx = { cfg, host, stranger };

  let group = '';
  let failed = 0;
  for (const c of cases) {
    if (c.group !== group) {
      group = c.group;
      process.stdout.write(`  ${group}\n`);
    }
    try {
      const note = await c.fn(ctx);
      process.stdout.write(`    ok    ${c.name}${note ? `  — ${note}` : ''}\n`);
    } catch (err) {
      failed += 1;
      process.stdout.write(`    FAIL  ${c.name}\n          ${err.message}\n`);
    }
  }

  process.stdout.write(
    `\n${cases.length - failed}/${cases.length} passed against the live project\n`,
  );
  if (failed > 0) process.exitCode = 1;
};

await main();
