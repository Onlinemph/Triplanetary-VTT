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

| Counter                | Value            | Code now    | Where it lives           |
| ---------------------- | ---------------- | ----------- | ------------------------ |
| **Truck** (TK)         | Movement         | 4           | Counter; wheeled, 5.08.5 |
| **Hovertruck** (HT)    | Movement         | 4 + 3       | Counter; GEV rules, 3.03 |
|                        | Defence          | 0           | Counter                  |
| **Laser** (LSR)        | Structure Points | D2 stand-in | Counter / scenario       |
|                        | Victory points   | 12          | Scenario                 |
| **Laser Tower** (LTWR) | Structure Points | D4 stand-in | Counter / scenario       |
|                        | Victory points   | 18          | Scenario                 |
| **Train**              | Size             | 5           | Scenario                 |
|                        | Victory points   | 12          | Scenario                 |
| **Command Post** (CP)  | Size             | 1           | Not in the Size Table    |

Everything else on the counters is now settled. The Armor Units summary gave
the Mobile Howitzer D2 and the Missile Crawler D2/M1; 1.08 gave the victory
values (2 a squad, 3 a half-value armour unit, 6 a standard one or a Crawler,
12 a double-value one or a Cruise Missile); 15.03.6 and 3.02.2 gave the Truck
1 VP and the Hovertruck 2, for "unit selection and victory calculation" alike.

---

## 2. Rules the engine simplifies

### Lasers are buildings (§12)

**Printed:** "Defensively, they are buildings with Structure Points."
A Laser is damaged at 10 SP and destroyed at 0; a damaged one cannot fire.
It may attack a unit only if it did not fire at all during the preceding enemy
turn.

**Here:** a Laser is an immobile unit with a defence strength standing in for
its Structure Points. Its attack (2), its ranges (30 and 60) and its double
strength when overrun are now the printed ones, and so is the line of sight.
What is missing is SP damage, the damaged state, and the fire restriction.

**To close it:** the engine already has buildings with Structure Points for
§11. Moving the two Laser classes onto that machinery is mostly deletion.

### The train is one counter, and should be two (§9)

**Printed:** a train is two counters and two hexes long, with a separate speed
marker. The markers are **ranges** — M0/1, M2/3, M4/5, M6/7 — so a train moves
one of two distances each turn and tops out at 7, not 4. Speed changes by one
marker at the **end** of each turn. Destroying the rear counter leaves the
front running; destroying the front of a moving train destroys the whole
thing. A train that enters a hex where the rails are cut is destroyed. Its
defence is doubled in a town. It does not count against stacking. Each half
carries 12 "size points" of cargo, and only units of Size 3 or below.

**Here:** one counter, a single-number speed marker capped at 4, changed at
the start of movement, and a squad-count capacity. Its defence of 3 and its
X-only damage rule are right.

**To close it:** the front/rear pair is the real work; the speed markers, the
top speed, the cut-rail destruction and the town doubling are each small.

### The drone does not deploy (§14.01)

**Printed:** a LAD travels collapsed as a cargo pallet. Turn 1 the transport
stands still and the pallet is unloaded; turn 2 it unpacks and may be shot at
but may not fire; turn 3 it can fire. A pallet is a D0 target destroyed by any
attack, can be hidden in a defensive setup, and is not overrun. Repacking
takes engineers three turns plus one to load, or a Vulcan one turn. A LAD that
is set up may not be moved.

**Here:** the LAD mounts and dismounts like a squad of infantry, and is
"setting up" — unable to fire — for the rest of the turn it dismounts.

### What the Vulcan still cannot do (§15)

Section 15 is nearly complete: the dice pools, the fire-phase timing, one
attempt per task per turn, and fourteen tasks — entrenchments and revetments,
planting, sweeping and disarming mines, mending roads and rail, grading
ridges, finishing off a cybertank, and the Vulcan's work on stuck units, roads
through wreckage, and an Ogre's weapons and treads.

What is not:

- **Reloading missiles** (15.04.4), which needs the Vulcan's cargo hold.
- **Towing** (15.04.8): hitch on a 2+, one vehicle at a time, with the
  Vulcan's move dropping by the towed vehicle's size.
- **Everything about Drones as Drones** (15.02.1, 15.02.4, 15.02.5): the
  Vulcan's cargo capacity, combat Drones, and the sixteen "ducklings" it can
  drive at half strength. A Heavy Drone is a counter here, and a useful one,
  but nothing connects it to a Vulcan's four control channels.
- **Assembly times** (15.02.2): 12 turns for a Mark II up to 75 for a Ninja.
  The unfinished-Ogre rule that governs the result is already in.

Two smaller simplifications inside what is there. A mine sweep searches one
hex at a time, so it always needs a 2 or better; the rules let a squad sweep
several at once for a worse roll. And 15.04.7 prints no die roll for digging a
revetment, so the section's general 6 stands in.

### Smaller known gaps

- **13.02.1 River bridges.** A bridge crossing a whole hex has defence 8, lies
  in three hexes, and drowns anything on its centre hex when it goes; an Ogre
  falls in and takes four dice of tread damage. Only stream bridges are in.
- **13.04 Road mines.** A mine records whether it is on the road, and the
  engine keeps that flag, but every mine laid in a road hex is treated as a
  road mine. The rules let the layer choose.
- **9.03.1 Armed trains**, **9.06 collisions**, **9.07 reinforcements from the
  train**: none are in.
- **12.05** A Laser can try to intercept an Ogre missile on a 10+.

---

## Where the numbers live

| Where                            | What                                           |
| -------------------------------- | ---------------------------------------------- |
| `src/ogre/engine/units.ts`       | Every counter face, and its `unconfirmed` flag |
| `src/ogre/engine/missiles.ts`    | `CRUISE_MISSILE` — §10                         |
| `src/ogre/engine/concealment.ts` | `MINEFIELD` — 13.04                            |
| `src/ogre/engine/engineering.ts` | `SUPERHEAVY_SHEET`, `SUPERHEAVY_GUN`, `BRIDGE` |
| `src/ogre/scenarios/custom.ts`   | `HIDDEN_LIMITS` — the builder's caps           |
