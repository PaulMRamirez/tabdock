// A Connect button that takes a click only once it has held still (ADR 0029's
// notes), as the widget's boxes do, so a double-click begun on another window
// cannot land its second half on it. The board's Connect bar uses it, and the
// map demo's (ADR 0050) imports it from here as @tabdock/demo/arming, so the
// two pages share one copy of this check.

/**
 * How long the bar's button must hold still, in a visible tab whose window
 * has focus, before a click counts: the widget's ARM_DELAY_MS
 * (packages/adapter/src/widget.ts), for the same reason.
 */
export const CONNECT_ARM_DELAY_MS = 500;

/** How often the bar checks that its button is still where it armed. */
const ARM_CHECK_MS = 100;

function sameRect(a: DOMRect | null, b: DOMRect): boolean {
  return a !== null && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/**
 * Keeps a button disarmed until it has held still for CONNECT_ARM_DELAY_MS in
 * a visible tab whose window has focus, as the widget's boxes do. A window
 * regaining focus (as when a popup closes on the first half of a
 * double-click), the tab coming back into view, the page shown again from the
 * back-forward cache, a resize, a scroll or any move of the button starts the
 * wait again, and so does a click refused for coming too soon. Events that
 * only start the wait need no isTrusted check: a script that sends them can
 * only make the button wait longer.
 */
export function armWhenStill(button: HTMLButtonElement): {
  ready: () => boolean;
  restart: () => void;
  stop: () => void;
} {
  const doc = button.ownerDocument;
  const win = doc.defaultView ?? window;
  let armed = false;
  let rect: DOMRect | null = null;
  let stillSince: number | null = null;

  const setArmed = (value: boolean): void => {
    armed = value;
    button.dataset.armed = String(value);
    button.setAttribute('aria-disabled', String(!value));
  };
  const inView = (): boolean => doc.visibilityState === 'visible' && doc.hasFocus();
  const restart = (): void => {
    setArmed(false);
    rect = button.getBoundingClientRect();
    stillSince = inView() ? performance.now() : null;
  };
  const check = (): void => {
    const now = button.getBoundingClientRect();
    if (!inView() || !sameRect(rect, now)) {
      restart();
      return;
    }
    if (stillSince === null) {
      stillSince = performance.now();
      return;
    }
    if (!armed && performance.now() - stillSince >= CONNECT_ARM_DELAY_MS) setArmed(true);
  };

  const windowEvents = ['focus', 'blur', 'pageshow', 'resize'] as const;
  for (const type of windowEvents) win.addEventListener(type, restart);
  doc.addEventListener('visibilitychange', restart);
  doc.addEventListener('scroll', restart, { capture: true, passive: true });
  const interval = win.setInterval(check, ARM_CHECK_MS);
  restart();

  return {
    // Checked again at the click, as a move may land between two checks.
    ready: () => armed && sameRect(rect, button.getBoundingClientRect()),
    restart,
    stop: () => {
      win.clearInterval(interval);
      for (const type of windowEvents) win.removeEventListener(type, restart);
      doc.removeEventListener('visibilitychange', restart);
      doc.removeEventListener('scroll', restart, { capture: true });
    },
  };
}
