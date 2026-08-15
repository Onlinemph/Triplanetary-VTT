# Rules mapping

Every rule in the _Triplanetary_ rulebook (Steve Jackson Games, 3rd edition,
rules version 3.0, June 2018), and where it lives in this codebase — so the
implementation can be audited against the printed rules rather than trusted.

**Status key**

|     | Meaning                                                                                    |
| --- | ------------------------------------------------------------------------------------------ |
| ✅  | Implemented and matches the printed rule.                                                  |
| ◐   | Implemented with a documented simplification or a stated interpretation.                   |
| ○   | Not implemented.                                                                           |
| ▣   | A social rule, a referee judgement, or table etiquette — surfaced in the UI, not enforced. |

Where the rulebook is ambiguous, the interpretation is quoted in a comment at
the implementation site. Those are called out in the Notes column here too.

---

## p. 1 — Ship types

| Rule                                                                         | Where                                                                           | Status | Notes                                                    |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------ | -------------------------------------------------------- |
| Nine ship types plus orbital bases; combat strength, fuel, cargo, cost       | `engine/ships.ts` → `SHIP_CLASSES`                                              | ✅     | The printed table, transcribed.                          |
| "Ships with a D after their combat strength may not attack or counterattack" | `engine/ships.ts` → `canAttack`, `isCommercial`; `engine/combat.ts` → `canFire` | ✅     | Transport, tanker, liner.                                |
| "Warships and packets have a combat strength without the D suffix"           | `engine/ships.ts` → `SHIP_CLASSES[].defensiveOnly`                              | ✅     | The packet attacks but is still commercial for overload. |
| "Torchships have unlimited fuel"                                             | `engine/ships.ts` → `UNLIMITED`; `engine/logistics.ts` → `hasUnlimitedFuel`     | ✅     | Serialised through a sentinel — see `net/session.ts`.    |
| Orbital bases: unlimited store, special combat rules                         | `engine/types.ts` → `BaseState`; `engine/combat.ts` → `canFire`                 | ✅     | Strength 16; functions at D1.                            |

## p. 2 — Sequence of play

| Rule                                                           | Where                                                                                     | Status | Notes                                                                                                                                                                                                                      |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Each turn represents one day"                                 | `engine/types.ts` → `GameState.turn`                                                      | ✅     |                                                                                                                                                                                                                            |
| Five phases: astrogation, ordnance, movement, combat, resupply | `engine/types.ts` → `Phase`, `PHASES`                                                     | ✅     |                                                                                                                                                                                                                            |
| Phase and player-turn advance                                  | `engine/reducer.ts` → `applyCommand` (`endPhase`)                                         | ✅     | Runs the phase engines below in order.                                                                                                                                                                                     |
| Movement phase runs ships and the phasing player's ordnance    | `engine/movement.ts` → `executeMovementPhase`; `engine/ordnance.ts` → `moveOrdnancePhase` | ✅     | "Mines, torpedoes, and nukes launched by the phasing player (on this or previous turns) also move at this time."                                                                                                           |
| Astrogation hazards resolved in the combat phase               | `engine/movement.ts` → asteroid hazard rolls                                              | ◐      | Rolled at the end of movement rather than in the combat phase, so a ship disabled by asteroids cannot then shoot. The rulebook's ordering has the same effect on the same turn; the difference is only visible in the log. |
| Damage recovery at the end of resupply                         | `engine/combat.ts` → `recoverDamage`; `engine/logistics.ts` → `runResupplyPhase`          | ✅     |                                                                                                                                                                                                                            |
| Order of players decided by die roll or consent                | `scenarios/*` → `playerOrder`                                                             | ▣      | Seat order is the scenario's; no in-game roll-off.                                                                                                                                                                         |

## p. 2–3 — Movement and astrogation

| Rule                                                                                                               | Where                                                                                                                                     | Status | Notes                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------- |
| "A ship which is not accelerated by thrust or gravity will move as it did in the previous turn"                    | `engine/movement.ts` → `predictedEndpoint`                                                                                                | ✅     | `pos + velocity + gravity picked up last turn`.                                                                                 |
| "One fuel point allows a ship to alter its predicted course by one hex in any direction"                           | `engine/movement.ts` → `reachableEndpoints`, `plotCourse`                                                                                 | ✅     |                                                                                                                                 |
| A stationary ship has no vector                                                                                    | `engine/state.ts` → `ZERO`; `render/courses.ts`                                                                                           | ✅     | Drawn as the rulebook's square.                                                                                                 |
| Out of fuel: no further acceleration except gravity                                                                | `engine/movement.ts` → `previewPlot`                                                                                                      | ✅     |                                                                                                                                 |
| Astrogation conventions (arrows, circles for acceleration, double circles for overload, turn numbers, T/M/N marks) | `render/courses.ts` → `drawCourseArrow`, `drawAccelMark`, `drawPredictedCourse`, `drawTrail`; `render/counters.ts` → `drawOrdnanceMarker` | ✅     | Presentation only, but they are printed rules and the chart follows them.                                                       |
| Gravity: "arrows in hexes adjacent to those bodies"                                                                | `engine/map.ts` → `gravityAt`                                                                                                             | ✅     | Derived, not transcribed: the derivation that every arrow must point at its body is in the `map.ts` header.                     |
| "Gravity takes effect on the turn after an object enters the gravity hex"                                          | `engine/types.ts` → `Ship.pendingGravity`; `engine/movement.ts` → `effectiveGravity`                                                      | ✅     |                                                                                                                                 |
| "Gravity is cumulative and mandatory"                                                                              | `engine/map.ts` → `accumulateGravity`                                                                                                     | ✅     |                                                                                                                                 |
| "A ship which passes between a gravity hex and the planetary outline is affected by the gravity hex"               | `engine/geometry.ts` → `traceSegment`, `hexesContaining`                                                                                  | ✅     | "Portions of astral body hexes not covered by the printed disk are considered to be part of the adjacent gravity hexes" (p. 7). |
| Weak gravity (Luna, Io): first of a run optional, later ones mandatory                                             | `engine/map.ts` → `gravityFromMove`, `weakGravityArrow`; `engine/movement.ts` → `setOptionalGravity`                                      | ✅     |                                                                                                                                 |

