/**
 * \author Toximik
 * \file dom.ts
 * \brief Minimal DOM helpers (no framework).
 */

type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, v);
  }
  for (const c of children) {
    if (c !== null && c !== undefined && c !== false) {
      el.append(c);
    }
  }
  return el;
}

export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el as T;
}

/** Sets text only when it changed (keeps 10 Hz updates cheap) */
export function setText(el: Element, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}
