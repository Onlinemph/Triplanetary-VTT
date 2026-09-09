# What is still not the printed rule

Checked against **Ogre Sixth Edition, Revised: Battlefields**, rules version 6.3
(August 2019). Everything the rulebook settles is now implemented and quoted at
the implementation site. This file is what is left, and it is short.

The companion file is `docs/OGRE-RULES-MAPPING.md`, which says where each rule
is implemented.

---

## 1. Numbers still to read off a counter

These are not in the rules text at all — they are printed on the counters, or
left to a scenario — so they need somebody with the components to settle. Each
is flagged `unconfirmed` at its definition.

| Counter                 | Value            | Code now | Where it lives           |
| ----------------------- | ---------------- | -------- | ------------------------ |
| **Truck** (TK)          | Movement         | 4        | Counter; wheeled, 5.08.5 |
| **Hovertruck** (HT)     | Movement         | 4 + 3    | Counter; GEV rules, 3.03 |
|                         | Defence          | 0        | Counter                  |
| **Laser** (LSR)         | Structure Points | 20       | Counter / scenario       |
|                         | Victory points   | 12       | Scenario                 |
| **Laser Tower** (LTWR)  | Structure Points | 20       | Counter / scenario       |
|                         | Victory points   | 18       | Scenario                 |
| **Train** (per counter) | Size             | 5        | Scenario                 |
|                         | Victory points   | 12       | Scenario                 |
| **Command Post** (CP)   | Size             | 1        | Not in the Size Table    |

Everything else on the counters is settled. The Armor Units summary gave the
Mobile Howitzer D2 and the Missile Crawler D2/M1; 1.08 gave the victory values
(2 a squad, 3 a half-value armour unit, 6 a standard one or a Crawler, 12 a
double-value one or a Cruise Missile); 15.03.6 and 3.02.2 gave the Truck 1 VP
and the Hovertruck 2, for "unit selection and victory calculation" alike.

---

## 2. Rules the engine models differently

Three, and each says why.

### A cruise missile's route (10.02)

**Printed:** "The missile starts at its crawler and immediately moves one hex at
a time, by any route indicated by its owner, until it is intercepted, or its
owner states that it has reached its target and is exploding."

**Here:** a straight line from the crawler to the target hex. Everything else
about the flight is the printed rule — the 2d6 interception table with its
tracking bonuses, one shot a gun, premature detonation on a 6, and the blast
table of 10.04.

**Where it shows:** exactly one place. 10.02.1 says nothing may fly within six
hexes of this turn's crater, and a dogleg would sometimes get round one where a
straight line cannot. `launchCheck` refuses such a launch and says so, rather
than quietly flying the missile through the fallout.

**To close it:** the launch order would carry a route rather than a target hex,
and the interface would need a way to draw one.

### The two six-turn cargo jobs (15.02.2)

**Printed:** six turns "to secure a damaged armor unit in the field and winch it
onto the top cargo area", and six "to unload all palleted cargo from either the
top or interior, or to load new cargo that is palletized and ready to go".

**Here:** the one-turn single-item job from the same list is a Vulcan task, and
these two are not. Neither has a die roll, and both are longer than most
scenarios; the rules themselves treat this stretch of 15.02.2 as a referee's
table — "referees should extrapolate from this to set logical times for anything
that a Vulcan could reasonably do". `vulcan.VULCAN_JOBS` holds the numbers for a
scenario that wants them.

### Assembling a cybertank on the table (15.02.2)

**Printed:** twelve turns for a Mark II, up to seventy-five for a Ninja,
shortened by a third for one helping arm and halved for two.

**Here:** the table is in — `vulcan.ASSEMBLY_TURNS` and `assemblyTurns` — and so
is the rule that governs the result: "If fire is directed at an unfinished Ogre,
treat all D results as X. An unfinished Ogre cannot shoot back." What is not is
a turn-by-turn build order, because thirty turns to raise a Mark III is longer
than any scenario in the book and the rules say as much: "Ogres larger than a
Mark III-B are not normally built under combat conditions." A scenario that
wants one sets `activatesOn` off the table.

Orbital Drop uses its own compressed delay (`assault.assemblyDelay`, Size − 4
turns, minimum 2). That is that campaign's rule, not 15.02.2's.

---

## 3. Two smaller readings

Not gaps so much as places the rules leave room and the engine picked one.

- **Mine sweeping** (15.03.3). "They need to roll on one die a number greater
  than the number of hexes they are searching." A sweep here searches one hex,
  so it always needs a 2 or better; the rules let a squad search several at once
  for a worse roll.
- **Digging a revetment** (15.04.7) prints no die roll of its own, so the
  section's general "if a 6 is rolled on any die, the task is successfully
  completed" stands in.

---

## Where the numbers live

| Where                            | What                                            |
| -------------------------------- | ----------------------------------------------- |
| `src/ogre/engine/units.ts`       | Every counter face, and its `unconfirmed` flag  |
| `src/ogre/engine/missiles.ts`    | `CRUISE_MISSILE` — §10                          |
| `src/ogre/engine/concealment.ts` | `MINEFIELD` — 13.04                             |
| `src/ogre/engine/engineering.ts` | `SUPERHEAVY_SHEET`, `SUPERHEAVY_GUN`, `BRIDGE`  |
| `src/ogre/engine/drone.ts`       | `REPACK_TURNS` — 14.01                          |
| `src/ogre/engine/train.ts`       | `TRAIN_GUN`, `TRAIN_CARGO_PER_HALF` — §9        |
| `src/ogre/engine/vulcan.ts`      | `VULCAN_CARGO`, `ASSEMBLY_TURNS`, `VULCAN_JOBS` |
| `src/ogre/scenarios/custom.ts`   | `HIDDEN_LIMITS` — the builder's caps            |
