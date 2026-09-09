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
| 5.11.2 One roll for the combination, odds and results kept separate   | `combat.applyToRiders`                            |
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

### 9 – The train

| Rule                                                                     | Where                                           |
| ------------------------------------------------------------------------ | ----------------------------------------------- |
| 9.01 Moves only along railroad hexes; set up on the rails                | `movement.stepInfo`, `setup.standable`          |
| 9.02 Speed markers M0/1, M2/3, M4/5, M6/7; runs one of the two distances | `units.TRAIN_MARKERS`, `movement.planPath`      |
| 9.02.1 The marker changes by one step at the end of each turn            | `reducer.doSetTrainSpeed` (fire phase or later) |
| 9.02.3 Does not count against stacking limits                            | `movement.wouldOverstack`                       |
| 9.02.4 Destroyed when it runs into a hex where the rails are cut         | `movement.applyMove`                            |
| 9.03 Defence 3; only an X affects it                                     | `units.TRAIN`, `combat.targetIgnoresD`          |
| 9.03.2 Defence doubled in a town                                         | `state.defenseOf`                               |
| 9.05 Ramming resolved at the Size Table's train column                   | `ram.ramTrain`                                  |
| 9.06 Collisions with units on the track                                  | `movement.collide`                              |

Two things are short of the printed rule. A real train is **two counters** two
hexes long, with the rear half destroyed separately (3.03, 9.01, 9.03); here it
is one. And its cargo is counted in squads rather than the 12 "size points" a
half carries (9.07). Armed trains (9.03.1) and reinforcements from the train
(9.07) are not in either.

**The Train** (`src/ogre/scenarios/train.ts`) is the scenario that fields it:
an original, since the rulebook's own train scenario is not to hand. The train
crosses the green map's line from the west with six squads aboard and an escort
of twelve counters; the raiders have eight armour units and twelve squads in
the eastern half; the train wins by leaving at the east end inside fourteen
turns. The computer plays either seat, and the driver reads the line ahead and
brakes in time, because a marker it cannot run leaves it standing still. Across
eight seeds the escort takes four.

### 10 – Cruise missiles

| Rule                                                                    | Where                                          |
| ----------------------------------------------------------------------- | ---------------------------------------------- |
| 3.01 A loaded Missile Crawler attacks by firing its missile             | `missiles.launchMissile` (it becomes a CRL)    |
| 10.02 Reaches any hex on the map, resolved before any more actions      | `missiles.launchMissile` traces the path       |
| 10.02.1 Fratricide: six hexes, and nothing flies near a fresh crater    | `missiles.blastsThisTurn`, `launchCheck`       |
| 10.03 Every gun in range gets one shot; disabled units may not          | `missiles.shotsAgainst`                        |
| 10.03.1 Ogres fire once with each weapon, a rack once a turn            | `missiles.shotsAgainst`                        |
| 10.03.2 Two dice against a table by unit type, +1/+2/+3 for distance    | `missiles.interceptionTarget`, `trackingBonus` |
| 10.03.3 Premature detonation: a hit missile goes off on a 6             | `missiles.launchMissile`                       |
| 10.04 Ground zero total, a crater unless in water, then the blast table | `missiles.detonate`, `blastEffect`             |
| 10.04 Terrain cover, and SP and treads attacked five at a time          | `missiles.effectiveDistance`, `blastUnit`      |
| 12.04 Each Laser or Laser Tower fires once at each missile in range     | `missiles.shotsAgainst`                        |

The one thing here that is not the rulebook's is the route. The rules let the
owner trace "any route indicated by its owner"; the engine flies a straight
line. It shows in exactly one place — a second missile that would pass within
six hexes of this turn's crater has nowhere else to go — and `launchCheck`
refuses the launch and says so, rather than quietly flying it through.

### 11 – Buildings

| Rule                                                                      | Where                                                  |
| ------------------------------------------------------------------------- | ------------------------------------------------------ |
| 11.03 / 11.04.1 Structure points; damage at twice attack, halved in cover | `combat.resolveBuildingAttack`                         |
| 11.04.2 Attacked at point-blank range inside an overrun                   | `overrun.previewOverrunAttack`                         |
| 11.04.3 Rammed for the Size Table's dice                                  | `ram.ramBuilding`                                      |
| Orbital Drop: a base is an Admin building of 20 SP                        | `src/ogre/scenarios/assault.ts`, drawn by the renderer |