## p. 4 — Landing, takeoff, orbit, overload, crashes, ramming

| Rule                                                                                          | Where                                                                              | Status | Notes                                                                                   |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------- |
| Ships may land only where the world has a base                                                | `engine/movement.ts` → `land`                                                      | ✅     |                                                                                         |
| Takeoff by booster: free, one hex, then surface gravity leaves the ship stationary            | `engine/movement.ts` → `takeOff`                                                   | ✅     | The fall back onto the planet next turn is not special-cased; the inward arrow does it. |
| Boosters "available only at friendly bases"                                                   | `engine/movement.ts` → `takeOff`; `engine/logistics.ts` → `baseIsFriendly`         | ✅     |                                                                                         |
| "A ship may only land by expending one fuel point while in orbit… then moves to any hex side" | `engine/movement.ts` → `land`                                                      | ✅     |                                                                                         |
| "It must take off from the hex side where it landed"                                          | `engine/types.ts` → `ShipLocation.landed.side`                                     | ✅     |                                                                                         |
| Landing on Ceres, Clandestine or any belt asteroid by stopping in the hex                     | `engine/movement.ts` → landing-location resolution                                 | ✅     | Take off by accelerating out.                                                           |
| Orbit: one hex per turn between adjacent gravity hexes of the same body                       | `engine/map.ts` → `orbitOf`, `orbitSense`                                          | ✅     | Emergent and derived; never stored on the ship.                                         |
| "Warships may perform one overload maneuver between maintenance stopovers"                    | `engine/movement.ts` → `canOverload`; `engine/types.ts` → `Ship.overloadAvailable` | ✅     | Restored by `logistics.resupply`.                                                       |
| "Commercial ships… may not perform the overload maneuver"                                     | `engine/ships.ts` → `isCommercial`                                                 | ✅     | Packets included, despite being armed.                                                  |
| "If a ship's course vector intersects the printed outline of an astral body, it has crashed"  | `engine/map.ts` → `crashedInto`; `engine/geometry.ts` → `courseHitsDisc`           | ✅     | Exact segment/disc intersection, not a hex test.                                        |
| Ramming: course through the centre of the target's hex, one target per turn                   | `engine/movement.ts` → `declareRam`, `courseThroughCentre`                         | ✅     |                                                                                         |
| Ram result: die, minus velocity difference over 2, ram column, applies to both ships          | `engine/crt.ts` → `OTHER_DAMAGE.ram`, `velocityModifier`                           | ✅     |                                                                                         |
| "Mines, torpedoes, and nukes… are not capable of ramming or being rammed"                     | `engine/movement.ts` → `declareRam`                                                | ✅     |                                                                                         |

## p. 4–5 — Gun combat

| Rule                                                                                                                | Where                                                                                       | Status | Notes                                                                           |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------- |
| "Only ships of the phasing player may initiate attacks"                                                             | `engine/combat.ts` → `resolveAttack`                                                        | ✅     |                                                                                 |
| Odds as attacker:defender, reduced to a table column                                                                | `engine/crt.ts` → `oddsColumn`                                                              | ✅     |                                                                                 |
| "If rounding is necessary, it is always done in favor of the defender"                                              | `engine/crt.ts` → `oddsColumn`                                                              | ✅     | Better than 4:1 is 4:1; worse than 1:4 is no effect.                            |
| Limited attacks — attack with less than rated strength                                                              | `engine/commands.ts` → `Attack.strength`; `engine/combat.ts` → `previewAttack`              | ✅     |                                                                                 |
| Multiple targets in a hex defend with the sum of their strengths                                                    | `engine/combat.ts` → `targetGroupIn`, `previewAttack`                                       | ✅     |                                                                                 |
| Multiple attackers, same or different hexes, pool strength                                                          | `engine/combat.ts` → `previewAttack`                                                        | ✅     |                                                                                 |
| "In any combat with multiple targets or attackers, use the greatest possible penalties"                             | `engine/combat.ts` → `previewAttack`                                                        | ✅     | Greatest range and greatest velocity difference.                                |
| "No ship may attack or be attacked more than once per combat phase"                                                 | `engine/types.ts` → `Ship.firedThisPhase`, `attackedThisPhase`                              | ✅     |                                                                                 |
| Line of sight blocked by moons, planets and Sol — never by ships, ordnance or asteroids                             | `engine/map.ts` → `lineOfSightBlockedBy`, `hasLineOfSight`                                  | ✅     |                                                                                 |
| Range: −1 per hex, "from the attacker's closest approach to the target's final position"                            | `engine/geometry.ts` → `closestApproach`; `engine/crt.ts` → `rangeModifier`                 | ✅     | The defender's vector does not matter (Figure 8).                               |
| Relative velocity: −1 per hex of difference in excess of 2                                                          | `engine/crt.ts` → `velocityModifier`                                                        | ✅     | Both vectors plotted from a common point (Figure 9).                            |
| Counterattack before damage is implemented                                                                          | `engine/combat.ts` → `pendingCounterattack`, `resolveCounterattack`, `resolvePendingDamage` | ✅     | The attack is parked in `scenarioData._pendingAttack` until the victim answers. |
| "Any ships in the victim's hex and sharing its course may participate"                                              | `engine/combat.ts` → `pendingCounterattack`                                                 | ✅     | Same position _and_ same velocity.                                              |
| Odds recomputed, rounded in favour of the new defender                                                              | `engine/combat.ts` → `resolveCounterattack`                                                 | ✅     |                                                                                 |
| Commercial ships may not counterattack                                                                              | `engine/combat.ts` → `canFire`                                                              | ✅     |                                                                                 |
| "Ships landed at planetary bases may not fire guns or launch ordnance"                                              | `engine/combat.ts` → `canFire`; `engine/ordnance.ts` → `canLaunch`                          | ✅     |                                                                                 |
| "Once landed at a planetary base, a ship is immune from gunfire, mines, torpedoes, and ramming, but not from nukes" | `engine/combat.ts` → `immuneToGunfire`; `engine/ordnance.ts` → `immuneTo`                   | ✅     |                                                                                 |

