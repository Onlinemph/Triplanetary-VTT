# What is still not the printed rule

Checked against **Ogre Sixth Edition, Revised: Battlefields**, rules version 6.3
(August 2019). Everything the rulebook settles has been corrected in the
engine and cited at the implementation site; this file is what is left.

Two kinds of thing are listed:

1. **Numbers the rules text does not print.** They are on the counters or the
   record sheets, so they still need somebody with the components.
2. **Rules the engine models differently.** Each of these is a known,
   deliberate simplification, not an oversight, and each says what the printed
   rule is and what it would take to close the gap.

The companion file is `docs/OGRE-RULES-MAPPING.md`, which says where each rule
is implemented.

---

## 1. Numbers still to read off a counter

| Counter                | Value            | Code now | Where it lives           |
| ---------------------- | ---------------- | -------- | ------------------------ |
| **Truck** (TK)         | Movement         | 4        | Counter; wheeled, 5.08.5 |
| **Hovertruck** (HT)    | Movement         | 4 + 3    | Counter; GEV rules, 3.03 |
|                        | Defence          | 0        | Counter                  |
| **Laser** (LSR)        | Structure Points | 20       | Counter / scenario       |
|                        | Victory points   | 12       | Scenario                 |
| **Laser Tower** (LTWR) | Structure Points | 20       | Counter / scenario       |
|                        | Victory points   | 18       | Scenario                 |
| **Train**              | Size             | 5        | Scenario                 |
|                        | Victory points   | 12       | Scenario                 |
| **Command Post** (CP)  | Size             | 1        | Not in the Size Table    |

Everything else on the counters is now settled. The Armor Units summary gave
the Mobile Howitzer D2 and the Missile Crawler D2/M1; 1.08 gave the victory
values (2 a squad, 3 a half-value armour unit, 6 a standard one or a Crawler,
12 a double-value one or a Cruise Missile); 15.03.6 and 3.02.2 gave the Truck
1 VP and the Hovertruck 2, for "unit selection and victory calculation" alike.

---

## 2. Rules the engine simplifies

### The train is one counter, and should be two (§9)

**Printed:** a train is two counters and two hexes long. Destroying the rear
counter leaves the front running; destroying the front of a moving train
destroys the whole thing. Each half carries 12 "size points" of cargo, and
only units of Size 3 or below. It always goes forward unless it is on the
M0/1 marker, which is also the only marker it may reverse on.

**Here:** one counter, and cargo counted in squads. Everything else about the
train is now the printed rule: the M0/1 to M6/7 markers with their two
distances, the marker changing at the end of the turn, destruction on cut
track, the collision rules of 9.06, doubled defence in a town, and freedom
from stacking limits.

**Also not in:** armed trains (9.03.1), and reinforcements carried aboard
(9.07).

### What §15 still leaves to a referee

Section 15 is now complete but for two things the rules hand to a referee
rather than settle.

**Assembly on the table.** 15.02.2's times are in the engine as
`vulcan.ASSEMBLY_TURNS` and `assemblyTurns`, shortened by the arms that help,
and the unfinished-Ogre rule that governs the result is in. What is not is a
turn-by-turn assembly job: 30 turns to build a Mark III is longer than any
scenario in the book, and the rules say as much — "Ogres larger than a Mark
III-B are not normally built under combat conditions". A scenario that wants
one sets `activatesOn` off the table. (Orbital Drop uses its own compressed
delay, `assemblyDelay`, which is that campaign's rule and not 15.02.2's.)

**Bulk cargo.** 15.02.2 gives six turns "to unload all palleted cargo from
either the top or interior, or to load new cargo that is palletized and ready
to go", and six "to secure a damaged armor unit in the field and winch it onto
the top cargo area". The engine offers the one-turn single-item job (15.02.2's
third line) and leaves the two six-turn ones to a referee, since neither has a
die roll and both are a scenario's bookkeeping rather than a battle action.
`VULCAN_JOBS` holds the numbers.

Two smaller simplifications inside what is there. A mine sweep searches one
hex at a time, so it always needs a 2 or better; the rules let a squad sweep
several at once for a worse roll. And 15.04.7 prints no die roll for digging a
revetment, so the section's general 6 stands in.

### Smaller known gaps

---

## Where the numbers live

| Where                            | What                                           |
| -------------------------------- | ---------------------------------------------- |
| `src/ogre/engine/units.ts`       | Every counter face, and its `unconfirmed` flag |
| `src/ogre/engine/missiles.ts`    | `CRUISE_MISSILE` — §10                         |
| `src/ogre/engine/concealment.ts` | `MINEFIELD` — 13.04                            |
| `src/ogre/engine/engineering.ts` | `SUPERHEAVY_SHEET`, `SUPERHEAVY_GUN`, `BRIDGE` |
| `src/ogre/scenarios/custom.ts`   | `HIDDEN_LIMITS` — the builder's caps           |
