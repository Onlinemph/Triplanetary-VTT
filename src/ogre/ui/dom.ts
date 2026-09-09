/**
 * A very small DOM builder.
 *
 * Not a framework: the shell is a handful of panels that are rebuilt whenever
 * the state changes, and the whole game is in a canvas. `el` exists so that
 * building a panel reads as a nested expression rather than fifty lines of
 * `createElement`/`appendChild`.
 */

type Child = Node | string | null | undefined | false;

export interface Attrs {
  readonly class?: string;
  readonly title?: string;
  readonly id?: string;
  readonly type?: string;
  readonly disabled?: boolean;
  readonly checked?: boolean;
  readonly value?: string;
  readonly style?: string;
  readonly onClick?: (event: MouseEvent) => void;
  readonly onChange?: (event: Event) => void;
  readonly onPointerEnter?: (event: PointerEvent) => void;
  readonly onPointerLeave?: (event: PointerEvent) => void;
  readonly data?: Readonly<Record<string, string>>;
}

export const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (attrs.class) node.className = attrs.class;
  if (attrs.title) node.title = attrs.title;
  if (attrs.id) node.id = attrs.id;
  if (attrs.style) node.setAttribute('style', attrs.style);
  if (attrs.type && 'type' in node) (node as HTMLInputElement).type = attrs.type;
  if (attrs.value !== undefined && 'value' in node) (node as HTMLInputElement).value = attrs.value;
  if (attrs.disabled !== undefined && 'disabled' in node) {
    (node as HTMLButtonElement).disabled = attrs.disabled;
  }
  if (attrs.checked !== undefined && 'checked' in node) {
    (node as HTMLInputElement).checked = attrs.checked;
  }
  if (attrs.onClick) node.addEventListener('click', attrs.onClick as EventListener);
  if (attrs.onChange) node.addEventListener('change', attrs.onChange);
  if (attrs.onPointerEnter)
    node.addEventListener('pointerenter', attrs.onPointerEnter as EventListener);
  if (attrs.onPointerLeave)
    node.addEventListener('pointerleave', attrs.onPointerLeave as EventListener);
  for (const [k, v] of Object.entries(attrs.data ?? {})) node.dataset[k] = v;

  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
};

export const clear = (node: HTMLElement): void => {
  while (node.firstChild) node.removeChild(node.firstChild);
};

export const setChildren = (node: HTMLElement, ...children: Child[]): void => {
  clear(node);
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
};

/** A labelled row: a dim caption on the left, a value on the right. */
export const row = (label: string, value: Child, cls = ''): HTMLElement =>
  el(
    'div',
    { class: `row ${cls}`.trim() },
    el('span', { class: 'row-label' }, label),
    el('span', { class: 'row-value' }, value),
  );

export const button = (
  label: string,
  onClick: () => void,
  opts: { class?: string; disabled?: boolean; title?: string } = {},
): HTMLButtonElement =>
  el(
    'button',
    {
      class: `btn ${opts.class ?? ''}`.trim(),
      disabled: opts.disabled ?? false,
      title: opts.title ?? '',
      onClick: () => onClick(),
    },
    label,
  );
