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

### Playing with other people

Hot seat works out of the box: pass the keyboard. Two further modes are wired
into the session layer — several tabs of one browser over `BroadcastChannel`, and
a WebSocket relay for play across machines. See
[docs/MULTIPLAYER.md](docs/MULTIPLAYER.md), which includes a sixty-line reference
relay server.

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
  net/         GameSession (command log, undo, save) and the transports
  render/      canvas chart: bodies, counters, courses. Generated, not drawn.
  ui/          panels, input, and the one-way command loop
  main.ts      the only file that wires the concrete pieces together
docs/          ARCHITECTURE.md, MULTIPLAYER.md, RULES-MAPPING.md
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
