/**
 * The battle builder: a custom Ogre battle, designed at the table.
 *
 * It produces an `OrderOfBattle` — the same shape a campaign hands a battle —
 * with `scenarioId: 'custom'`, and nothing else. Local play, hosting a table
 * and reconfiguring one from its lobby all take that order and do the rest,
 * which is what lets one panel serve all three doors.
 *
 * The panel knows nothing about the Ogre engine. The unit catalogue, the map
 * preview and the pricing all arrive through `BuilderCatalogue`, assembled by
 * the shell after loading the ground game on demand, so opening the fleet
 * game never downloads the ground one.
 */

import { button, el, fill } from '../components/dom.js';
import { type Overlay, openModal } from '../components/modal.js';
import type { OrderOfBattle, OrderSide } from '@campaign/orders.js';
import type { CustomMapSpec, CustomVictory, MapKind } from '../../ogre/scenarios/custom.js';

export interface BuilderUnit {
  readonly id: string;
  readonly name: string;
  /** Cost in armour units; infantry is priced per squad. */
  readonly armorUnits: number;
}

/** Enough of a board to draw a thumbnail of it. */
export interface MapPreview {
  readonly name: string;
  readonly cols: number;
  readonly rows: number;
  /** Printed coordinates, one-based; anything absent is clear ground. */
  readonly cells: readonly {
    readonly col: number;
    readonly row: number;
    readonly terrain: string;
  }[];
  /** The cratered map's area lines, as row numbers. */
  readonly lines: { readonly north: number; readonly south: number } | null;
}

export interface BuilderPreset {
  readonly name: string;
  readonly blurb: string;
  readonly order: OrderOfBattle;
}

export interface BuilderCatalogue {
  readonly ogres: readonly BuilderUnit[];
  readonly armour: readonly BuilderUnit[];
  readonly infantry: readonly BuilderUnit[];
  readonly victories: readonly {
    readonly id: CustomVictory;
    readonly name: string;
    readonly blurb: string;
  }[];
  readonly limits: {
    readonly cols: { readonly min: number; readonly max: number };
    readonly rows: { readonly min: number; readonly max: number };
    readonly craterDensity: { readonly min: number; readonly max: number };
  };
  readonly presets: readonly BuilderPreset[];
  preview(spec: CustomMapSpec): MapPreview;
  /** "17 armour units · 6 squads · 12 counters" */
  value(forces: Readonly<Record<string, number>>): {
    readonly armorUnits: number;
    readonly squads: number;
    readonly counters: number;
  };
}

export interface BattleBuilderOpts {
  readonly catalogue: BuilderCatalogue;
  /** An order to start from: a preset, or the table's current setup. */
  readonly initial?: OrderOfBattle;
  readonly dismissible: boolean;
  newSeed(): number;
  /** Fight it here. `computer` is the side the computer plays, or null for hot seat. */
  onStart?(order: OrderOfBattle, computer: number | null): void;
  /** Open a refereed table with it. */
  onHost?(order: OrderOfBattle, computer: number | null): void;
  /** Change a table's setup from its lobby. When present, this is the only door. */
  onApply?(order: OrderOfBattle): void;
  onBack(): void;
  onClose?(): void;
}

/** The most counters one side may bring: past this the ground runs out. */
export const MAX_COUNTERS = 60;

interface DraftSide {
  faction: string;
  forces: Record<string, number>;
}

interface Draft {
  seed: number;
  map: {
    kind: MapKind;
    fresh: boolean;
    seed: number;
    cols: number | null;
    rows: number | null;
    craterDensity: number | null;
  };
  victory: CustomVictory;
  turnLimit: number | null;
  centralLimit: number | null;
  sides: [DraftSide, DraftSide];
}

const TERRAIN_COLOURS: Readonly<Record<string, string>> = {
  clear: '#5a5238',
  crater: '#17140f',
  water: '#2f5f8f',
  swamp: '#4f6a3a',
  forest: '#2f5a2f',
  town: '#8a8a80',
  rubble: '#6a6258',
};

const asInt = (v: string, fallback: number | null): number | null => {
  const n = Number(v);
  return v.trim() === '' ? fallback : Number.isFinite(n) ? Math.floor(n) : fallback;
};