## p. 5–6 — Ordnance

| Rule                                                                                                        | Where                                                                                                | Status | Notes                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| One item per ship per turn                                                                                  | `engine/types.ts` → `Ship.launchedOrdnanceThisTurn`; `engine/ordnance.ts` → `canLaunch`              | ✅     |                                                                                                                                                                                                                          |
| Not while at a base, refuelling, taking off or landing                                                      | `engine/ordnance.ts` → `canLaunch` (`atBase`)                                                        | ✅     | A base's own torpedo is a separate order (`launchBaseTorpedo`), since "They are capable of launching one torpedo per turn" is a rule about the base, not about a ship parked at it.                                      |
| Detonate on entering a hex containing a ship, astral body, mine, torpedo or nuke                            | `engine/ordnance.ts` → `detonate`, `checkOrdnanceAgainstCourse`                                      | ✅     |                                                                                                                                                                                                                          |
| All ordnance is affected by gravity                                                                         | `engine/types.ts` → `Ordnance.pendingGravity`; `engine/ordnance.ts` → `moveOrdnancePhase`            | ✅     |                                                                                                                                                                                                                          |
| Mine takes the launcher's vector; launcher must change course to leave the hex                              | `engine/ordnance.ts` → `ownMineConflict`, `mustAvoidOwnMine`                                         | ✅     |                                                                                                                                                                                                                          |
| Mine detonates when a course "passes through any portion of the hex"                                        | `engine/geometry.ts` → `traceSegment().touched`; `engine/ordnance.ts` → `checkOrdnanceAgainstCourse` | ✅     | `touched`, not `entered` — the distinction is the whole rule.                                                                                                                                                            |
| Each ship in an affected hex rolls separately for a mine                                                    | `engine/ordnance.ts` → `detonate`                                                                    | ✅     |                                                                                                                                                                                                                          |
| Guns and planetary defences have no effect on mines                                                         | `engine/ordnance.ts` → `attackableByGuns`                                                            | ✅     | Only nukes are shootable.                                                                                                                                                                                                |
| Ordnance lives five turns, then self-destructs                                                              | `engine/ordnance.ts` → `ORDNANCE_LIFETIME`, `ageOrdnance`                                            | ✅     |                                                                                                                                                                                                                          |
| Mine mass 10; any ship with hold capacity may launch one                                                    | `engine/ships.ts` → `CARGO`; `engine/ordnance.ts` → `canCarryOrdnance`                               | ✅     |                                                                                                                                                                                                                          |
| Torpedo may accelerate 1–2 hexes, on the launch turn only                                                   | `engine/ordnance.ts` → `TORPEDO_BOOST`, `torpedoAimOptions`, `Ordnance.canAccelerate`                | ✅     |                                                                                                                                                                                                                          |
| Torpedo hits a single target; roll ships "in a randomly chosen order" until one is damaged                  | `engine/ordnance.ts` → `detonate`; `engine/rng.ts` → `shuffle`                                       | ✅     | A torpedo that misses everything carries on.                                                                                                                                                                             |
| Torpedo mass 20; warships only                                                                              | `engine/ships.ts` → `canLaunchTorpedoes`                                                             | ✅     |                                                                                                                                                                                                                          |
| Nuke destroys everything in the hex automatically                                                           | `engine/ordnance.ts` → `detonate`                                                                    | ✅     | An asteroid hex becomes clear space (`GameState.clearedAsteroids`).                                                                                                                                                      |
| Nuke reaching a world devastates one hexside; ships that landed through it and any base on it are destroyed | `engine/ordnance.ts` → `nukeDevastationSide`                                                         | ✅     | "If it is not clear which hex side has been affected, the suffering player makes the choice" — resolved geometrically from the approach vector instead of asking, which is deterministic and never worse for the victim. |
| Nukes may be shot at 2:1 with range and velocity modifiers; a "disabled" nuke is destroyed                  | `engine/ordnance.ts` → `NUKE_TARGET_ODDS`, `attackNuke`, `firePlanetaryDefenceAtNuke`                | ✅     |                                                                                                                                                                                                                          |
| Nuke mass 20; non-warships carry at most one; only if the scenario allows                                   | `engine/ships.ts` → `nukeLimit`; `engine/types.ts` → `GameOptions.nukesAllowed`                      | ✅     |                                                                                                                                                                                                                          |

