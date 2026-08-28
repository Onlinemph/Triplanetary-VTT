# Triplanetary VTT

A rules-accurate virtual tabletop for **Triplanetary**, the classic vector-movement
game of space combat in the inner Solar System.

Plot a course, watch gravity bend it, and find out three turns later whether you
left yourself enough fuel to stop. The engine is a faithful implementation of the
3rd edition rules (Steve Jackson Games, 2018): exact course tracing, derived
gravity arrows, the printed combat results tables, mines that detonate on any
part of a hex your course clips, and the counterattack that is rolled before your
damage is applied.

> **Unofficial fan project.** See [Attribution](#attribution) — you should own a
> copy of the game.

![The inner system chart during a game of Lateral 7: Sol and the inner worlds,
the asteroid belt with Ceres and Clandestine's dense cordon, the Jovian moons,
gravity arrows around every body, and the fleet and ship panels.](docs/screenshot.png)

---

## Quick start

```bash
npm install
npm run dev      # http://localhost:5173
```

Multiplayer, on one machine or over a network:

```bash
npm run server                     # authoritative server on :8787
PORT=9000 SCENARIO=lateral-7 npm run server
```

Clients connect to `ws://host:port/?room=<id>&clientId=<stable-id>`. The server
validates every command, assigns seats, and — in fog-of-war scenarios — sends
each player only the state they are entitled to see. See
[docs/MULTIPLAYER.md](docs/MULTIPLAYER.md).

### Publishing to GitHub Pages

Set **Settings → Pages → Build and deployment → Source** to **GitHub Actions**.
The `Deploy to GitHub Pages` workflow then builds and publishes on every push to
the default branch.

The Source setting is the one that catches people out. Left on _"Deploy from a
branch"_, Pages serves the repository as-is — which looks like it worked and did
not. The root `index.html` is Vite's development entry, and its only script tag
points at `/src/main.ts`; no browser can execute TypeScript, so the page loads,
`#root` stays empty, and you get a blank grey screen with nothing in the console
to explain it. Only the built `dist/` is servable, and only Actions produces it.

Then pick a scenario and press **New game**. Everything else:

```bash
npm test         # vitest, once
npm run test:watch
npm run typecheck
npm run build    # typecheck + production bundle into dist/
npm run preview  # serve the built bundle
npm run lint
npm run format
```

Node 20 or newer. No account, no server, no network required — the whole game
runs in the tab.

---

## How to play

If you have never played Triplanetary, the rule that matters is the first one:
**a ship keeps doing what it did last turn.** Your vector this turn is drawn from
where you were to where you are; next turn it carries you the same distance in
the same direction. One point of fuel shifts that endpoint by one hex — in any of
the six directions — and that is your entire steering system.

Everything else follows from it. Slowing down costs as much fuel as speeding up.
Gravity adds a free hex of acceleration towards each body whose gravity hex you
passed through _last_ turn, which is how you get an orbit for nothing and a crash
for free if you are not paying attention.

A player-turn runs through five phases; the shell walks you through them:

| Phase           | What you do                                                                                                                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Astrogation** | Look at each ship's predicted endpoint and spend fuel to move it. Click a highlighted hex to plot; the ghost shows the resulting course, the hexes it enters, and any crash or map-exit warning. |
| **Ordnance**    | Launch one mine, torpedo or nuke per ship. Mines inherit your vector — you must then steer out of their hex.                                                                                     |
| **Movement**    | Everything moves at once. Asteroid hazards and rams resolve here.                                                                                                                                |
| **Combat**      | Fire guns. Pick attackers and targets; the panel shows the odds column, the range and velocity modifiers, and what each result would do. The defender may return fire before damage lands.       |
| **Resupply**    | At a base: refuel, repair everything, reload the hold, and get your overload manoeuvre back. A ship that resupplies may not shoot that turn.                                                     |

Useful things to know early:

- **Range is measured from your closest approach**, not from where you ended up.
  A fast pass at range 1 is a real attack; parking next to someone is not
  necessary.
- **Relative velocity hurts**: −1 to the die for every hex of velocity difference
  beyond 2. Matching courses is how you loot, rescue, capture and transfer.
- **Landing** costs one fuel from orbit, and you take off from the hexside you
  landed on. Asteroids are simpler: stop in the hex.
- **Overload** (two fuel, two hexes) is a warship privilege, once per maintenance
  stopover. Commercial ships never get it.

The in-game **Help** panel carries the phase reference and the scenario briefing;
`docs/RULES-MAPPING.md` says where each printed rule is implemented if you want
to check the fine print.

### Playing on your own

On the scenario screen, every seat can be set to **You** or **Computer** —
_Play solo_ takes the first seat and hands the rest to the machine. The computer
plays through the ordinary command layer, so its orders are logged, judged and
undone exactly like yours; it is refused on the same terms, and with fog of war
on it never sees more of the map than that seat would. It is not a strong
player — it does not model your replies — but it flies the fastest route to
wherever it is going, closes on things it can actually catch, takes the fights
worth taking and goes home to refuel before it runs dry.

Routing is a search rather than a rule of thumb, because vector movement
punishes short-term thinking: the quick way to Venus is to spend three turns
building speed you will spend three more turns shedding. It plans over
(position, velocity) with gravity and fuel priced in, so it will settle into
orbit around Mars in six turns where steering one hex at a time never manages it
at all. And it plays each scenario on that scenario's terms:
it races you to Venus in Bi-Planetary rather than shooting at you, and it does
not open fire at all in the Grand Tour, where "combat is not allowed".

**Flight School** is the other solo option, and the one to start with: one ship,
nobody shooting, and six exercises in vector movement graded against par.

### Playing with other people, over the internet

Sit at a table, share a six-character code, and play from anywhere. There are
two arrangements, and the game offers both on the same screen.

### The quick table — one SQL file, nothing deployed

Paste [`supabase/quick/schema.sql`](supabase/quick/schema.sql) into your
project's SQL Editor, press Run, and copy two values. That is the setup: no
command line, no account, no server.

Postgres orders the moves, rolls the dice and relays them; every browser runs
the rules over the same list and lands on the same board. Share a code and a
password and play. **[Full instructions](supabase/quick/README.md)**.

What it trades: the rules are enforced by each browser, so somebody who edits
their own copy could propose a move the rules forbid — the others notice, and
say so, but noticing is not preventing. And the two hidden-information
scenarios, Escape and Lateral 7, are refused outright, because the move list
rebuilds the board that the fog exists to hide.

### The refereed table — a judge on the server

Every order is checked against the rules before it is accepted, each side gets
only the board it is entitled to, and the fogged scenarios work. It costs a
deployment.

**From a terminal**, if you have the repository checked out:

```bash
npx supabase login
npx supabase link --project-ref <your-project-ref>
npx supabase db push          # the schema, its policies, and the referee's SQL
npx supabase config push      # turns on anonymous sign-in — see below
npm run functions:deploy      # bundles the engine and ships the Edge Function
cp .env.example .env.local    # then fill in the URL and anon key
npm run dev
```

`config push` is the step people miss. Anonymous sign-in is what lets a player
join without an account, and `supabase/config.toml` only governs the _local_
stack until you push it; without this the online buttons appear and every join
fails on authentication.

**From GitHub, with no terminal at all**, which is how the hosted copy is
deployed. Add five repository secrets under **Settings → Secrets and variables →
Actions**:

| secret                   | where it comes from                             |
| ------------------------ | ----------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN`  | supabase.com/dashboard/account/tokens           |
| `SUPABASE_PROJECT_REF`   | the id in your dashboard URL                    |
| `SUPABASE_DB_PASSWORD`   | set when the project was created                |
| `VITE_SUPABASE_URL`      | Project Settings → API                          |
| `VITE_SUPABASE_ANON_KEY` | Project Settings → API, the **anon public** key |

Then, in the **Actions** tab, run **Deploy to Supabase** — it pushes the
migrations and ships the Edge Function. Turn on anonymous sign-in in the
dashboard under **Authentication → Sign In / Providers**, which is a project
setting rather than a deployment and so is not automated. Finally re-run
**Deploy to GitHub Pages**, because Vite bakes the two `VITE_` values into the
page at build time and the published site needs a build that has them.

The anon key is safe in all of this: it ships inside the page every player
downloads and grants nothing on its own. It lives in a secret because which
project the site talks to is the owner's business, not because the string needs
hiding. The **service role** key is the one that must never leave the Edge
Function, and nothing above ever asks for it.

Then press **Play online** on the scenario screen, or paste a code into **Join a
table**. A link of the form `?join=ABC234` drops a friend straight into the
lobby.

With no `.env.local` the online buttons are disabled with a one-line
explanation, and everything else — hot seat, solo against the computer, save and
load — works exactly as before. Supabase is an option, not a dependency.

That holds in bytes, not just in wording. With no keys configured the client is
unreachable code and the bundler drops it; with keys configured it is a separate
chunk, fetched the first time somebody opens or joins a table. So the download
for a player who never plays online is the same either way, and 58 kB smaller
than a build that linked the library in.

**What the server is for.** The Edge Function is the only participant that may
write the command log, read the scenario seed, or see the whole board. Every
order goes through it and through the same `applyCommand` your browser runs, so
a modified client cannot make an illegal move legal, act for somebody else's
seat, or read a fogged board. See [docs/MULTIPLAYER.md](docs/MULTIPLAYER.md) for
the threat model and what each table hides.

### Playing with other people, on one machine

Hot seat works out of the box: pass the keyboard. Two further modes are wired
into the session layer — several tabs of one browser over `BroadcastChannel`, and
a WebSocket relay for play across machines. See
[docs/MULTIPLAYER.md](docs/MULTIPLAYER.md), which includes a sixty-line reference
relay server.

### Two games, one war

This app is linked to its companion,
[OGRE-VTT](https://github.com/onlinemph/OGRE-VTT), by a campaign over the inner
Solar System: Triplanetary decides who gets to the ground, and Ogre decides what
happens when they land. The campaign itself lives in the Ogre app; what arrives
here is a **Contested Transfer** — a convoy with an invasion in its holds,
opened by a `?battle=` link or a pasted order token, fought like any other game
(hot seat or against the computer), and answered with a result token the
victory screen offers to copy. The scenario is also on the ordinary scenario
list. See [docs/CAMPAIGN.md](docs/CAMPAIGN.md) for this app's half of the
hand-off, and the Ogre repository for the campaign design itself.

---

## Design principles

**The engine is a pure function.** `applyCommand(state, command, map)` returns a
new state. No DOM, no clock, no `Math.random` — every die comes from a seeded
generator carried inside the game state. That single constraint buys undo,
save/load, replay, deterministic tests, and networked play with no extra
machinery: a game _is_ its scenario seed plus an ordered list of commands.

**The rulebook is the specification.** Where a rule is subtle, the phrase is
quoted in a comment beside the code that implements it. Where the rules are
ambiguous, the interpretation is written down rather than silently chosen, and
`docs/RULES-MAPPING.md` marks what is implemented, what is simplified, and what is
missing.

**Derive, don't transcribe.** The gravity arrows are not a table someone typed in;
`src/engine/map.ts` proves that an orbit forces every arrow to point at its body
and generates them. Takeoff, orbital sense and the fall back onto a planet then
fall out of the arithmetic instead of being special cases.

**Geometry is exact.** Courses are straight lines, not hex paths. The tracer knows
the difference between a hex a course _enters_ and one it merely _touches_ — that
distinction is the mine rule, the asteroid rule and the gravity rule.

**The interface decides nothing.** Every legality question is asked of the engine;
every change leaves as a command. The shell is replaceable and the game is not.

---

## Project layout

```
src/
  engine/      the rules — pure, no I/O, no DOM
    hex.ts geometry.ts mapdata.ts map.ts    coordinates, tracing, the chart
    types.ts commands.ts state.ts rng.ts    the state contract and its helpers
    crt.ts ships.ts                         printed tables
    movement.ts combat.ts ordnance.ts       the phase rules
    detection.ts logistics.ts reducer.ts
  scenarios/   the rulebook's scenarios, as pure builders + victory checks
  campaign/    the hand-off with OGRE-VTT: boundary types, token codec, result reader
  ai/          the computer opponent: a state in, one command out
  net/         GameSession (command log, undo, save) and the transports
    supabase/  the online referee's contract, rules loop and browser client
  render/      canvas chart: bodies, counters, courses. Generated, not drawn.
  ui/          panels, input, and the one-way command loop
  main.ts      the only file that wires the concrete pieces together
supabase/      migrations (schema + row level security) and the Edge Function
docs/          ARCHITECTURE.md, MULTIPLAYER.md, RULES-MAPPING.md, CAMPAIGN.md
tests/         rules tests, run by vitest
```

Start with [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) if you intend to change
anything.

---

## Testing

```bash
npm test
```

Three kinds of test carry the weight: the hex and geometry primitives (checked
against the rulebook's own worked figures), the combat tables, and scenario-level
rule tests that build a game with a fixed seed, dispatch a list of commands, and
assert on the result. Because the engine is pure, every one of them is hermetic
and reproducible — a failing test can be replayed exactly.

The wire layer has its own tests (`src/net/transport.test.ts`) driving fake
sockets and channels, so reconnection and queueing are covered without a browser.

The online half is tested without a Supabase project anywhere in sight.
`tests/supabase-referee.test.ts` drives the rules loop directly — the same trick
`server/room.ts` uses — and `tests/supabase-schema.test.ts` boots real
PostgreSQL in WebAssembly, runs the migration files off disk, and then _attacks_
them: read the seed, read another seat's fogged board, read a fog game's log,
rewrite history as the referee. Each denial is its own case, named for the
attack it makes.

The computer opponent is tested the way you would audit a player rather than a
function (`tests/ai.test.ts`): it plays every printed scenario on two seeds and
fails on the first order the engine refuses, on the first position it gets stuck
in, and on the first course it plots that crashes or leaves the chart. The rest
check that it is deterministic — the same position always yields the same order,
and a whole game replays identically from its seed — and that with fog of war on
it never names a ship it has not detected.

---

## Contributing

Bug reports about **rules accuracy** are the most valuable kind: cite the page and
the phrase, and say what the implementation does instead. If you are adding a
rule, quote the rulebook in a comment at the implementation site and add the row
to `docs/RULES-MAPPING.md`.

CI runs typecheck, tests and a build on Node 20 and 22.

---

## Attribution

**Triplanetary** is a trademark of Steve Jackson Games Incorporated. Triplanetary
is copyright © 1973, 1981 by Marc Miller and copyright © 2018 by Steve Jackson
Games Incorporated. This project is an **unofficial, fan-made** virtual tabletop.
It is not affiliated with, endorsed by, or sponsored by Steve Jackson Games.

This repository ships **no copyrighted artwork, map images, counters or rules
text**. The chart is an original reconstruction generated from coordinates and
radii in `src/engine/mapdata.ts`; the counters are drawn at runtime from ship
statistics. The rulebook itself is not included and not reproduced here — only
short phrases quoted in source comments where they explain a decision, as
technical citation.

**You should own a copy of the game.** The rules, the physical map and the
counters are worth having, the game is in print, and this tabletop is a companion
to it rather than a replacement:

- <https://triplanetary.sjgames.com>
- <https://triplanetary.sjgames.com/howtoplay/> — the publisher's video guide

If you represent Steve Jackson Games and would like something here changed or
removed, please open an issue.

---

## Licence

The code in this repository is offered under the MIT licence — add a `LICENSE`
file with the MIT text before publishing, so the grant is formal rather than a
sentence in a README. Whatever licence the code carries covers **the source
only**: it grants no rights in the _Triplanetary_ game, its rules, its trademarks
or its artwork, which remain the property of Steve Jackson Games Incorporated.
