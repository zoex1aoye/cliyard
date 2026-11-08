/**
 * In-flight MVP child AbortControllers for Cordis dispose.
 * Plain ESM (no TypeScript syntax).
 */

/** @type {Set<AbortController>} */
const controllers = new Set();

/**
 * @param {AbortController} controller
 * @returns {() => void} unregister
 */
export function trackAbortController(controller) {
  controllers.add(controller);
  return () => {
    controllers.delete(controller);
  };
}

/** @returns {number} */
export function trackedCount() {
  return controllers.size;
}

/**
 * Abort every in-flight mvp-test controller (plugin dispose / cancel).
 * @returns {number} how many controllers were aborted
 */
export function abortAllTracked() {
  let n = 0;
  for (const c of [...controllers]) {
    try {
      c.abort();
      n += 1;
    } catch {
      /* ignore */
    }
    controllers.delete(c);
  }
  return n;
}