## p. 6 — Damage

| Rule                                                             | Where                                                                         | Status | Notes                               |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------ | ----------------------------------- |
| Gun combat damage table                                          | `engine/crt.ts` → `GUN_DAMAGE`                                                | ✅     | Transcribed from the printed table. |
| Other damage table (torpedoes, mines, asteroid, ram)             | `engine/crt.ts` → `OTHER_DAMAGE`                                              | ✅     |                                     |
| Modified roll below 1 has no effect; above 6 is 6                | `engine/crt.ts` → `clampRoll`                                                 | ✅     |                                     |
| D1–D5 disable; damage is cumulative; D6 or greater destroys      | `engine/combat.ts` → `applyDamage`; `engine/crt.ts` → `DESTRUCTION_THRESHOLD` | ✅     |                                     |
| "A disabled ship cannot maneuver, launch ordnance, or attack"    | `engine/combat.ts` → `canManeuver`, `canFire`                                 | ✅     |                                     |
| Dreadnaughts may still fire guns while disabled                  | `engine/combat.ts` → `canFire`                                                | ✅     |                                     |
| An orbital base works at D1                                      | `engine/combat.ts` → `canFire`                                                | ✅     |                                     |
| Damage control: one D per turn, at the end of the resupply phase | `engine/combat.ts` → `recoverDamage`                                          | ✅     |                                     |

## p. 6–7 — Astrogation hazards

| Rule                                                                                                       | Where                                                                                     | Status | Notes |
| ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------ | ----- |
| Bodies have a definite size; the course must intersect the printed image                                   | `engine/mapdata.ts` → `AstralBody.radius`; `engine/geometry.ts` → `courseHitsDisc`        | ✅     |       |
| Contact = crash, unless landing                                                                            | `engine/map.ts` → `crashedInto`; `engine/movement.ts` → landing resolution                | ✅     |       |
| Asteroids: a roll for each asteroid hex entered at speed > 1                                               | `engine/map.ts` → `asteroidHazards`                                                       | ✅     |       |
| "A ship passing along a hexside between two asteroid hexes is considered to have entered one asteroid hex" | `engine/map.ts` → `asteroidHazards`; `engine/geometry.ts` → `traceSegment().edgeRuns`     | ✅     |       |
| Mines and torpedoes detonate on entering an asteroid hex                                                   | `engine/ordnance.ts` → `moveOrdnancePhase`                                                | ✅     |       |
| A nuke converts an asteroid hex to clear space                                                             | `engine/types.ts` → `GameState.clearedAsteroids`; `engine/map.ts` → `isAsteroid(cleared)` | ✅     |       |
| Gunfire is neither affected by nor affects asteroids                                                       | `engine/map.ts` → `lineOfSightBlockedBy`                                                  | ✅     |       |
| "Ships which reach Clandestine drop off the detectors of the opposing side"                                | `engine/detection.ts` → `hiddenAtClandestine`                                             | ✅     |       |

## p. 7 — Bases

| Rule                                                                                                                                          | Where                                                                                                      | Status | Notes                                                                                                                                  |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| Bases printed on the map; scenarios set ownership                                                                                             | `engine/state.ts` → `createInitialState`; `engine/map.ts` → `allPlanetaryBases`, `allAsteroidBases`        | ✅     | Geography from the chart, ownership from the scenario.                                                                                 |
| Planetary bases: detection, defence fire, fuel, maintenance                                                                                   | `engine/detection.ts`, `engine/combat.ts` → `firePlanetaryDefence`, `engine/logistics.ts` → `resupply`     | ✅     |                                                                                                                                        |
| Base sides: Io and Callisto one each, Mercury two, Terra/Luna/Mars/Venus all six                                                              | `engine/mapdata.ts` → `AstralBody.baseSides`                                                               | ✅     |                                                                                                                                        |
| Asteroid bases: ordinary functions, no planetary defences, one torpedo per turn                                                               | `engine/types.ts` → `BaseState.hasPlanetaryDefences`; `engine/ordnance.ts` → `launchBaseTorpedo`           | ✅     | The base itself is the launcher, drawing on the "unlimited supply" p. 8 gives it; `BaseState.launchedThisTurn` holds it to one a turn. |
| "They may not be harmed except by a nuke"                                                                                                     | `engine/ordnance.ts` → `detonate`                                                                          | ◐      | Enforced by nothing else being able to target a base; a scenario that varies this rule has to say so.                                  |
| "Ships at asteroid bases may attack and be attacked normally"                                                                                 | `engine/combat.ts` → `immuneToGunfire`                                                                     | ✅     | Only _landed_ ships are immune.                                                                                                        |
| Orbital bases: bought in play, carried by transport or packet, placed in a gravity hex from orbit or on a bare hexside; cannot be moved again | `engine/logistics.ts` → `emplaceEquipment`                                                                 | ✅     | Emplacement writes both records: the `BaseState` that supplies, and the counter that carries its combat strength of 16.                |
| "The base remains in that gravity hex; it does not literally orbit"                                                                           | `engine/movement.ts` → `isFixedInstallation`                                                               | ✅     | An orbital-base counter neither plots, coasts nor falls; the gravity it sits in does not pull it down.                                 |
| An orbital base fires one torpedo a turn, "providing resupply operations are not in progress"                                                 | `engine/ordnance.ts` → `canLaunchBaseTorpedo`; `engine/logistics.ts` → `resupply`                          | ✅     | Enforced both ways within the player-turn.                                                                                             |
| Clandestine: secret, unattackable, ringed by dense asteroids only scanner-equipped ships may enter                                            | `engine/mapdata.ts` → `CLANDESTINE_CORDON`; `engine/movement.ts` → `denseAsteroidsOnCourse`, `hasScanners` | ✅     | The owner's ships have scanners automatically; others are destroyed.                                                                   |
| The owner's mines and torpedoes are unaffected by the special asteroids                                                                       | `engine/ordnance.ts` → dense-asteroid handling                                                             | ✅     | Others detonate harmlessly.                                                                                                            |

