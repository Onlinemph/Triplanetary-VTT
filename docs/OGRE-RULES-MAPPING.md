# Ogre: rules mapping

This is the audit of **_Ogre_, Sixth Edition, Revised** (rules version 6.3,
August 2019) against the Ogre game in this repository — everything under
`src/ogre/`. For the _Triplanetary_ side of the app, see the separate
[`docs/RULES-MAPPING.md`](RULES-MAPPING.md), which audits _Triplanetary_ 3rd
edition against `src/engine/`. Two games, two rulebooks, two documents; this
one is Ogre's.

Where each printed rule is implemented, what is simplified, and what is not in
yet. Section numbers throughout are from the Ogre rulebook.

The short version: **Sections 1–8 are implemented in full**, ramming and
overrun combat both. Sections 9–15 — the train, Cruise Missiles, buildings
beyond simple structure points, lasers, most optional rules, and combat
engineering — are not, and are listed at the bottom.

Every path and symbol cited below was re-checked against this tree when the
document moved here from the standalone Ogre repository, and the claims about
what is and is not implemented were checked against `src/ogre/engine/` at the
same time.

---

## Sources, and what is still unconfirmed

Four documents settle almost everything:

| Source                                                        | Settles                                                                                                                                 |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **Ogre, Sixth Edition, Revised** (rules v6.3, Aug 2019)       | Every rule cited on this page.                                                                                                          |
| **Player Reference Sheet** (SJG)                              | The Combat Results Table, the Turn Sequence, the Size Table and the Terrain Effects Table — all four transcribed and asserted in tests. |
| **Ogre Record Sheets** (SJG, sheet dated 10/15/12)            | Every Ogre: guns, tread count, Size, armour-unit cost, movement track.                                                                  |
| Ogre Miniatures conversion chart (third-party, 2" to the hex) | The armour units' attack, range, defence and movement.                                                                                  |

The first three are official. The fourth is not, but every value it gives
agrees with every worked example in the rulebook — the 7.13.1 odds, the 7.12
spillover example, the 5.11.2 Superheavy example, the Example of Play — which
is the check that makes it usable. Where the rulebook and the chart could
disagree, they do not.

**Still unconfirmed**, because nothing above covers them:

| Unit                     | Value             | Used here | Matters?                                                                                                                  |
| ------------------------ | ----------------- | --------- | ------------------------------------------------------------------------------------------------------------------------- |
| Truck                    | movement          | 4         | Barely — it is a target, and 5.08.5 fixes its terrain costs regardless.                                                   |
| Hovertruck               | movement, defence | 4-3, 0    | Barely. D0 is stated for the Truck (3.03) and assumed to carry over.                                                      |
| Missile Crawler, Crawler | defence, movement | 2, 2      | Some. A Missile Crawler is selectable in a custom battle and cruise missiles fly, so it has to survive to its launch hex. |
| Light Artillery Drone    | victory points    | 6         | Low. Its four combat statistics are stated verbatim in 14.01.                                                             |
| Command Post             | Size              | 1         | Low. It appears in no Size Table row; Size only matters for ramming, and 6.03 handles a rammed CP by its defence instead. |

Everything else is settled, and `tests/ogre/stats.test.ts` asserts it —
including the whole Ogre roster card by card, so a typo in
`src/ogre/engine/ogres.ts` fails the build.

### One derivation worth knowing about

The record sheets print the tread track as boxes rather than as a rule, so the
engine derives it: each movement point is worth an equal share of the tread
total. That reproduces the one case the rulebook pins with a worked example (a
Mark V at 41 treads moves 3, at 40 it moves 2 — 6.04), and the evidence that it
generalises is arithmetic: **every Ogre's tread count divides exactly by its
starting movement.** 18/3, 30/3, 45/3, 48/3, 56/4, 60/3, 72/3, 40/4, 48/4 —
twelve for twelve. A test asserts the invariant.

### Two places the reference sheet and the rulebook differ

Both are harmless, and the rulebook is followed in each case.

- **Terrain-disablement recovery.** The rulebook (4.02.1b) says a unit stays
  down on a 1 or 2 and recovers on a 3 to 6. The reference sheet says it
  recovers on a 1 to 4. Identical odds — two thirds — so nothing about play
  changes.
- **Railroads for non-GEVs.** The reference sheet says "no effect" for light
  tracked, heavy tracked and wheeled units. The rulebook is more specific:
  "Other units that enter and exit the hex on the rail may ignore terrain
  movement penalties" (5.07.3), while only GEVs and infantry get the road
  bonus. The engine implements the rulebook's version.

---

### Interpretations this implementation makes

Two places the printed text leaves a game that cannot end, and the engine
ends it:

- **An immobilised Ogre in the Attack scenarios.** With every tread gone the
  Ogre is going nowhere. If the command post is already destroyed it cannot
  make the south edge, which is the printed marginal result; if the post
  still stands and no gun aboard can reach it, the defence has stopped it
  short and takes the standard victory. The printed conditions assume the
  game is played out, and two immobile pieces out of each other's range
  would play out forever (`src/ogre/scenarios/ogreAttack.ts`).
- **Orbital fire and the base.** In the Orbital Drop assaults the fleet may
  not target the base — a post or the Admin building — which only the
  landed force may take (`combat.previewOrbitalStrike`). Read literally,
  "any target" ended an asteroid assault on turn 1 with one shot at a D0
  post.

---

## Implemented

### 1 – Introduction and starting scenarios

| Rule                                                                   | Where                                                                                            |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 1.02 Objectives, 1.04 play balance                                     | `src/ogre/scenarios/ogreAttack.ts`                                                               |
| 1.07 Unit costs (half, double, triple)                                 | `UnitClass.armorUnits` in `src/ogre/engine/units.ts`; asserted in `tests/ogre/scenarios.test.ts` |
| 1.08 Victory points for losses                                         | `state.victoryValue`, awarded in `destroyUnit`                                                   |
| 1.09, 1.09.1 VP for Ogres and Ogre damage                              | `src/ogre/engine/ogres.ts` (`vp`, `OgreWeaponSpec.vp`), `state.ogreDamageValue`                  |
| Mark III Attack, Mark V Attack, and all six victory conditions of each | `src/ogre/scenarios/ogreAttack.ts`                                                               |

### 2 – Maps

| Rule                                                      | Where                                           |
| --------------------------------------------------------- | ----------------------------------------------- |
| 2.01 Terrain types                                        | `src/ogre/engine/terrain.ts`                    |
| 2.01.2 Craters impassable to everything, fire passes over | `terrain.entryCost`                             |
| 2.01.7/8 Damaged town and forest, rubble                  | `terrain.baseTerrain`, `terrain.degradeTerrain` |
| 2.02.1 Ridges: only Ogres, Superheavies and infantry      | `terrain.sideCrossing`                          |
| 2.02.2 Streams                                            | `terrain.sideCrossing`                          |
| 2.03 Roads and railroads as links across hexsides         | `src/ogre/engine/map.ts`                        |
| Hex numbering (`1401`), and the North/Central/South lines | `hex.label`, `map.areaOf`                       |

The boards are **generated, not transcribed**
(`src/ogre/engine/mapdata.ts`). Triplanetary-VTT ships no scan or trace of a
published Ogre map. See the note in that file if you would rather play on the
printed board.

### 3 – Units

| Rule                                                                    | Where                                              |
| ----------------------------------------------------------------------- | -------------------------------------------------- |
| 3.01 Armour unit stats, the `*` split attack                            | `src/ogre/engine/units.ts`                         |
| 3.02 Infantry as squads; defence equals squad count; three to a counter | `src/ogre/engine/units.ts`, `state.printedDefense` |
| 3.02.1 Marines: water movement and doubled defence in water             | `state.defenseOf`                                  |
| 3.02.2 Heavy Weapons Teams: one-shot 3/4 plus inherent 1/1              | `units.HEAVY_WEAPON`, `src/ogre/engine/combat.ts`  |
| 3.03 Truck and Hovertruck at D0, D1 in town or under spillover          | `state.defenseOf`                                  |
| 3.04.2 Ogre components, including internal missiles and racks           | `src/ogre/engine/ogres.ts`, `types.OgreWeapon`     |
| 3.04.2 Tread units and the movement track                               | `ogres.movementForTreads`                          |
| 3.05 Command Post at D0, strength 1 in an overrun                       | `src/ogre/engine/units.ts`                         |
| 3.05.2 Hardened CP: a D does nothing, a second D destroys               | `combat.applyToUnit`                               |
| 3.06 Buildings and structure points                                     | `types.Building`, `combat.resolveBuildingAttack`   |

### 4 – Turn sequencing

| Rule                                                   | Where                                                        |
| ------------------------------------------------------ | ------------------------------------------------------------ |
| 4.02 The five steps of a player-turn                   | `reducer.advancePhase`                                       |
| 4.02.1(a) Automatic recovery from combat disablement   | `movement.runRecovery`                                       |
| 4.02.1(b) Die roll to recover from terrain disablement | `movement.runRecovery`                                       |
| 4.02.3 The disable check, after everything has moved   | `movement.resolvePendingHazards`                             |
| 4.03/4.04 Multi-player and multi-side ordering         | `reducer.startNextPlayerTurn` (turn order is the scenario's) |

### 5 – Movement

| Rule                                                                  | Where                                             |
| --------------------------------------------------------------------- | ------------------------------------------------- |
| 5.02 Stacking, per side, with infantry at one third                   | `movement.hexLoad`                                |
| 5.02.3 Splitting and combining infantry counters                      | `reducer.doSplit`, `doCombine`                    |
| 5.03 Moving through friendly units, and through unarmed enemies       | `movement.stepInfo`                               |
| 5.05 GEV double movement                                              | `state.movementAllowance`, `reducer.advancePhase` |
| 5.06 Ogre movement points from the tread track                        | `state.movementAllowance`                         |
| 5.07.1 The road bonus, as a property of the whole phase               | `movement.planPath`                               |
| 5.07.3 Rail: terrain ignored by all, bonus only for GEVs and infantry | `movement.bonusEligibleFor`                       |
| 5.08.1–5.08.5 The five terrain tables                                 | `terrain.entryCost`                               |
| 5.09 The minimum move                                                 | `movement.planPath`                               |
| 5.11 Infantry riding vehicles, mount/dismount sequencing              | `movement.canMount`, `canDismount`                |
| 5.12 Leaving the map                                                  | `movement.applyMove`, `Unit.offMap`               |

### 6 – Ramming

| Rule                                                                         | Where                                                            |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 6.01.1 Two ordinary rams a turn, or one Ogre                                 | `ram.canRam`                                                     |
| 6.02 Ogre rams armour: 1-3 disabled, 4-6 destroyed; immobile units flattened | `ram.ramArmorWithOgre`                                           |
| 6.02 Tread cost: 2 for a Heavy Tank or MHWZ, 3 for a Superheavy, 1 otherwise | `ogres.ogreRamsArmorSelfLoss`                                    |
| 6.02.1 Riders share the die roll, and dismount if they live                  | `ram.resolveRiders`                                              |
| 6.03 Ramming a CP costs treads equal to its defence — zero, normally         | `ram.ramCommandPost`                                             |
| 6.04 Movement recalculated mid-turn after tread loss                         | `state.movementAllowance`, tested against the rulebook's example |
| 6.05 Ogre versus Ogre, and the Size Table dice                               | `ram.ramOgreWithOgre`, `ogres.SIZE_TABLE`                        |
| 6.06 Driving over infantry — not a ram, and not against the limit            | `movement.stepInfo`, `reducer.doReduceInfantry`                  |
| 6.07.2 Conventional armour rams an Ogre and dies                             | `ram.ramOgreWithArmor`                                           |
| 6.07.3 GEV rams at twice its attack strength, and is destroyed               | `ram.ramUnitWithGev`                                             |
| 6.08 Fighting in the same hex                                                | falls out of range being hex distance                            |

### 7 – Combat

| Rule                                                                        | Where                                         |
| --------------------------------------------------------------------------- | --------------------------------------------- |
| 7.02 Attack strength and range; no line of sight                            | `hex.distance`, `combat.previewAttack`        |
| 7.05 One attack per unit and per Ogre weapon per turn                       | `combat.spentReason`                          |
| 7.05.1 AP weapons: infantry and D0 only, once per counter per phase         | `combat.previewAttack`                        |
| 7.05.2/7.05.3 Missiles are one-shot; racks fire one internal missile a turn | `state.isFireable`                            |
| 7.06 Combining attacks — except on treads                                   | `combat.previewAttack`                        |
| 7.07.1 Infantry splitting fire between targets                              | `AttackerRef.squads`                          |
| 7.10 The odds ladder, 5-1 automatic, worse than 1-2 nothing                 | `crt.oddsFor`                                 |
| 7.11 NE / D / X, and D not affecting Ogres or the train                     | `crt.applyToTarget`, `combat.applyToUnit`     |
| 7.12 Spillover fire, at half strength and one step down                     | `combat.applySpillover`                       |
| 7.13.1 Attacks on Ogre weapons                                              | `combat.previewAttack`                        |
| 7.13.2 Attacks on treads: one unit, always 1-1, strength in tread units     | `combat.resolveTreadAttack`                   |
| 7.13.3 An Ogre dies only with every weapon and every tread gone             | `state.ogreIsDestroyed`                       |
| 7.14 Terrain effects on combat, including treads in town                    | `terrain.defenseMultiplier`, `treadHitRollIn` |

### 8 – Overrun combat

Ramming and overrun are alternatives, never both — "Do not use both!" (6.00) —
and `GameOptions.overrunCombat` is that decision. The two starting scenarios use
ramming, as 1.01 says to; The Crossing and The Landing use overrun, as does a
custom battle built on a G.E.V. map.

| Rule                                                                                             | Where                                                     |
| ------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| 8.01 Initiating by moving into an enemy hex; settled before movement resumes                     | `overrun.beginOverrun`                                    |
| 8.02 Infantry, Ogre weapons and Superheavy AP doubled; disabled units halved; a CP at strength 1 | `overrun.overrunStrength`                                 |
| 8.02 The two multipliers compose — a disabled Superheavy's AP fires at printed strength          | asserted in `tests/ogre/overrun.test.ts`                  |
| 8.03 Defenders keep terrain, attackers defend at printed strength                                | `overrun.overrunDefense`                                  |
| 8.04 Fire rounds, defender first, one shot per unit per round                                    | `overrun.endOverrunRound`, `previewOverrunAttack`         |
| 8.04 Infantry split into 1-squad counters for the combat                                         | `overrun.splitInfantryIn`                                 |
| 8.04 / 7.12.2 No spillover inside an overrun                                                     | `overrun.resolveOverrunAttack` (it simply never calls it) |
| 7.11.2 Any D or X to a non-Ogre is an X; only a true X touches an Ogre                           | `overrun.resolveOverrunAttack`                            |
| 8.05.1 A disarmed Ogre withdraws after two further enemy fire rounds and stays in the hex        | `overrun.reapOverrun`                                     |
| 8.05.2 / 8.05.3 Ramming at the end of the first fire round                                       | `overrun.overrunRam`                                      |
| 8.05.4 A missile rack is spent for the turn, not the round                                       | `overrun.markFired`                                       |
| 8.06.1 Riders may dismount before the shooting starts                                            | the `dismount` step, and `reducer.doDismount`             |
| 8.08 Survivors stay in the hex and the movement phase resumes                                    | `overrun.finishOverrun`                                   |

The one thing worth knowing as a player: **an overrun is the only time the
non-phasing player has a decision.** `applyCommand` asks `overrunActor` rather
than `activePlayer` while one is being fought, and the shell follows it.

### 9 – The train (provisional)

Section 9 is implemented from its shape rather than its text, and says so in
`src/ogre/engine/units.ts`: the train is a `TRAIN` counter that "moves only
along railroad hexes" (9.01) at its speed marker, which changes by one step a
turn before the train moves (9.02, `reducer.doSetTrainSpeed`); "A D result does
not affect the train" (7.11, `combat.targetIgnoresD`); and a ram against it is
resolved at the Size Table's train column — an Ogre or Superheavy wrecks it, a
lighter unit attacks at 1-2 (a GEV at 1-1) and dies doing it (9.05,
`ram.ramTrain`). Its defence, size, capacity and victory value are placeholders
flagged `unconfirmed`. No scenario on the table fields it yet — it is not in
`units.SELECTABLE_CLASSES` either, so only the tests exercise it.

### 10 – Cruise missiles (shape transcribed, numbers provisional)

| Rule                                                           | Where                                       |
| -------------------------------------------------------------- | ------------------------------------------- |
| 3.01 A loaded Missile Crawler attacks by firing its missile    | `missiles.launchMissile` (it becomes a CRL) |
| 10.02 Launch at any hex, in the fire phase                     | `missiles.launchCheck`                      |
| 10.03 Flight: a leg a turn, straight for the target            | `missiles.flyMissiles` from `advancePhase`  |
| 10.04 Interception by lasers with a line of sight, in passing  | `missiles.flyMissile`                       |
| 10.05 Detonation: ground zero total, the hex a crater, a blast | `missiles.detonate`, `blastUnit`            |
| 10.06 Fratricide between missiles                              | `missiles.detonate`                         |

The flight per turn (12 hexes), the missile's defence against interception
(2), the blast strengths by ring (12 at one hex, 6 at two) and the fratricide
radius (2) are placeholders in `CRUISE_MISSILE`, chosen to play sensibly
against the rest of the CRT and flagged for correction against the printed
table. Everything else about the section — the launch being the crawler's
attack, lasers being the only interception, ground zero taking cybertanks
whole, the rings attacking an Ogre component by component — is the rule.

### 11 – Buildings

| Rule                                                                      | Where                                                  |
| ------------------------------------------------------------------------- | ------------------------------------------------------ |
| 11.03 / 11.04.1 Structure points; damage at twice attack, halved in cover | `combat.resolveBuildingAttack`                         |
| 11.04.2 Attacked at point-blank range inside an overrun                   | `overrun.previewOverrunAttack`                         |
| 11.04.3 Rammed for the Size Table's dice                                  | `ram.ramBuilding`                                      |
| Orbital Drop: a base is an Admin building of 20 SP                        | `src/ogre/scenarios/assault.ts`, drawn by the renderer |

Combat-engineer bonuses (Section 15) are not in.

### 12 – Lasers (provisional values)

"The only rule in the game with line of sight." `LSR` and `LTWR` are immobile
structure units that fire at any range down a clear line (`los.laserLineOfSight`,
consulted by `combat.previewAttack`): a standard laser is blocked by forest,
swamp, town or rubble in between (12.02); a tower fires over them but not into
them (12.03). Both take interception shots at cruise missiles in flight. Their
attack and defence values are placeholders flagged `unconfirmed` in
`src/ogre/engine/units.ts`.

### 13 – Optional rules (partial)

13.01 damage to terrain — hexes at defence 4, degrading to rubble, cutting
roads — is implemented behind `GameOptions.terrainDamage`.

### 14 – Advanced units (partial)

| Rule                                                            | Where                  |
| --------------------------------------------------------------- | ---------------------- |
| 14.02 The Ninja: −1 to every die rolled against it              | `combat.resolveAttack` |
| 14.02 The Ninja's weapons do not combine with other units' fire | `combat.previewAttack` |

### Setup

Every scenario opens with a deployment step when built with `setup: true`
(`src/ogre/engine/setup.ts`), which the shell asks for by default: the seeded
arrangement is the starting point, each side rearranges its counters inside the
printed setup area under the printed ceilings ("No more than 20 attack strength
points may be set up in this area"), the defender first, and nothing else
happens until every side has said it is ready. On the one-per-hex map, dropping
a counter on a friend swaps them.

### Orbital Drop (the campaign over these battles)

The Assault scenarios read their terms off an order of battle: off-map reserves
that enter from the reaction turn (`src/ogre/engine/reserves.ts`), an invading
Ogre inert until it has assembled (`isInertOgre`, and the unfinished-Ogre rule
of 15.02.2 turning its Ds into Xs), orbital strikes as CRT attacks from nowhere
(`combat.resolveOrbitalStrike` — never at the base itself, a post or the Admin
building, which only the landed force may take: read literally, "any target"
let two warships raze a twenty-point base in two fire phases and a post on a
rock die to one shot), ridge overlays as `GameState.sideOverrides`,
the asteroid table as `GameOptions.lowGravity` and `noHover`, and cybertank
record sheets carried in from the last battle (`assault.applyOgreRecord`).

---

## Not implemented yet

Each of these is a self-contained addition; none of them require changing the
engine's shape.

| Section                     | What is missing                                                                  | Notes                                                                                                                                                           |
| --------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **9 – The train**           | The printed numbers, and a scenario to run it in                                 | The mechanics are in, flagged provisional; see above.                                                                                                           |
| **10 – Cruise missiles**    | The printed flight, defence and blast numbers                                    | The mechanics are in, flagged provisional; see above.                                                                                                           |
| **12 – Lasers**             | The printed attack and defence values                                            | The mechanics are in, flagged provisional; see above.                                                                                                           |
| **13 – Optional rules**     | Mines, camouflage, dummies, bridge destruction, Superheavy record sheets (13.07) | Terrain damage (13.01) is in. `GameOptions.superheavyRecordSheet` is a stub — declared, defaulted false, read nowhere.                                          |
| **14 – Advanced units**     | The LAD deployment sequence                                                      | Both units' statistics are in, and the Ninja's stealth.                                                                                                         |
| **15 – Combat engineering** | The engineering itself                                                           | Entrenchments, mine handling, Vulcan tasks. The Vulcan's record sheet — the two manipulator arms at D2 (15.02) — and the unfinished-Ogre rule (15.02.2) are in. |

---

## Reporting a rules bug

Bug reports about rules accuracy are the most valuable kind. Cite the section
and the phrase, and say what the implementation does instead. If you are adding
a rule, quote the rulebook in a comment at the implementation site and add the
row to this file — not to `docs/RULES-MAPPING.md`, which is the Triplanetary
audit.