/** The order's free-form terms, read the way the scenario reads them. */
const draftOf = (order: OrderOfBattle, newSeed: () => number): Draft => {
  const t = order.terms;
  const rawMap = (typeof t['map'] === 'object' && t['map'] !== null ? t['map'] : {}) as Record<
    string,
    unknown
  >;
  const kind: MapKind = rawMap['kind'] === 'gev' || t['map'] === 'gev' ? 'gev' : 'ogre';
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;
  const mapSeed = num(rawMap['seed']);
  const victory = t['victory'];
  const [a, b] = order.sides;
  const side = (s: OrderSide | undefined, faction: string): DraftSide => ({
    faction: s?.faction ?? faction,
    forces: { ...(s?.forces ?? {}) },
  });
  return {
    seed: order.seed,
    map: {
      kind,
      fresh: mapSeed !== null,
      seed: mapSeed ?? newSeed(),
      cols: num(rawMap['cols']),
      rows: num(rawMap['rows']),
      craterDensity: num(rawMap['craterDensity']),
    },
    victory:
      victory === 'breakthrough' || victory === 'attrition' || victory === 'command-post'
        ? victory
        : 'command-post',
    turnLimit: num(t['turnLimit']),
    centralLimit: num(t['centralLimit']),
    sides: [side(a, 'Paneuropean Federation'), side(b, 'North American Combine')],
  };
};

const specOf = (d: Draft): CustomMapSpec => ({
  kind: d.map.kind,
  ...(d.map.fresh ? { seed: d.map.seed } : {}),
  ...(d.map.fresh && d.map.cols !== null ? { cols: d.map.cols } : {}),
  ...(d.map.fresh && d.map.rows !== null ? { rows: d.map.rows } : {}),
  ...(d.map.fresh && d.map.kind === 'ogre' && d.map.craterDensity !== null
    ? { craterDensity: d.map.craterDensity }
    : {}),
});

/** The order the draft describes. Player ids are fixed; factions are the players' words. */
export const orderOf = (d: Draft, battleId: string): OrderOfBattle => ({
  battleId,
  seed: d.seed,
  scenarioId: 'custom',
  sides: [
    {
      player: 'attacker',
      faction: d.sides[0].faction.trim() || 'Attacker',
      forces: trimmed(d.sides[0].forces),
    },
    {
      player: 'defender',
      faction: d.sides[1].faction.trim() || 'Defender',
      forces: trimmed(d.sides[1].forces),
    },
  ],
  terms: {
    map: specOf(d),
    victory: d.victory,
    ...(d.turnLimit !== null && d.turnLimit > 0 ? { turnLimit: d.turnLimit } : {}),
    ...(d.map.kind === 'ogre' && d.centralLimit !== null && d.centralLimit > 0
      ? { centralLimit: d.centralLimit }
      : {}),
  },
});

const trimmed = (forces: Record<string, number>): Record<string, number> =>
  Object.fromEntries(Object.entries(forces).filter(([, n]) => n > 0));

/** Why the draft cannot be fought yet, or null. */
export const problemWith = (d: Draft, cat: BuilderCatalogue): string | null => {
  for (const [i, s] of d.sides.entries()) {
    const v = cat.value(s.forces);
    if (v.counters === 0) return `${i === 0 ? 'The attacker' : 'The defence'} has no units.`;
    if (v.counters > MAX_COUNTERS) {
      return `${i === 0 ? 'The attacker' : 'The defence'} has ${v.counters} counters; the ground holds ${MAX_COUNTERS}.`;
    }
  }
  return null;
};

// ---------------------------------------------------------------------------