## p. 8 — Resupply, defences, and the rest

| Rule                                                                                                                                               | Where                                                                                                           | Status | Notes                                                                                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Matching courses with a base: land on the hexside, orbit over it, stop in an asteroid hex, or share an orbital base's hex                          | `engine/logistics.ts` → `canResupplyAt`                                                                         | ✅     |                                                                                                                                                                   |
| Unlimited fuel, mines and torpedoes at any base                                                                                                    | `engine/logistics.ts` → `resupply`, `RESUPPLY_ORDNANCE`                                                         | ✅     | Nukes are never restocked from the base's "unlimited supply of fuel, mines, and torpedoes".                                                                       |
| Refuelling implies maintenance: repairs all damage, restores the overload, reloads any mix that fits the hold                                      | `engine/logistics.ts` → `maintain`, `resupply`                                                                  | ✅     |                                                                                                                                                                   |
| "No ship may fire its guns or launch ordnance during a player-turn in which it resupplies"                                                         | `engine/types.ts` → `Ship.resuppliedThisTurn`; `engine/combat.ts` → `canFire`                                   | ◐      | Enforced in both directions: a ship that has already fired may not resupply. Since resupply is the last phase, that is the only way to enforce the rule forwards. |
| An orbital base that resupplies may not fire or launch that player-turn                                                                            | `engine/types.ts` → `BaseState.resuppliedThisTurn`                                                              | ✅     |                                                                                                                                                                   |
| Planetary defences: 2:1 into the gravity hex directly above the hexside, no range or velocity modifiers                                            | `engine/combat.ts` → `firePlanetaryDefence`                                                                     | ✅     | All other gunfire rules apply, counterattack included.                                                                                                            |
| Torch ships may not transfer fuel to other ships                                                                                                   | `engine/logistics.ts` → `transferCargo`                                                                         | ✅     |                                                                                                                                                                   |
| Transfer requires matched courses (same position _and_ same velocity)                                                                              | `engine/logistics.ts` → `coursesMatched`, `matchedShips`                                                        | ✅     | Looting, rescue, capture and transfer all use it.                                                                                                                 |
| Only disabled or surrendered ships may be looted; eliminated ships may not                                                                         | `engine/logistics.ts` → `loot`                                                                                  | ✅     |                                                                                                                                                                   |
| Capture: a disabled ship, by an enemy that matches courses; must reach a base friendly to the captor; may not fire or return fire                  | `engine/logistics.ts` → `capture`; `engine/types.ts` → `Ship.capturedBy`; `engine/movement.ts` → `controllerOf` | ✅     |                                                                                                                                                                   |
| Surrender is binding; both parties agree not to attack; the ship keeps fuel enough to reach a friendly base; surrendered ships may not be captured | `engine/logistics.ts` → `demandSurrender`, `respondToSurrender`, `surrenderFuelReserve`                         | ◐      | The bargain is enforced mechanically (neither may fire on the other); the negotiation itself is between the players.                                              |
| Detectors: 3 hexes for ships and orbital bases, 5 for planetary bases                                                                              | `engine/map.ts` → `DETECTION_RANGE_SHIP`, `DETECTION_RANGE_PLANETARY_BASE`                                      | ✅     |                                                                                                                                                                   |
| "Once a ship has been detected… it remains detected until it arrives at a friendly base"                                                           | `engine/detection.ts` → `updateDetection`; `engine/types.ts` → `Ship.detectedBy`                                | ✅     |                                                                                                                                                                   |
| Heroism: attacking at worse than 1:1 and getting D2 or better; +1 forever; once only                                                               | `engine/combat.ts` → heroism check in `applyDamage`; `engine/types.ts` → `Ship.heroic`                          | ✅     |                                                                                                                                                                   |
| "Any ship whose final course places it off the map is considered eliminated"; the projected course may leave                                       | `engine/movement.ts` → `executeMovementPhase`; `engine/map.ts` → `inBounds`                                     | ✅     |                                                                                                                                                                   |
| Cargo capacity in tons; an item may not be split between ships; fuel is not cargo                                                                  | `engine/logistics.ts` → `cargoMass`, `canCarry`; `engine/ships.ts` → `CARGO`                                    | ✅     |                                                                                                                                                                   |
| Non-warships carry only one nuke; only a transport may carry an orbital base                                                                       | `engine/ships.ts` → `nukeLimit`; `engine/logistics.ts` → `emplaceEquipment`                                     | ◐      | The rulebook says "only a transport" on p. 8 and "a transport or packet" on p. 7; the p. 7 wording is implemented, being the more specific of the two.            |

