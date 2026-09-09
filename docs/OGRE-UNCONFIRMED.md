# Numbers to check against the printed game

Every value in the Ogre engine that was set from the _shape_ of a rule rather
than its text, in one list, with what the code assumes now and where the real
answer lives. Write the printed value in the last column and hand it back; each
one is a one-line change plus a test.

Nothing here is a guess about how a rule _works_ — the mechanics are
implemented and tested. These are only magnitudes: an attack strength, a
defence, a movement allowance, a victory value. A wrong number here makes the
game play differently, never incorrectly.

The companion file is `docs/OGRE-RULES-MAPPING.md`, which says where each rule
is implemented. This one says only what is unconfirmed.

---

## If you only look up five things

These are the ones that can reach a game today and change how it plays:

1. **The Train's defence, size and victory value** — The Train scenario fields
   it, so these are live now.
2. **The cruise missile's flight, defence and blast** (§10) — the Missile
   Crawler is in the battle builder.
3. **The minefield's attack strength** (13.04) — a builder option.
4. **The Superheavy's record sheet** (13.07) — a builder option, and the sheet
   changes how a Superheavy dies.
5. **The dummy counter's movement** (13.06) — a builder option; too fast and a
   dummy gives itself away, too slow and it cannot bluff.

The Laser and the Laser Tower are at the bottom of the list on purpose:
they are implemented, but nothing in the game currently puts one on the board,
so their numbers cannot affect a game until a scenario or the builder offers
them.

---

## 1. Counter faces

One line each, from the counter sheet or the unit summary. "Code now" is what
the engine uses today.

| Counter                         | Value          | Code now | Correct value |
| ------------------------------- | -------------- | -------- | ------------- |
| **Train** (TRAIN)               | Defence        | 3        |               |
|                                 | Size           | 5        |               |
|                                 | Victory points | 12       |               |
|                                 | Squads carried | 6        |               |
| **Missile Crawler** (MCRL)      | Defence        | 2        |               |
|                                 | Movement       | 2        |               |
| **Crawler** (CRL, a fired MCRL) | Defence        | 2        |               |
|                                 | Movement       | 2        |               |
| **Truck** (TK)                  | Movement       | 4        |               |
|                                 | Victory points | 6        |               |
| **Hovertruck** (HT)             | Movement       | 4        |               |
|                                 | Second move    | 3        |               |
|                                 | Defence        | 0        |               |
| **Light Artillery Drone** (LAD) | Victory points | 6        |               |
| **Dummy** (13.06)               | Movement       | 3        |               |
| **Command Post** (CP)           | Size           | 1        |               |
| **Laser** (LSR)                 | Attack         | 3        |               |
|                                 | Defence        | 2        |               |
|                                 | Victory points | 12       |               |
| **Laser Tower** (LTWR)          | Attack         | 3        |               |
|                                 | Defence        | 4        |               |
|                                 | Victory points | 18       |               |

The LAD's other statistics are quoted verbatim from 14.01 ("Attack 2, Range 8,
Defense 1, and Movement 0 … Size 1") and need no checking. Every other unit in
`src/ogre/engine/units.ts` carries a printed citation in its `note`.

---

## 2. Section 10 — cruise missiles

The missile is a counter that flies, can be shot down by a laser, and
detonates. All of that is implemented. The magnitudes are placeholders chosen
to sit sensibly against the Combat Results Table.

| Quantity                                            | Code now | Correct value |
| --------------------------------------------------- | -------- | ------------- |
| Hexes flown per fire phase                          | 12       |               |
| The missile's defence against an intercepting laser | 2        |               |
| Blast attack strength one hex from ground zero      | 12       |               |
| Blast attack strength two hexes from ground zero    | 6        |               |
| How far the blast reaches at all                    | 2 hexes  |               |
| Another missile lost to a detonation within         | 2 hexes  |               |

Three questions of rule rather than number, if the text answers them:

- Is everything at ground zero destroyed outright, whatever it is? The code
  says yes, and turns the hex into a crater.
- Does the blast fall off in rings as above, or by some other schedule?
- May a laser fire at a missile _and_ at a ground target in the same fire
  phase? The code lets one laser make one interception.

## 3. Section 12 — lasers

Line of sight is implemented from the text (12.02 blocked by raised terrain,
12.03 a tower fires over but not into it). Only the strengths are unknown, and
they are in the counter table above. Two open questions:

- Is a laser's range genuinely unlimited along a clear line? The code says yes
  (it stores range 99).
- Is there a limit on how often a laser fires — once a turn, or every fire
  phase like any gun? The code treats it as any other gun.

## 4. Section 13 — optional rules

