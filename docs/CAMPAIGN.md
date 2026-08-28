# The campaign: Triplanetary's half

Two games, one war. This app is linked to its companion,
[OGRE-VTT](https://github.com/onlinemph/OGRE-VTT): a campaign over the inner
Solar System where Triplanetary decides who gets to the ground and Ogre
decides what happens when they land. The campaign itself — the map of
objectives, production, the war room — lives in the Ogre app; the full design
and its history are in
[OGRE-VTT's docs/CAMPAIGN.md](https://github.com/onlinemph/OGRE-VTT/blob/main/docs/CAMPAIGN.md).
What lives here is this app's half of the hand-off.

## How a battle arrives

A contested transfer leaves the campaign as a pasteable **order token**: the
war room shows an **Open in Triplanetary** link (this page with `?battle=` on
it), and the token can equally be sent to somebody on another machine. Opening
it offers the battle — both seats at this keyboard, or the computer flying
either side — and when the transfer is decided, the victory screen shows a
**result token** to copy back into the campaign.

The scenario behind it is **Contested Transfer** (`src/scenarios/contestedTransfer.ts`),
which is also on the ordinary scenario list with a printed default: a convoy
with the campaign's ground force in its holds sails from Terra, the defending
fleet comes out from the target world, and the only number that matters at the
end is how many ten-ton lots of freight are down on the target when every lot
is down, sunk, or out of time.

## The boundary

Three files under `src/campaign/` carry everything across, and they are
duplicated verbatim in the Ogre repository rather than shared — a package both
apps depend on would couple their release cycles over forty lines of types:

- `orders.ts` — the two boundary types, `OrderOfBattle` and `BattleResult`.
  `sides[0]` is the attacker; `forces` here speaks `ShipClass` keys plus
  `freight` for cargo lots.
- `codec.ts` — the token format (JSON, UTF-8, base64url, with a versioned
  envelope). The codec tests on both sides pin the wire format; the two copies
  _are_ the compatibility contract.
- `result.ts` — the reader that turns a finished game back into a
  `BattleResult`: survivors by hull, freight still aboard them, and delivered
  tonnage read off the board. Victory levels cross rank-for-rank —
  `decisive→complete`, `marginal→standard`, `moral→marginal`.

Nothing in the engine changed to support any of this: the order rides in
`scenarioData`, the scenario is an ordinary `ScenarioDef`, and the computer
plays the convoy through the same `targets` errand Bi-Planetary already
taught it.