Combat-engineer bonuses (Section 15) are not in.

### 12 – Lasers

| Rule                                                                    | Where                                                                 |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 12.01 "Defensively, they are buildings with Structure Points"           | `state.structurePointsOf`, `combat.resolveEmplacementAttack`          |
| 12.02 A standard Laser's line of fire, blocked by raised terrain        | `los.laserLineOfSight`, consulted by `combat.previewAttack`           |
| 12.03 A tower fires over terrain but not into it                        | `los.laserLineOfSight`, `terrain.hidesFromLaserTower`                 |
| 12.04 One shot at each Cruise Missile that comes in range               | `missiles.shotsAgainst`                                               |
| 12.05 An Ogre missile intercepted on a 10 or better, on two dice        | `combat.interceptOgreMissiles`, `OGRE_MISSILE_INTERCEPT`              |
| 12.06 No attack on a unit after firing in the preceding enemy turn      | `state.markFiredInEnemyTurn`, `clearLaserWatch`, `combat.spentReason` |
| 12.07 Damaged at 10 SP, destroyed at 0                                  | `units.LASER_DAMAGED_AT`, `state.laserDamaged`                        |
| 12.08 No spillover on units stacked with the target, but riders are hit | `combat.isLaserAttack`, `applySpillover`, `applyToRiders`             |
| 12.09 Double strength when overrun; a damaged Laser does not fire       | `overrun.overrunStrength`, `previewOverrunAttack`                     |

A Laser is a unit that carries a building's defence: a shot at one takes
Structure Points off a total rather than rolling on the Combat Results Table,
and a cruise-missile blast reads it on the building rows of 10.04 and takes it
five points at a time. `LSR` and `LTWR` both start at 20 SP — the one number in
this section that is on the counter rather than in the rules text, and still
flagged `unconfirmed` in `src/ogre/engine/units.ts`.

### 13 – Optional rules (partial)

13.01 damage to terrain — hexes at defence 4, degrading to rubble, cutting
roads — is implemented behind `GameOptions.terrainDamage`.

The three rules that hide something are implemented from their shape, in
`src/ogre/engine/concealment.ts`, each behind an option and each needing the
setup step (they are laid, placed and turned face down in it):

| Rule              | Where                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 13.04 Minefields  | `GameOptions.minefields` a side, laid secretly in the setup (`layMinefield`, own area, one to a hex); the first enemy unit onto one stops there and is attacked (`concealment.tripMinefield`); the field is then revealed and stays, attacking every later enemy entrant. The layer's own side passes freely.                                                                        |
| 13.05 Camouflage  | `GameOptions.camouflage`: every counter that moves is face down once the counters are down (`concealAll`; a post or a laser is not); the enemy sees a `?` — which side, not what — until it fires, is fired on, rams, is rammed or overrun, is under a blast or strike, or ends a movement phase next to an enemy (`revealUnit`, `spotAdjacent`). Moving does not by itself show it. |
| 13.06 Dummy units | `GameOptions.dummies` a side, class `DUM`: placed and moved like a counter, face down, nothing at all; removed the moment it is revealed. A shot at one is spent; a ram or overrun at a hex of dummies calls the bluff and fights nothing.                                                                                                                                           |
| The view          | `redactOgreState(state, seat)`: own counters and mines whole, the enemy's face-down counters as `UNK` stand-ins with the real id, owner and hex, the enemy's unrevealed mines gone. What the referee sends each seat, and what the computer decides against.                                                                                                                         |

The numbers are provisional and flagged in `MINEFIELD`: a minefield attacks a
conventional unit at 4 and takes two tread units off a cybertank on a 4 or
better; a dummy moves at 3 like a light tracked vehicle; camouflage is broken
by a movement phase ending with an enemy adjacent. Correct them against the
printed text.

The rest of Section 13 that is in, and the engineering of Section 15, again
from their shape (`src/ogre/engine/engineering.ts`):