## p. 9 — Prices

| Rule                                                                                              | Where                                                       | Status | Notes                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| MegaCredit costs for ships and equipment                                                          | `engine/ships.ts` → `SHIP_CLASSES[].cost`, `CARGO[].cost`   | ✅     |                                                                                                                                                                                                              |
| Purchasing ships and equipment                                                                    | `engine/logistics.ts` → `purchaseShip`, `purchaseEquipment` | ✅     | Scenarios restrict the buyable classes through `scenarioData.purchasableClasses`.                                                                                                                            |
| Combat strength point system (D-suffix ships cost half: a liner 1 point, a transport or tanker ½) | —                                                           | ○      | Not mechanised. The scenarios that use it (Nova, Retribution, Fleet Mutiny) fix their fleets at build time in `src/scenarios/`, so the arithmetic happens once, on paper, rather than in a point-buy screen. |
| "Fuel is too cheap to keep track of… i.e., free" unless the scenario prices it                    | `engine/logistics.ts` → `FUEL_PRICE`, `resupply`            | ✅     |                                                                                                                                                                                                              |

## p. 9–13 — Scenarios

All ten of the rulebook's scenarios ship. Each is one file in `src/scenarios/`
implementing the `ScenarioDef` contract in `scenarios/types.ts` (`build`, plus an
optional `checkVictory`); the authoritative list is `SCENARIOS` in
`src/scenarios/index.ts`. The table records the id and what each one needs beyond
the core rules.

| Scenario            | p.    | Id                   | Special machinery it needs                                                                                                                                                                     |
| ------------------- | ----- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bi-Planetary        | 9     | `bi-planetary`       | Fewest turns to the other world.                                                                                                                                                               |
| Grand Tour, 2037 AD | 9     | `grand-tour`         | Visit one gravity hex of every full-gravity body, return and land; the combat ban is a _social_ rule (▣).                                                                                      |
| Escape              | 9–10  | `escape`             | Hidden fugitive transport, decoys revealed only by inspection, four victory levels.                                                                                                            |
| Lateral 7           | 10    | `lateral-7`          | Dummy counters, inverted setup. The dreadnaught's release condition is recorded in `scenarioData` and _not_ enforced (◐, see Known gaps).                                                      |
| Piracy              | 10–11 | `piracy`             | Three players, patrol circuits, points for kills and loots, point-priced purchases. Delivery cycles are _not_ modelled (◐, see Known gaps).                                                    |
| Nova                | 11    | `nova`               | Colony rolls, alien entry along the Jupiter edge, nova bomb in solar orbit.                                                                                                                    |
| Retribution         | 11–12 | `retribution`        | Corvettes released one at a time (`endPlayerTurn`), ordnance only to the Enforcers and only from Terra. Terra crashes and the Freedom Fleet conversion are _not_ modelled (◐, see Known gaps). |
| Fleet Mutiny        | 12    | `fleet-mutiny`       | Rebellion rolls, hexside suppression (`engine/combat.ts` → `suppressHexside`), base capture by landing (`engine/logistics.ts` → `captureBasesByLanding`).                                      |
| Interplanetary War  | 12    | `interplanetary-war` | MCr budgets, base income (`endPlayerTurn`), purchase only at a world the player controls, devastation counts. Physical transport of Terran MCr is _not_ modelled (◐).                          |
| Prospecting         | 13    | `prospecting`        | Ore and CT shards (`engine/logistics.ts` → `runProspecting`, `mineOre`, `emplaceEquipment`, `sellCargo`).                                                                                      |

Scenario-specific rules ride in `GameState.scenarioData` rather than in the
engine, so no scenario can change the rules for another.

## p. 13–15 — Campaign

| Rule                                                                                      | Where | Status | Notes                                                                                                                                                                              |
| ----------------------------------------------------------------------------------------- | ----- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Roles: pirates, merchants, prospectors, the Patrol; budgets, prize ships, delivery cycles | —     | ○      | Not implemented. The campaign is a framework for a refereed table rather than a rules module; the pieces it needs (purchases, looting, capture, prospecting, detection) all exist. |
| Referee powers, trade regulation, political climate, secret combat results                | —     | ▣      | Table rules by construction.                                                                                                                                                       |

## p. 15 — Orbital bases variant

| Rule                                                                                                                         | Where                                                 | Status | Notes                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Every planetary base has a highly developed orbital base overhead": refuel by passing over in orbit, deliver cargo to orbit | `engine/types.ts` → `GameOptions.orbitalBasesVariant` | ○      | The option exists and the scenario picker offers it, but no engine module reads it yet. Note that resupply-by-orbit is already the _standard_ rule (p. 8); what the variant adds is cargo delivery without landing. |

## p. 16 — Advanced combat system

