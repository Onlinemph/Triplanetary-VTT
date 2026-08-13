/**
 * Overlays: the scenario picker, plot confirmations, and the rules drawer.
 *
 * Both shells trap focus, restore it on close, and answer Escape. Nothing else
 * in the app takes focus away from the map, which is the point — an overlay is
 * the only time the keyboard stops belonging to the chart.
 */

import { type Child, button, el, focusables } from './dom.js';
import { icon } from './glyphs.js';

export interface Overlay {
  readonly el: HTMLElement;
  close(): void;
}

export interface ModalAction {
  readonly label: string;
  readonly onClick: () => void;
  readonly variant?: 'primary' | 'ghost' | 'danger' | 'quiet';
  /** Close the modal after running `onClick`. Defaults to true. */
  readonly closes?: boolean;
}

export interface ModalOptions {
  readonly title: string;
  readonly subtitle?: string;
  readonly body: Child | readonly Child[];
  readonly actions?: readonly ModalAction[];
  readonly dismissible?: boolean;
  readonly width?: 'narrow' | 'wide';
  readonly onClose?: () => void;
}

const trapFocus = (panel: HTMLElement, ev: KeyboardEvent): void => {
  if (ev.key !== 'Tab') return;
  const items = focusables(panel);
  if (items.length === 0) {
    ev.preventDefault();
    return;
  }
  const first = items[0]!;
  const last = items[items.length - 1]!;
  const active = document.activeElement;
  if (ev.shiftKey && (active === first || !panel.contains(active))) {
    ev.preventDefault();
    last.focus();
  } else if (!ev.shiftKey && active === last) {
    ev.preventDefault();
    first.focus();
  }
};

export const openModal = (host: HTMLElement, o: ModalOptions): Overlay => {
  const dismissible = o.dismissible !== false;
  const restore = document.activeElement as HTMLElement | null;
  let closed = false;

  const close = (): void => {
    if (closed) return;
    closed = true;
    scrim.remove();
    document.removeEventListener('keydown', onKey, true);
    o.onClose?.();
    restore?.focus?.();
  };

  const onKey = (ev: KeyboardEvent): void => {
    if (!scrim.isConnected) return;
    if (ev.key === 'Escape' && dismissible) {
      ev.preventDefault();
      ev.stopPropagation();
      close();
      return;
    }
    if (scrim.contains(ev.target as Node) || ev.key === 'Tab') trapFocus(panel, ev);
  };

  const bodyNodes: Child[] = Array.isArray(o.body) ? [...(o.body as Child[])] : [o.body as Child];

  const panel = el(
    'div',
    {
      class: `modal modal-${o.width ?? 'narrow'}`,
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': o.title,
    },
    el(
      'header',
      { class: 'modal-head' },
      el(
        'div',
        {},
        el('h2', { class: 'modal-title', text: o.title }),
        o.subtitle ? el('p', { class: 'modal-sub', text: o.subtitle }) : null,
      ),
      dismissible
        ? button({
            label: icon('close'),
            onClick: close,
            variant: 'quiet',
            title: 'Close (Esc)',
            class: 'icon-btn',
          })
        : null,
    ),
    el('div', { class: 'modal-body' }, ...bodyNodes),
    o.actions && o.actions.length > 0
      ? el(
          'footer',
          { class: 'modal-foot' },
          ...o.actions.map((a) =>
            button({
              label: a.label,
              variant: a.variant ?? 'ghost',
              onClick: () => {
                if (a.closes === false) {
                  a.onClick();
                } else {
                  close();
                  a.onClick();
                }
              },
            }),
          ),
        )
      : null,
  );

  const scrim = el(
    'div',
    {
      class: 'scrim',
      onclick: (ev: Event) => {
        if (ev.target === scrim && dismissible) close();
      },
    },
    panel,
  );

  host.appendChild(scrim);
  document.addEventListener('keydown', onKey, true);
  const first = focusables(panel)[0];
  (first ?? panel).focus?.();

  return { el: panel, close };
};

export interface DrawerOptions {
  readonly title: string;
  readonly body: Child | readonly Child[];
  readonly onClose?: () => void;
  readonly side?: 'left' | 'right';
}

/** A side sheet — used for the rules reference, which the player reads beside the map. */
export const openDrawer = (host: HTMLElement, o: DrawerOptions): Overlay => {
  const restore = document.activeElement as HTMLElement | null;
  let closed = false;

  const close = (): void => {
    if (closed) return;
    closed = true;
    wrap.classList.add('is-closing');
    const finish = (): void => {
      wrap.remove();
      document.removeEventListener('keydown', onKey, true);
      o.onClose?.();
      restore?.focus?.();
    };
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) finish();
    else window.setTimeout(finish, 160);
  };

  const onKey = (ev: KeyboardEvent): void => {
    if (!wrap.isConnected) return;
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      close();
      return;
    }
    if (wrap.contains(ev.target as Node)) trapFocus(panel, ev);
  };

  const bodyNodes: Child[] = Array.isArray(o.body) ? [...(o.body as Child[])] : [o.body as Child];

  const panel = el(
    'div',
    {
      class: `drawer drawer-${o.side ?? 'right'}`,
      role: 'dialog',
      'aria-modal': 'false',
      'aria-label': o.title,
      tabindex: '-1',
    },
    el(
      'header',
      { class: 'drawer-head' },
      el('h2', { class: 'drawer-title', text: o.title }),
      button({
        label: icon('close'),
        onClick: close,
        variant: 'quiet',
        title: 'Close (Esc)',
        class: 'icon-btn',
      }),
    ),
    el('div', { class: 'drawer-body' }, ...bodyNodes),
  );

  const wrap = el(
    'div',
    {
      class: 'drawer-wrap',
      onclick: (ev: Event) => {
        if (ev.target === wrap) close();
      },
    },
    panel,
  );

  host.appendChild(wrap);
  document.addEventListener('keydown', onKey, true);
  panel.focus();

  return { el: panel, close };
};
