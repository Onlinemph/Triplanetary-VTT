# Two games, one war

This app is linked to its companion,
[OGRE-VTT](https://github.com/onlinemph/OGRE-VTT), by a campaign over the
inner Solar System: Triplanetary decides who gets to the ground, and Ogre
decides what happens when they land. **The campaign lives here** —
`src/campaign/` holds the engine, and the war room is on the scenario screen
— beside the online play that lets a contested transfer actually be contested
by somebody on another machine. The original design, written before either
engine consumed it, is
[OGRE-VTT's docs/CAMPAIGN.md](https://github.com/onlinemph/OGRE-VTT/blob/main/docs/CAMPAIGN.md);
this document says what was built and how to play it.

## How to play it

Open the scenario screen and press **Open the campaign** (it reads **Return
to the war** once one is saved in this browser — the campaign saves itself
after every order). The war room is hot-seat: pick whose orders you are
giving, pass the keyboard, and end the turn when both sides are done.

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
  straight back, exactly as a transfer's does. The **Open in the Ogre app**
  link and the order/result tokens remain, for fighting the ground half in
  the companion app or on another machine. What lands is whatever tonnage
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
- `orders.ts`, `codec.ts`, `result.ts` — the battle boundary, duplicated
  verbatim in OGRE-VTT rather than shared; the codec tests on both sides pin
  the wire format, which is the actual compatibility contract.

And under `src/ogre/`: **the companion game itself, embedded**. OGRE-VTT's
engine, renderer and The Landing are ported wholesale (imports made relative,
nothing else changed — its own rules tests run here under `tests/ogre/` to
prove it), and its shell is pruned to a mountable battle view
(`src/ogre/ui/battle.ts`) with the application chrome removed and the ending
reworked: a _Report to the campaign_ button when a war room in this browser
is waiting, a result token otherwise. Its stylesheet is scoped under
`.ogre-app` so the amber palette stays inside the battle, and the whole thing
is a code-split chunk loaded the moment a landing begins — a player who never
reaches the ground never downloads it.

In OGRE-VTT: the same boundary files, and the original of The Landing — the
standalone app remains fully playable, and remains the way to fight the
ground half on a machine that only has the Ogre app.

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
