/**
 * The boundary between the campaign and a battle.
 *
 * The campaign itself lives in the companion repository
 * ([OGRE-VTT](https://github.com/onlinemph/OGRE-VTT), `src/campaign/`); what
 * lives here is this app's half of the hand-off. These two types are the whole
 * interface: a battle is *launched* with an `OrderOfBattle` and hands back a
 * `BattleResult`, and nothing else crosses. They are deliberately small — see
 * OGRE-VTT's docs/CAMPAIGN.md, which designed them before either engine
 * consumed them — and they are duplicated verbatim in both repositories rather
 * than shared, because a package the two both depend on would couple their
 * release cycles over forty lines of types. The codec (`codec.ts`) is the
 * compatibility contract, and it is tested.
 *
 * Conventions the types themselves cannot state:
 *
 *  - `sides[0]` is the attacker and moves first; `sides[1]` defends.
 *  - `forces` speaks each engine's own vocabulary. For Triplanetary that is
 *    `ShipClass` keys, plus `freight` for cargo lots (ten tons each). For
 *    Ogre it is `UnitClassId` and `OgreTypeId` keys, infantry in squads.
 *  - `terms` is free-form on purpose. A scenario reads the keys it documents
 *    and ignores the rest, which is what lets the campaign grow new terms
 *    without a lockstep change in two repositories.
 */

export interface OrderSide {
  /** The campaign's id for this combatant; it becomes the battle's PlayerId. */
  readonly player: string;
  readonly faction: string;
  /** Engine-specific unit ids with counts: 'HVY' x4, or 'destroyer' x2. */
  readonly forces: Readonly<Record<string, number>>;
}

/** What the campaign hands a battle. */
export interface OrderOfBattle {
  readonly battleId: string;
  readonly seed: number;
  readonly scenarioId: string;
  readonly sides: readonly OrderSide[];
  /** Free-form terms the scenario understands (entry edges, turn limits). */
  readonly terms: Readonly<Record<string, unknown>>;
}

/** What a battle hands back. */
export interface BattleResult {
  readonly battleId: string;
  readonly winners: readonly string[];
  readonly level: 'complete' | 'standard' | 'marginal';
  /** Per side: what walked away, in the same vocabulary as `forces`. */
  readonly survivors: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly victoryPoints: Readonly<Record<string, number>>;
  /** The whole battle, for replay: its seed and its command log. */
  readonly replay: { readonly seed: number; readonly log: readonly unknown[] };
}

/** Where a scenario finds the order it was built from. */
export const ORDER_KEY = 'order';

/**
 * The order a state was built from, if it was built from one.
 *
 * The order rides in `scenarioData` — the free-form channel the campaign
 * design told both engines to keep free-form for exactly this — so a battle
 * carries its own terms of reference, and the result reader needs nothing but
 * the state and the log.
 */
export const orderOf = (scenarioData: Readonly<Record<string, unknown>>): OrderOfBattle | null => {
  const raw = scenarioData[ORDER_KEY];
  if (typeof raw !== 'object' || raw === null) return null;
  return raw as OrderOfBattle;
};