| Quantity                                                          | Code now | Correct value |
| ----------------------------------------------------------------- | -------- | ------------- |
| **13.02** A bridge's defence strength as a target                 | 4        |               |
| **13.04** A minefield's attack strength against a unit            | 4        |               |
| **13.04** Tread units an Ogre loses to a minefield                | 2        |               |
| **13.04** Die roll or better for an Ogre to lose treads to a mine | 4        |               |
| **13.04** Minefields a side may lay in a scenario                 | up to 12 |               |
| **13.06** Dummy counters a side may field                         | up to 8  |               |

The last two are our own caps on the battle builder, not rules; if the section
sets a number, it replaces them.

Questions of rule:

- **13.02** An X drops a bridge and a D does nothing. Is that right, and can a
  bridge be attacked by more than one unit at once? The code allows stacking
  fire on it but no spillover.
- **13.04** Does the mover stop in the mined hex (the code says yes), and does
  the minefield stay to catch the next unit (the code says yes)?
- **13.05** Camouflage: the code reveals a concealed counter when it fires, is
  fired on, rams, is rammed, overruns, or ends either movement phase next to an
  enemy — but **not** merely for moving. Is that the printed list?

### 13.07 — the Superheavy's record sheet

The sheet exists in print; these are the numbers on it.

| Quantity                            | Code now               | Correct value |
| ----------------------------------- | ---------------------- | ------------- |
| Guns on the sheet                   | 2                      |               |
| Attack strength of one gun          | 3                      |               |
| Antipersonnel weapons               | 2                      |               |
| Tread units                         | 3                      |               |
| Movement with all three tread units | 3                      |               |
| Movement once tread units are lost  | one hex per tread left |               |

And how damage is taken. The code rolls a die for an X: 1-2 a gun, 3-4 a tread
unit, 5-6 an antipersonnel weapon, moving to the next kind when that one is
spent; a D takes a tread unit; the tank is destroyed once it has neither a gun
nor a tread unit. If the printed sheet allocates damage differently, that is
the thing to copy out.

## 5. Section 14 — the drone

The Ninja's stealth and the LAD's statistics are implemented from quoted text.
What is missing is the deployment sequence.

- How does a LAD get where it is going? The code lets it ride a vehicle as one
  squad of infantry would.
- What does setting up cost? The code says it may not fire on the turn it
  dismounts.
- Can it move at all once down? The code says no (Movement 0, per 14.01).

## 6. Section 15 — combat engineering

The Combat Engineer counter itself is quoted from 15.01 (double victory points,
traded 2-for-1 for regular infantry) and is not in question. The tasks are.

| Quantity                               | Code now                    | Correct value |
| -------------------------------------- | --------------------------- | ------------- |
| What one task costs                    | the whole movement phase    |               |
| Defensive benefit of an entrenched hex | as forest (×2 for infantry) |               |
| Where engineers may clear a minefield  | the hex they stand in       |               |
| Where engineers may demolish a bridge  | a neighbouring hexside      |               |

Questions of rule:

- Is the list of tasks entrench / clear mines / demolish, or are there others?
- Does entrenchment benefit vehicles as well as infantry? The code gives it to
  infantry only.
- Can a task be interrupted, or undone by the other side?

### The Vulcan's work — not implemented at all

The Vulcan's two manipulator arms (defence 2, 15.02) and the unfinished-Ogre
rule (15.02.2) are in. Its **repair and salvage work is not implemented**, because
the procedure is not known here. What would be needed:

- What can the Vulcan repair, and on what — a damaged Ogre, a disabled vehicle,
  a destroyed one?
- How long does a repair take, and what does the Vulcan give up to make it?
- What can it salvage from a wreck, and what does the salvage become?
- Can it build, and if so what and how fast?

That is the one genuinely missing rule rather than a missing number, so it is
the largest single thing on this page.

---

## How to hand the answers back

Anything is fine — this file with the last column filled in, a photograph of a
page, or just a list like "Train defence 4, size 6". Each answer is a constant
in one file:

| Where                            | What lives there                               |
| -------------------------------- | ---------------------------------------------- |
| `src/ogre/engine/units.ts`       | Every counter face, and its `unconfirmed` flag |
| `src/ogre/engine/missiles.ts`    | `CRUISE_MISSILE` — §10                         |
| `src/ogre/engine/concealment.ts` | `MINEFIELD` — 13.04                            |
| `src/ogre/engine/engineering.ts` | `SUPERHEAVY_SHEET`, `SUPERHEAVY_GUN`, `BRIDGE` |
| `src/ogre/scenarios/custom.ts`   | `HIDDEN_LIMITS` — the builder's caps           |

A corrected number also means clearing that statistic from the counter's
`unconfirmed` list and replacing "placeholder" in its `note` with the citation,
so the audit in `docs/OGRE-RULES-MAPPING.md` shrinks as the answers come in.