export const openBattleBuilder = (host: HTMLElement, o: BattleBuilderOpts): Overlay => {
  const cat = o.catalogue;
  const first = o.initial ?? cat.presets[0]?.order;
  if (!first) throw new Error('the battle builder needs a preset or an order to start from');
  let draft = draftOf(first, o.newSeed);
  let computer: number | null = null;
  const battleId = (): string => `custom-${draft.seed}-${Date.now().toString(36)}`;

  const settings = el('div', { class: 'builder-settings' });
  const forces = el('div', { class: 'builder-forces' });
  const foot = el('p', { class: 'hint builder-problem' });
  const body = el('div', { class: 'builder' }, settings, forces, foot);

  const finish = (door: 'start' | 'host' | 'apply'): void => {
    const problem = problemWith(draft, cat);
    if (problem !== null) {
      foot.textContent = problem;
      return;
    }
    const order = orderOf(draft, battleId());
    overlay.close();
    if (door === 'start') o.onStart?.(order, computer);
    else if (door === 'host') o.onHost?.(order, computer);
    else o.onApply?.(order);
  };

  const actions = o.onApply
    ? [
        { label: 'Keep the table as it is', variant: 'ghost' as const, onClick: o.onBack },
        {
          label: 'Change the setup',
          variant: 'primary' as const,
          closes: false,
          onClick: () => finish('apply'),
        },
      ]
    : [
        { label: 'All games', variant: 'ghost' as const, onClick: o.onBack },
        ...(o.onHost
          ? [
              {
                label: 'Host a table',
                variant: 'quiet' as const,
                closes: false,
                onClick: () => finish('host'),
              },
            ]
          : []),
        ...(o.onStart
          ? [
              {
                label: 'Take the field',
                variant: 'primary' as const,
                closes: false,
                onClick: () => finish('start'),
              },
            ]
          : []),
      ];

  const overlay = openModal(host, {
    title: o.onApply ? 'Change the setup' : 'Custom battle',
    subtitle: o.onApply
      ? 'Everyone in the lobby sees the new terms; the board is rebuilt when the table begins'
      : 'Any forces, either board, three ways to win',
    body,
    width: 'wide',
    dismissible: o.dismissible,
    ...(o.onClose ? { onClose: o.onClose } : {}),
    actions,
  });

  // --- Pieces -------------------------------------------------------------

  const chips = <T extends string | number | null>(
    label: string,
    choices: readonly { value: T; label: string; title?: string }[],
    current: T,
    pick: (v: T) => void,
  ): HTMLElement =>
    el(
      'div',
      { class: 'chips seat-chips' },
      el('span', { class: 'sel-label', text: label }),
      ...choices.map((c) =>
        button({
          label: c.label,
          variant: current === c.value ? 'primary' : 'quiet',
          ...(c.title ? { title: c.title } : {}),
          onClick: () => {
            pick(c.value);
            draw();
          },
        }),
      ),
    );

  const numberField = (
    label: string,
    value: number | null,
    hint: string,
    onChange: (n: number | null) => void,
    attrs: Record<string, string> = {},
  ): HTMLElement =>
    el(
      'label',
      { class: 'seed-row' },
      el('span', { class: 'seed-label', text: label }),
      el('input', {
        class: 'seed-input mono',
        type: 'number',
        value: value === null ? '' : String(value),
        placeholder: hint,
        'aria-label': label,
        ...attrs,
        oninput: (ev: Event) => onChange(asInt((ev.target as HTMLInputElement).value, null)),
      }),
    );

  const stepper = (unit: BuilderUnit, side: DraftSide, squads: boolean): HTMLElement => {
    const n = side.forces[unit.id] ?? 0;
    const set = (next: number): void => {
      side.forces[unit.id] = Math.max(0, next);
      draw();
    };
    const cost = squads
      ? `${(unit.armorUnits * 3).toFixed(0)} squads per armour unit`
      : `${unit.armorUnits} armour unit${unit.armorUnits === 1 ? '' : 's'}`;
    return el(
      'div',
      { class: `stepper unit-step${n > 0 ? ' is-on' : ''}`, title: cost },
      el('span', { class: 'stepper-label', text: unit.name }),
      el('span', { class: 'unit-cost mono', text: squads ? '⅓' : String(unit.armorUnits) }),
      button({ label: '−', class: 'step-btn', variant: 'quiet', onClick: () => set(n - 1) }),
      el('span', { class: 'stepper-value mono', text: String(n) }),
      button({ label: '+', class: 'step-btn', variant: 'quiet', onClick: () => set(n + 1) }),
    );
  };

  const drawPreview = (canvas: HTMLCanvasElement, p: MapPreview): void => {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    // Flat-top hexes in columns; odd columns sit half a row lower, the way
    // the engine's offset coordinates say.
    const dx = w / (p.cols + 0.5);
    const dy = h / (p.rows + 0.5);
    const r = Math.min(dx, dy) * 0.55;
    const at = (col: number, row: number): [number, number] => [
      (col - 0.5) * dx + dx * 0.25,
      (row - 0.5) * dy + (col % 2 === 0 ? dy / 2 : 0) + dy * 0.25,
    ];
    ctx.fillStyle = TERRAIN_COLOURS['clear'] ?? '#555';
    for (let col = 1; col <= p.cols; col++) {
      for (let row = 1; row <= p.rows; row++) {
        const [x, y] = at(col, row);
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    for (const c of p.cells) {
      const [x, y] = at(c.col, c.row);
      ctx.fillStyle = TERRAIN_COLOURS[c.terrain] ?? '#777';
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    // Where each side sets up: a tint, so the shape of the fight is visible.
    ctx.globalAlpha = 0.18;
    if (p.lines) {
      ctx.fillStyle = '#5b9bd5';
      ctx.fillRect(0, at(1, p.lines.south)[1] + dy / 4, w, h);
      ctx.fillStyle = '#d94f4f';
      ctx.fillRect(0, 0, w, at(1, p.lines.south)[1] - dy / 4);
    } else {
      const strip = Math.max(2, Math.round(p.cols / 5));
      const line = Math.round(p.cols / 3);
      ctx.fillStyle = '#5b9bd5';
      ctx.fillRect(0, 0, at(strip, 1)[0] + dx / 2, h);
      ctx.fillStyle = '#d94f4f';
      ctx.fillRect(at(line, 1)[0] - dx / 4, 0, w, h);
    }
    ctx.globalAlpha = 1;
  };

  // --- Draw ---------------------------------------------------------------

  const draw = (): void => {
    const d = draft;
    const preview = cat.preview(specOf(d));
    const canvas = el('canvas', {
      class: 'map-preview',
      width: '300',
      height: '220',
      'aria-label': `${preview.name}, ${preview.cols} by ${preview.rows}`,
    }) as HTMLCanvasElement;
    const victory = cat.victories.find((v) => v.id === d.victory);

    fill(
      settings,
      el(
        'div',
        { class: 'scenario-options builder-block' },
        el('h3', { class: 'sect-title', text: 'Start from' }),
        el(
          'div',
          { class: 'chips seat-chips' },
          ...cat.presets.map((p) =>
            button({
              label: p.name,
              variant: 'quiet',
              title: p.blurb,
              onClick: () => {
                const seed = draft.seed;
                draft = { ...draftOf(p.order, o.newSeed), seed };
                draw();
              },
            }),
          ),
        ),
      ),
      el(
        'div',
        { class: 'scenario-options builder-block' },
        el('h3', { class: 'sect-title', text: 'The board' }),
        chips(
          'Map',
          [
            {
              value: 'ogre',
              label: 'Cratered',
              title: 'The orange board: craters, no stacking, ramming',
            },
            {
              value: 'gev',
              label: 'Green',
              title: 'The green board: towns, forest, a river, stacking and overruns',
            },
          ],
          d.map.kind,
          (v) => {
            d.map.kind = v;
          },
        ),
        chips(
          'Board',
          [
            {
              value: 0,
              label: 'The stock board',
              title: 'The board every other scenario plays on',
            },
            {
              value: 1,
              label: 'A fresh one',
              title: 'Generated from a seed: a battlefield nobody has seen',
            },
          ],
          d.map.fresh ? 1 : 0,
          (v) => {
            d.map.fresh = v === 1;
          },
        ),
        d.map.fresh
          ? el(
              'div',
              { class: 'builder-mapopts' },
              el(
                'label',
                { class: 'seed-row' },
                el('span', { class: 'seed-label', text: 'Map seed' }),
                el('input', {
                  class: 'seed-input mono',
                  type: 'number',
                  value: String(d.map.seed),
                  'aria-label': 'Map seed',
                  oninput: (ev: Event) => {
                    const n = asInt((ev.target as HTMLInputElement).value, null);
                    if (n !== null) {
                      d.map.seed = n;
                      drawPreview(canvas, cat.preview(specOf(d)));
                    }
                  },
                }),
                button({
                  label: 'Roll',
                  variant: 'quiet',
                  title: 'Another battlefield',
                  onClick: () => {
                    d.map.seed = o.newSeed();
                    draw();
                  },
                }),
              ),
              numberField(
                'Columns',
                d.map.cols,
                `${preview.cols}`,
                (n) => {
                  d.map.cols =
                    n === null
                      ? null
                      : Math.max(cat.limits.cols.min, Math.min(cat.limits.cols.max, n));
                  drawPreview(canvas, cat.preview(specOf(d)));
                },
                { min: String(cat.limits.cols.min), max: String(cat.limits.cols.max) },
              ),
              numberField(
                'Rows',
                d.map.rows,
                `${preview.rows}`,
                (n) => {
                  d.map.rows =
                    n === null
                      ? null
                      : Math.max(cat.limits.rows.min, Math.min(cat.limits.rows.max, n));
                  drawPreview(canvas, cat.preview(specOf(d)));
                },
                { min: String(cat.limits.rows.min), max: String(cat.limits.rows.max) },
              ),
              d.map.kind === 'ogre'
                ? el(
                    'label',
                    { class: 'seed-row' },
                    el('span', { class: 'seed-label', text: 'Craters' }),
                    el('input', {
                      class: 'builder-range',
                      type: 'range',
                      min: String(cat.limits.craterDensity.min * 100),
                      max: String(cat.limits.craterDensity.max * 100),
                      value: String(Math.round((d.map.craterDensity ?? 0.13) * 100)),
                      'aria-label': 'Crater density',
                      oninput: (ev: Event) => {
                        d.map.craterDensity = Number((ev.target as HTMLInputElement).value) / 100;
                        drawPreview(canvas, cat.preview(specOf(d)));
                      },
                    }),
                  )
                : null,
            )
          : null,
        canvas,
        el('p', {
          class: 'hint',
          text: `${preview.name}: ${preview.cols} × ${preview.rows}. Blue is where the attacker sets up, red the defence.`,
        }),
      ),
      el(
        'div',
        { class: 'scenario-options builder-block' },
        el('h3', { class: 'sect-title', text: 'Victory' }),
        chips(
          'Win by',
          cat.victories.map((v) => ({ value: v.id, label: v.name, title: v.blurb })),
          d.victory,
          (v) => {
            d.victory = v;
          },
        ),
        el('p', { class: 'hint', text: victory?.blurb ?? '' }),
        numberField(
          'Turn limit',
          d.turnLimit,
          'none',
          (n) => {
            d.turnLimit = n;
          },
          { min: '0' },
        ),
        d.map.kind === 'ogre'
          ? numberField(
              'Forward ceiling',
              d.centralLimit,
              'none',
              (n) => {
                d.centralLimit = n;
              },
              { min: '0', title: 'Attack strength the defence may set up in the Central Area' },
            )
          : null,
      ),
      o.onApply
        ? null
        : el(
            'div',
            { class: 'scenario-options builder-block' },
            el('h3', { class: 'sect-title', text: 'The table' }),
            chips(
              'Seats',
              [
                { value: null, label: 'Hot seat', title: 'Both seats at this keyboard' },
                {
                  value: 1,
                  label: `Play ${d.sides[0].faction || 'the attacker'}`,
                  title: 'The computer defends',
                },
                {
                  value: 0,
                  label: `Play ${d.sides[1].faction || 'the defence'}`,
                  title: 'The computer attacks',
                },
              ],
              computer,
              (v) => {
                computer = v;
              },
            ),
            el(
              'label',
              { class: 'seed-row' },
              el('span', { class: 'seed-label', text: 'Die seed' }),
              el('input', {
                class: 'seed-input mono',
                type: 'number',
                value: String(d.seed),
                'aria-label': 'Random seed',
                oninput: (ev: Event) => {
                  const n = asInt((ev.target as HTMLInputElement).value, null);
                  if (n !== null) d.seed = n;
                },
              }),
              button({
                label: 'Roll',
                variant: 'quiet',
                onClick: () => {
                  d.seed = o.newSeed();
                  draw();
                },
                title: 'A new seed gives a different setup and different die rolls',
              }),
            ),
          ),
    );
    drawPreview(canvas, preview);

    fill(
      forces,
      ...d.sides.map((side, i) => {
        const v = cat.value(side.forces);
        return el(
          'div',
          { class: 'force-card' },
          el(
            'div',
            { class: 'force-head' },
            el('span', { class: 'sel-label', text: i === 0 ? 'Attacker' : 'Defence' }),
            el('input', {
              class: 'force-name',
              type: 'text',
              value: side.faction,
              maxlength: '40',
              'aria-label': i === 0 ? 'Attacking faction' : 'Defending faction',
              placeholder: i === 0 ? 'Paneuropean Federation' : 'North American Combine',
              oninput: (ev: Event) => {
                side.faction = (ev.target as HTMLInputElement).value;
              },
            }),
          ),
          el('p', {
            class: 'hint force-total mono',
            text: `${fmt(v.armorUnits)} armour units · ${v.squads} squad${v.squads === 1 ? '' : 's'} · ${v.counters} counter${v.counters === 1 ? '' : 's'}`,
          }),
          el('h4', { class: 'force-group', text: 'Cybertanks' }),
          el('div', { class: 'force-list' }, ...cat.ogres.map((u) => stepper(u, side, false))),
          el('h4', { class: 'force-group', text: 'Armour' }),
          el('div', { class: 'force-list' }, ...cat.armour.map((u) => stepper(u, side, false))),
          el('h4', { class: 'force-group', text: 'Infantry, in squads' }),
          el('div', { class: 'force-list' }, ...cat.infantry.map((u) => stepper(u, side, true))),
        );
      }),
    );
    foot.textContent =
      problemWith(d, cat) ??
      (d.victory === 'command-post'
        ? 'The defence gets a command post placed deepest in its ground; it does not count against the force.'
        : '');
  };

  draw();
  return overlay;
};

const fmt = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(1));
