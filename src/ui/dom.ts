/**
 * Tiny DOM helpers for the UI layer (no framework, no dependencies).
 * Owned by: W-4 (UI). Pure functions — unit-testable without a DOM.
 */

/** Escapes text so it is safe to interpolate into an HTML string. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Creates an element. `attrs` maps to attributes; keys starting with `on`
 * whose value is a function become event listeners, `text` sets textContent.
 * `children` may be Nodes or strings (inserted as text, never parsed as HTML).
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Record<string, string | number | boolean | EventListener | null | undefined>,
  children?: Array<Node | string> | string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (attrs) {
    for (const key in attrs) {
      const value = attrs[key];
      if (value === null || value === undefined || value === false) continue;
      if (typeof value === 'function') {
        const event = key.slice(2).toLowerCase();
        node.addEventListener(event, value as EventListener);
      } else if (key === 'text') {
        node.textContent = String(value);
      } else if (value === true) {
        node.setAttribute(key, '');
      } else {
        node.setAttribute(key, String(value));
      }
    }
  }
  if (typeof children === 'string') {
    node.textContent = children;
  } else if (children) {
    for (const child of children) node.append(child);
  }
  return node;
}

/** Sets `textContent` only when it actually differs. Returns true when changed. */
export function setText(node: HTMLElement, text: string): boolean {
  if (node.textContent === text) return false;
  node.textContent = text;
  return true;
}

/** Toggles a class only when needed. Returns true when the state changed. */
export function setClass(node: HTMLElement, name: string, on: boolean): boolean {
  const has = node.classList.contains(name);
  if (has === on) return false;
  node.classList.toggle(name, on);
  return true;
}

/** Sets a CSS custom property only when the value changed. */
export function setStyleVar(node: HTMLElement, name: string, value: string): void {
  if (node.style.getPropertyValue(name) !== value) node.style.setProperty(name, value);
}

/** `1450` → `"$1,450"`. Plain grouping regex — no Intl dependency, works offline. */
export function formatMoney(value: number): string {
  const n = Number.isFinite(value) ? Math.round(value) : 0;
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
}

/** `42` → `"0:42"`; `95` → `"1:35"`; null → `"--:--"`; negatives clamp to `0:00"`. */
export function formatClock(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '--:--';
  const total = Math.max(0, Math.ceil(seconds - 1e-6));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** `92.4` → `"92"`, `-3` → `"0"`. Speedometer big number. */
export function formatSpeed(kmh: number): string {
  const v = Number.isFinite(kmh) ? Math.round(kmh) : 0;
  return String(Math.max(0, v));
}

/** `128.4` → `"128"`, `1204` → `"1.2k"`. Metres for waypoint readouts. */
export function formatMetres(m: number | null | undefined): string {
  if (m === null || m === undefined || !Number.isFinite(m)) return '--';
  if (m < 1000) return String(Math.max(0, Math.round(m)));
  return `${(m / 1000).toFixed(1)}k`;
}

/** Health 0..100 → CSS colour (green → amber → red). */
export function healthColor(health: number): string {
  if (health > 60) return '#4dd88a';
  if (health > 30) return '#ffcf3f';
  return '#ff4d4d';
}

/**
 * True when the event target is a text field where game hotkeys must be ignored.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  const node = target as HTMLElement | null;
  if (!node || typeof node.tagName !== 'string') return false;
  const tag = node.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return node.isContentEditable === true;
}

/** Wraps an angle (radians) into [-PI, PI). */
export function wrapAngle(a: number): number {
  const t = ((a + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
  return t - Math.PI;
}

/**
 * Clamps a 2D vector to a circle of radius `r`.
 * `clamped: true` means it lay outside and was projected onto the rim.
 */
export function clampToCircle(x: number, z: number, r: number): { x: number; z: number; clamped: boolean } {
  const len = Math.hypot(x, z);
  if (len <= r || len < 1e-6) return { x, z, clamped: false };
  const k = r / len;
  return { x: x * k, z: z * k, clamped: true };
}
