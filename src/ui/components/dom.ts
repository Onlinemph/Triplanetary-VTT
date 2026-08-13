/**
 * A very small DOM construction kit.
 *
 * Everything in `src/ui` builds its markup through `el`, so panels read as a
 * declarative tree rather than a pile of `createElement`/`appendChild` noise.
 * Deliberately tiny: no virtual DOM, no diffing, no dependencies. Panels rebuild
 * their own subtree when the state they show changes, and the pieces that must
 * survive a rebuild (scroll offsets, focus) are handled explicitly where they
 * matter.
 */

export type Child = Node | string | number | null | undefined | false;

export interface Attrs {
  readonly [key: string]: unknown;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

const appendChild = (parent: Node, child: Child): void => {
  if (child === null || child === undefined || child === false) return;
  if (typeof child === 'string' || typeof child === 'number') {
    parent.appendChild(document.createTextNode(String(child)));
    return;
  }
  parent.appendChild(child);
};

export const append = (parent: Node, children: readonly Child[]): void => {
  for (const child of children) appendChild(parent, child);
};

/**
 * Custom properties are the whole point of the style objects here — a player's
 * accent is threaded through `--player` — and `Object.assign` cannot set them:
 * `CSSStyleDeclaration` only reaches custom properties through `setProperty`.
 */
const applyStyle = (node: HTMLElement, style: Record<string, unknown>): void => {
  for (const [prop, raw] of Object.entries(style)) {
    if (raw === null || raw === undefined || raw === '') continue;
    const value = String(raw);
    if (prop.startsWith('--')) node.style.setProperty(prop, value);
    else
      node.style.setProperty(
        prop.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`),
        value,
      );
  }
};

const applyAttrs = (node: Element, attrs: Attrs): void => {
  for (const [name, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;

    if (name === 'class') {
      node.setAttribute('class', String(value));
      continue;
    }
    if (name === 'text') {
      node.textContent = String(value);
      continue;
    }
    if (name === 'style' && typeof value === 'object') {
      applyStyle(node as HTMLElement, value as Record<string, unknown>);
      continue;
    }
    if (name.startsWith('on') && typeof value === 'function') {
      node.addEventListener(
        name.slice(2).toLowerCase(),
        value as EventListenerOrEventListenerObject,
      );
      continue;
    }
    if (name === 'value' && node instanceof HTMLInputElement) {
      node.value = String(value);
      continue;
    }
    if (value === true) {
      node.setAttribute(name, '');
      continue;
    }
    node.setAttribute(name, String(value));
  }
};

export const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  applyAttrs(node, attrs);
  append(node, children);
  return node;
};

/** SVG needs its own namespace; glyphs and icons go through here. */
export const svg = (tag: string, attrs: Attrs = {}, ...children: Child[]): SVGElement => {
  const node = document.createElementNS(SVG_NS, tag) as SVGElement;
  for (const [name, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (name.startsWith('on') && typeof value === 'function') {
      node.addEventListener(
        name.slice(2).toLowerCase(),
        value as EventListenerOrEventListenerObject,
      );
      continue;
    }
    node.setAttribute(name, value === true ? '' : String(value));
  }
  append(node, children);
  return node;
};

export const frag = (...children: Child[]): DocumentFragment => {
  const f = document.createDocumentFragment();
  append(f, children);
  return f;
};

export const clear = (node: Node): void => {
  while (node.firstChild) node.removeChild(node.firstChild);
};

/** Replace a node's children in one shot. */
export const fill = (node: Node, ...children: Child[]): void => {
  clear(node);
  append(node, children);
};

export interface ButtonOptions {
  readonly label: Child;
  readonly onClick: () => void;
  readonly title?: string;
  readonly variant?: 'primary' | 'ghost' | 'danger' | 'quiet';
  readonly disabled?: boolean;
  readonly pressed?: boolean;
  readonly class?: string;
  readonly key?: string;
}

/** The one button in the app, so every affordance looks and behaves the same. */
export const button = (o: ButtonOptions): HTMLButtonElement => {
  const classes = ['btn'];
  if (o.variant) classes.push(`btn-${o.variant}`);
  if (o.class) classes.push(o.class);
  const b = el(
    'button',
    {
      class: classes.join(' '),
      type: 'button',
      ...(o.title ? { title: o.title } : {}),
      ...(o.disabled ? { disabled: true } : {}),
      ...(o.pressed !== undefined ? { 'aria-pressed': String(o.pressed) } : {}),
      onclick: (ev: Event) => {
        ev.stopPropagation();
        o.onClick();
      },
    },
    o.label,
    o.key ? el('kbd', { class: 'btn-key', text: o.key }) : null,
  );
  if (o.pressed) b.classList.add('is-on');
  return b;
};

/** A labelled on/off switch used for view toggles and game options. */
export const toggle = (
  label: string,
  value: boolean,
  onChange: (next: boolean) => void,
  hint?: string,
): HTMLElement =>
  el(
    'label',
    {
      class: `switch${value ? ' is-on' : ''}`,
      ...(hint ? { title: hint } : {}),
    },
    el('input', {
      type: 'checkbox',
      ...(value ? { checked: true } : {}),
      onchange: (ev: Event) => onChange((ev.target as HTMLInputElement).checked),
    }),
    el('span', { class: 'switch-track' }, el('span', { class: 'switch-thumb' })),
    el('span', { class: 'switch-label', text: label }),
  );

/** Focusable descendants, in tab order — used by the modal focus trap. */
export const focusables = (root: ParentNode): HTMLElement[] =>
  Array.from(
    root.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((n) => n.offsetParent !== null || n === document.activeElement);