| Rule                                                                           | Where                                                                          | Status | Notes |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ | ------ | ----- |
| Two rolls per attack: to-hit, then damage location                             | `engine/crt.ts` → `GUN_TO_HIT`, `OTHER_TO_HIT`, `hitLocation`                  | ✅     |       |
| Damage split across weapon, drive and structure                                | `engine/types.ts` → `AdvancedDamage`; `engine/combat.ts` → `applyAdvancedHits` | ✅     |       |
| Any weapon damage stops guns and ordnance; dreadnaught exception at D1–D3      | `engine/combat.ts` → `weaponsOperational`, `canFire`                           | ✅     |       |
| Weapon hits on civilian ships only prevent mine-laying                         | `engine/combat.ts` → `weaponsOperational`                                      | ✅     |       |
| Weapons at D6 or below cannot be repaired outside a base                       | `engine/combat.ts` → `weaponsUnrepairable`                                     | ✅     |       |
| Any drive damage stops manoeuvre; drive at D6 or below is lost at the map edge | `engine/combat.ts` → `canManeuver`, `driveDoomed`; `engine/movement.ts`        | ✅     |       |
| Structure at D6 or below destroys the ship                                     | `engine/combat.ts` → `applyAdvancedHits`                                       | ✅     |       |
| One D recovered per turn, owner's choice of track                              | `engine/combat.ts` → `recoverDamage`                                           | ✅     |       |
| "A ship which reaches a base is immediately restored to full operating status" | `engine/logistics.ts` → `maintain`                                             | ✅     |       |
| Lootable only if it can neither manoeuvre nor fire                             | `engine/combat.ts` → `isDisabled`                                              | ✅     |       |

---

## Movement, verified rule by rule

`tests/movement.test.ts` is written against the rulebook's clauses rather than
against the implementation, so a test that merely restates what the code already
does would be worthless there. Each case quotes the clause it enforces.

| Rule           | Clause                                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------------------------- |
| Coasting       | "will move as it did in the previous turn, in the same direction, and traveling an equal distance"            |
| Fuel           | "One fuel point allows a ship to alter its predicted course by one hex in any direction"                      |
| Velocity       | "A straight line from the ship's original position to the new endpoint represents the ship's velocity"        |
| Braking        | "This may result in turning, speeding up, or slowing down" -- one hex of speed per turn, no one-turn reversal |
| Dry tanks      | "further acceleration (except by gravity) is impossible"                                                      |
| Overload       | two points, two hexes, warships only, "one overload maneuver between maintenance stopovers"                   |
| Gravity        | "takes effect on the turn after an object enters"; "cumulative and mandatory"                                 |
| Weak gravity   | first of a consecutive run optional, "the second and later hexes have the effect of full gravity hexes"       |
| Orbits         | one hex per turn between adjacent gravity hexes, held for every full-gravity body without fuel                |
| Crashes        | "must intersect the printed image of the astral body itself" -- clipping the hex is not a crash               |
| Squeezing past | "A ship which passes between a gravity hex and the planetary outline is affected by the gravity hex"          |
| Chart edge     | "Any ship whose final course places it off the map is considered eliminated"                                  |
| Takeoff        | free boosters, one hex, "leaving the ship stationary"; falls back "unless fuel is spent on the next turn"     |
| Orbit entry    | "the ship may enter clockwise or counter-clockwise orbit" -- exactly two of six burns, opposite senses        |
| Landing        | "one fuel point while in orbit"; asteroids "by simply stopping in the hex"                                    |
| Ramming        | "must pass through the center of the hex"; "results apply to both ships"; one target per turn                 |
| Asteroids      | rolled only above speed 1, never re-rolling the hex a course starts in                                        |
| Disablement    | "It may only drift on its current course"                                                                     |

### Two clauses worth their own note

**Reversing.** There is no one-turn reversal, but retrograde burning is
ordinary and explicitly permitted -- "slowing down" is one of the three listed
outcomes of a burn. Shedding speed N costs N turns and N fuel points. The Escape
scenario depends on precisely this arithmetic when it asks for "sufficient fuel
remaining to make a dead stop, plus one fuel point": that phrase only means
anything if stopping costs a point per hex of speed.

**Squeezing past a planet.** A body's disc is smaller than its hex, so a course
can cross the hex without touching the disc and without crashing. The rulebook
closes the obvious exploit -- threading the gap to dodge the pull -- with "a
ship which passes between a gravity hex and the planetary outline is affected by
the gravity hex". Here that holds by construction: the gravity ring completely
encloses the body, so no course reaches the body's hex without entering it.

## Known gaps

These are the honest ones. Nothing else in the rulebook is silently missing.