| Rule                          | Where                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 13.02 Bridges                 | A road or rail crossing a stream is a target of its own (`TargetRef` kind `bridge`) when terrain damage is in play: defence 4 (`BRIDGE`), an X drops it (`demolishBridge`, `GameState.bridgesDown`), a D does nothing; the route is gone across that hexside only (`routeBetween`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 13.07 Superheavy record sheet | `GameOptions.superheavyRecordSheet`: a Superheavy carries two guns of 3, two AP and three tread units (`SUPERHEAVY_SHEET`); an X takes one of them on a die (1-2 gun, 3-4 tread, 5-6 AP), a D a tread unit (`applySheetDamage`); it shoots with the guns and moves on the tread units it has left, walks through infantry only with an AP left, and is destroyed when it has neither a gun nor a tread unit.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 15 Combat engineering         | `engineer` order in the fire phase, spending the Sapper's attack (15.03). Dice pools: a Combat Engineer squad a die, a Heavy Drone two, a Vulcan four; a Vulcan task is two for the Vulcan and one a Drone (`engineeringDice`, `vulcanDice`). Tasks: dig entrenchments (the die sets how many squads it shelters), plant a mine (5+), sweep a neighbouring hex (15.03.3), lift a friendly mine or disarm an enemy one (5+), mend a cut road with a supply Truck (6), grade a ridge flat (5+), finish off a weaponless cybertank (4+, or a Vulcan's execution charge at 4+ immobile and 6 mobile). Vulcan tasks: dig a revetment (15.04.7), pull a stuck unit out (6, a Heavy Drone per size above five), relay cut rail (5+), clear a road through damaged terrain (4+, a Vulcan or two Drones), field-repair an Ogre weapon (5+ to see if it can be tried at all, then a 6) or its treads (a tread per six rolled). One attempt per task per hex per turn. |

The numbers are provisional: the bridge's defence, the sheet's components and
the die that picks one, the drone's stowage. Correct them against the printed
text.

### 14 – Advanced units (partial)

| Rule                                                            | Where                  |
| --------------------------------------------------------------- | ---------------------- |
| 14.02 The Ninja: −1 to every die rolled against it              | `combat.resolveAttack` |
| 14.02 The Ninja's weapons do not combine with other units' fire | `combat.previewAttack` |

The drone's deployment is implemented from its shape: it rides any vehicle
that carries infantry, as one squad's worth of room (`movement.canMount`),
and the turn it is set down it is setting up and may not fire
(`reducer.doDismount`). The printed sequence is still to be checked.

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

| Section                     | What is missing                                                                                                        | Notes                                                                                                                                                           |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **9 – The train**           | The two-counter train, armed trains (9.03.1), reinforcements aboard (9.07)                                             | The markers, the end-of-turn speed change, cut track, collisions, the town doubling and stacking freedom are all as printed. See above.                         |
| **10 – Cruise missiles**    | The owner's choice of route; the engine flies a straight line                                                          | Immediate flight, the 2d6 interception table with its tracking bonuses, premature detonation, six-hex fratricide and the printed blast table are all in.        |
| **12 – Lasers**             | Nothing; only the 20 SP on the counter is unconfirmed                                                                  | Structure Points, the damaged state, the fire restriction, Ogre-missile interception and the spillover exception are all as printed (12.01–12.09).              |
| **13 – Optional rules**     | River bridges (13.02.1), the layer's choice of road mine, passive detection (13.04.1)                                  | Terrain damage (13.01), bridges at D6 (13.02), mines (13.04), camouflage (13.05), dummies (13.06) and the Superheavy's record sheet (13.07) are all as printed. |
| **14 – Advanced units**     | The LAD's three-turn deployment from a cargo pallet                                                                    | Both units' statistics are in, and the Ninja's stealth; the drone rides a vehicle as one squad and sets up the turn it is set down.                             |
| **15 – Combat engineering** | Reloading missiles (15.04.4), towing (15.04.8), Drone control and cargo (15.02.1, 15.02.4-5), assembly times (15.02.2) | The dice pools, entrenchments, revetments and fourteen tasks are in, the Vulcan's own among them. See above.                                                    |

---

## What is still not the printed rule

The engine has been checked against **Ogre Sixth Edition, Revised:
Battlefields**, rules version 6.3 (August 2019). Most of what this file used
to call provisional is now quoted and cited at the implementation site.

`docs/OGRE-UNCONFIRMED.md` is what is left: the handful of numbers that are on
the counters rather than in the rules text, and the rules the engine knowingly
models differently — cruise missile flight and interception, the train as two
counters, the drone's three-turn deployment, the engineers' dice pools, and the
whole of the Vulcan's work.

## Reporting a rules bug

Bug reports about rules accuracy are the most valuable kind. Cite the section
and the phrase, and say what the implementation does instead. If you are adding
a rule, quote the rulebook in a comment at the implementation site and add the
row to this file — not to `docs/RULES-MAPPING.md`, which is the Triplanetary
audit.
