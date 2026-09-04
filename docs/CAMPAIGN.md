# Two games, one war

> **Superseded as the combined game by [Orbital Drop](ORBITAL-DROP.md)**,
> which plays the war as a live Triplanetary scenario rather than a separate
> strategic layer. The war room below still works — the Triplanetary scenario
> picker keeps its door — and its battle boundary (orders, tokens, the
> embedded landing) is the plumbing Orbital Drop's ground battles ride.

Two games are joined by a campaign over the inner Solar System: Triplanetary
decides who gets to the ground, and Ogre decides what happens when they land.
Both live here — `src/campaign/` holds the war's engine, `src/ogre/` the
ground game — and the war room is on the scenario screen, beside the online
play that lets a contested transfer actually be contested by somebody on
another machine. The design rationale, written before either engine consumed
it, is [docs/OGRE-HANDOFF.md](OGRE-HANDOFF.md); this document says what was
built and how to play it.

## How to play it

The start menu offers three games: **Triplanetary**, **Ogre**, and **Two
games, one war** — the campaign. (The Triplanetary scenario picker keeps a
campaign door in its foot as well, and the campaign card notes when a war is
already saved in this browser — the campaign saves itself after every order.)
The war room is hot-seat: pick whose orders you are giving, pass the
keyboard, and end the turn when both sides are done.

The war room docks beside the live chart rather than covering it: the eight
sites are pinned to their planets and moons on the inner system, each pin
carrying its holder's colour, production and garrison, pulsing while the
site is under attack. The chart still pans and zooms underneath, and
clicking a pin brings that site's card into view in the room.

- **Buying and garrisoning** happen in the war room. Prices are in production
  points; held sites pay their production at each consolidation, and two
  thirds of the map's production wins the war.
- **An offensive** commits a convoy (which must lift the landing force's
  cargo lots) and a ground force. The defender chooses: intercept, or let it
  pass. Shipping between friendly ports is below the campaign's resolution —
  only contested transfers are fought.
- **A contested transfer** is this game. Fight it at this keyboard (hot seat,
  or the computer flying either side), **host it as an online table** — quick
  or refereed, exactly like any other scenario, with the order riding the
  table's frozen setup so every joiner rebuilds the same battle — or copy the
  order token to whoever flies it elsewhere. When the transfer is decided,
  the victory screen reports the result straight back to the war room in this
  browser, and offers it as a token everywhere else.
- **A landing** is an Ogre battle — and it is fought right here too. **Fight
  it here** mounts the embedded Ogre view (see below) and the result reports
  straight back, exactly as a transfer's does. It can also be **hosted as a
  table**, and at a refereed table the referee opens one by itself the moment
  the sky freezes; the order and result tokens remain, for fighting the
  ground half on a machine that is not online. What lands is whatever tonnage
  actually got down, converted at ten tons of hold to the armour unit — a
  transport lands five armour units, and shipping a Mark V is a
  seventeen-lot convoy operation.
- **Results are read, not typed.** Survivors return to pools or become the
  new garrison; a defeated landing force is stranded and lost; delivered
  tonnage is read off the board.

Both battle scenarios are also ordinary scenarios with printed defaults —
**Contested Transfer** on this app's list, **The Landing** on Ogre's.

## What lives where

Here, under `src/campaign/`:

- `engine.ts` — the third pure engine, owning neither battle: eight off-world
  sites, two sides' pools and treasuries, one operation in flight at a time,
  its own seeded rng and command log. A campaign is its seed plus its log.
- `data.ts` — the map of objectives and the procurement tables. Ship prices
  derive from this engine's own ship table; ground prices are the campaign's
  transcription of Ogre's armour-unit costs, because the campaign owns the
  conversion between the two vocabularies and neither engine needs the other.
- `convert.ts` — the conversion table: one ten-ton lot per armour unit,
  infantry three squads to the lot, loading heaviest-first so what got ashore
  and what turned back read the same manifest.
- `session.ts` — the session facade: dispatch, undo, and a save that is a
  seed plus a log, carrying the replay of every battle fought in the war.
- `orders.ts`, `codec.ts`, `result.ts` — the battle boundary. It stays a
  boundary although both games are now in one repository, because that is what
  lets a battle be fought at an online table or on a machine with no network at
  all; the codec tests pin the wire format, which every token already issued
  depends on. The rationale is [OGRE-HANDOFF.md](OGRE-HANDOFF.md).

And under `src/ogre/`: **the ground game itself**. Its engine, renderer and
eight scenarios — Mark III Attack, Mark V Attack, The Crossing, The Landing,
the three Orbital Drop assaults and the custom battle — with its rules tests
running here under `tests/ogre/`, and its shell pruned to a mountable battle
view
(`src/ogre/ui/battle.ts`) with the application chrome removed and the ending
matched to what was fought: a _Report to the campaign_ button when a war room
in this browser is waiting, a result token for a campaign running somewhere
else, and the verdict alone for a printed scenario played from the start
menu's **Ogre** door. Its stylesheet is scoped under `.ogre-app` so the amber
palette stays inside the battle, and the whole thing is a set of code-split
chunks loaded the moment a battle (or the Ogre scenario list) is asked for —
a player who never leaves space never downloads it.

The ground game was once a separate app,
[OGRE-VTT](https://github.com/onlinemph/OGRE-VTT), whose page now forwards
here; `docs/OGRE-ARCHITECTURE.md` describes the engine it brought with it.

## The online half

A campaign battle goes online through the same doors as any scenario, with
one addition: the `OrderOfBattle` travels with the table's setup.

- **Quick table** — the order rides the frozen `setup` jsonb; every joiner
  rebuilds the opening position from it, so the boards agree by construction
  (`tests/supabase-quick-client.test.ts` proves it against the real schema).
- **Refereed table** — `CreateRequest` carries the order to the Edge
  Function, which builds and stores the opening board; a later sync recovers
  the order from the stored board's own `scenarioData` rather than a column
  of its own, because nothing in play ever rewrites it.

Whichever browser ends up with the finished game holds everything the result
needs — the order rides in `scenarioData` — so the host reports with one
button and anyone else gets the token.