1. **Fog of war is presentation, not security** (`GameOptions.fogOfWar`). Every
   client computes the whole state from the command log, so hidden information
   depends on players not looking. Making it real needs a server that filters per
   player — see [MULTIPLAYER.md](MULTIPLAYER.md#fog-of-war-needs-a-server).
2. **The orbital bases variant (p. 15) is declared but not implemented.** The
   option is offered in the scenario picker and read by nothing.
3. **The campaign game (p. 13–15) is not mechanised.** Its economy is refereed by
   design; the underlying rules it leans on are all present.
4. **Asteroid hazards resolve at the end of the movement phase**, not during the
   combat phase as the sequence of play lists them. The outcome is identical
   except in the log's ordering.
5. **Nuke hexside selection is geometric**, not a choice offered to the victim:
   "If it is not clear which hex side has been affected, the suffering player
   makes the choice." Deterministic, and never worse for the suffering player
   than the rule allows.
6. **Referee options (p. 15), including secret combat results, are not
   implemented.** The full log is visible to everyone at the table.
7. **There is no point-buy screen** for the combat strength point system (p. 9).
   Scenario fleets are fixed at build time; the purchases that happen _during_ a
   game are implemented (`logistics.purchaseShip`), in MegaCredits or in points,
   whichever the scenario prices in.
8. **The p. 9 equipment catalogue and the ore market have no command.**
   `logistics.purchaseEquipment` and `logistics.sellCargo` implement the printed
   prices but are not in the `Command` union and have no UI, so in a Prospecting
   game a miner can dig ore and never sell it, and can never buy PM grapples,
   scanners, robot guards or a second automated mine. Consequences: "If the ship
   is equipped with PM grapples, the shard may be picked up and sold, or left for
   later" is unreachable — every shard explodes — and with it the missing check on
   handing a shard to a ship without grapples; "Nukes are available only if the
   scenario specifies" is unenforced in the shop, which no player can reach; and a
   shard "left for later" is written to a map nothing reads.
9. **MegaCredits are not cargo any command can create.** `CARGO.megacredits` has
   the printed mass of one ton per MCr, but nothing mints, transfers-in or banks
   them, so Interplanetary War's "The Terran player must physically transport all
   MCr to Terra before they may be used… only in commercial ships" is recorded in
   `scenarioData` and not modelled — and neither is the restriction to commercial
   hulls that goes with it.
10. **Piracy's delivery cycles are not modelled.** "The Merchant earns 2 points for
    each cargo delivered", the announce-at-take-off destination, and the cycle
    rollover ("once a planet has received a cargo, it may not get another cargo
    until all worlds have received a cargo in that cycle") need a cargo-and-
    destination command surface the engine does not have. Points for destroyed
    pirate hulls, for merchant hulls lost, and for merchant ships looted _are_
    scored (`piracy.ts` → `endPlayerTurn`), and ships are bought with them, but
    the Pirates' "8 points in a single trade cycle" victory cannot fire and the
    Merchant's growth to six hulls has no income behind it.
11. **Lateral 7's dreadnaught may move before a pirate is detected.** "The
    dreadnaught, however, may not move until a pirate is detected by a ship or a
    base" is recorded as `scenarioData.dreadnaughtHeldUntilContact` and enforced
    by nothing.
12. **Retribution's Terra crashes and Freedom Fleet conversion are inert.** "Each
    corvette which manages to crash into Terra… reassigns one ship to the Terra
    Security Patrol", the three-crash withdrawal, and the conversion of corvettes
    stopped at Clandestine into a doubled-strength fleet are all recorded and
    unimplemented. The corvette release itself is implemented.
13. **Nova's alien entry arc is not measured from Jupiter.** "They may enter at
    any point along the map edge closest to Jupiter" — the arc chosen sits 11–14
    hexes from Jupiter where the nearest rim hex is 7 (`helpers.ts` →
    `stepToward` breaks a hex-distance tie 60° off the true bearing). Nova's
    `checkVictory` also applies the printed _variant_ (both blocs win when the
    aliens are wiped out) rather than the base rule, which is not currently
    trackable: nothing records which side killed the last alien.
14. **Robot guards cannot be fought.** "If attacked, they have a combat value of
    2, but only for defense and counterattacks" — guards are a hex→owner map, not
    a unit, so a claim can never be jumped once guarded.
15. **The advanced system chooses which damage to repair.** "A ship recovers from
    1 D a turn… The owner chooses what kind of damage to recover from" —
    `combat.ts` → `recoverDamage` repairs drive, then weapon, then structure,
    because there is no command through which the owner could choose.
16. **A disabled orbital base still runs its pumps.** p. 6's exception names three
    things a base may do "while the base itself is slightly (D1) damaged" —
    launch torpedoes, fire guns, resupply. Guns and torpedoes stop at D2; resupply
    never does. The general prohibition it is an exception to ("A disabled ship
    cannot maneuver, launch ordnance, or attack") does not mention resupply
    either, so the stricter reading is an inference rather than a printed rule.
17. **"Weapon hits on civilian ships have no effect except to prevent their
    launching mines" (p. 16) is read two ways.** `combat.ts` reads it strictly — a
    packet with weapon damage still fires its guns — while `ordnance.ts` reads
    "mines" as shorthand for ordnance and stops a weapon-damaged civilian
    launching anything, nukes included. Both readings are defensible; they are not
    both defensible at once, and whichever the project settles on, both sites have
    to move together. Reachable only with the advanced system and the nuke variant
    both switched on.
18. **Combat decides sides by `owner`, not `controllerOf`.** Everywhere else a
    captured prize fights for its captor until it is redeemed at his base
    (`movement.ts` → `controllerOf`); `combat.ts` → `enemyOf` reads `ship.owner`,
    so for the length of the transit a prize is an enemy of its captor and a
    friend of the fleet it was taken from. p. 8 says a captured ship "may not fire,
    or return fire if fired upon", which presupposes its being fired upon by the
    side that lost it.

## Auditing this document

Every claim above is checkable:

```bash
# Find the implementation of a rule, and the rulebook phrase quoted beside it.
grep -rn "closest approach" src/engine/
# Run the rules tests.
npm test
```

If a row here disagrees with the code, the code is what the game does — fix the
row, or fix the code, and say which in the commit message.
