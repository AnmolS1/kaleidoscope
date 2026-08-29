// The service-worker update prompt.
//
// WHY THIS EXISTS. sw.js caches the app shell and every hashed asset, and the
// spec's own default — a worker that installs and then WAITS until every tab of
// the origin has closed — means a studio left open across a deploy keeps running
// the old bundle indefinitely. That is tolerable for cosmetics and not at all
// tolerable here: the client and the Worker share a versioned drawing format and
// a save contract, so a stale bundle is a client talking a protocol the server
// has moved past.
//
// The fix is the standard one, and it is standard because the obvious shortcut
// is wrong: calling `skipWaiting()` unconditionally inside the worker's own
// `install` swaps the code out from under a page that is still running the old
// one — mid-save, mid-stroke — with no reload. So the worker waits, the page
// offers a reload, and `skipWaiting` happens only when the user takes it.
//
// Split out of main.tsx because the state machine has one genuinely subtle case
// (see `watchForUpdate`) that is worth a unit test, and a page-load side effect
// is not testable. test/unit/sw-update.test.ts drives it with fakes;
// test/e2e/sw-update.spec.ts drives a real waiting worker.

/** The message sw.js answers by calling `skipWaiting()`. Both sides import it. */
export const SKIP_WAITING = "kld-skip-waiting";

/**
 * Call `onUpdate` with the worker that is waiting to take over.
 *
 * 🔴 THE CASE THAT MAKES THIS MORE THAN THREE LINES: on a first-ever visit the
 * very first service worker also reaches state `installed`, and a watcher that
 * only tests the state therefore tells every brand-new visitor that their
 * brand-new page is out of date. A `controller` exists only once some worker is
 * already driving this page, so "installed AND controlled" is precisely
 * "installed OVER something" — which is the event we mean.
 *
 * `hasController` is injectable so that case is testable without a browser; it
 * is the one branch a real e2e cannot easily reach twice.
 */
export function watchForUpdate(
  reg: ServiceWorkerRegistration,
  onUpdate: (waiting: ServiceWorker) => void,
  hasController: () => boolean = () => Boolean(navigator.serviceWorker.controller),
): void {
  const offer = (w: ServiceWorker | null): void => {
    if (w && w.state === "installed" && hasController()) onUpdate(w);
  };

  // Already parked: the tab was open through the deploy, or an earlier visit
  // left a worker waiting and this load inherited it. `updatefound` has already
  // fired for that one and will not fire again.
  offer(reg.waiting);

  reg.addEventListener("updatefound", () => {
    const w = reg.installing;
    if (!w) return;
    w.addEventListener("statechange", () => offer(w));
  });
}

/**
 * Take the update: tell the waiting worker to activate, and reload once it has.
 *
 * The reload is driven by `controllerchange` rather than fired immediately,
 * because reloading before the new worker has claimed the page just loads the
 * old bundle again from the old worker's cache.
 *
 * The listener is registered HERE, inside the action, and not at startup. That
 * is the guard: sw.js claims clients on activate, so the first install of all
 * fires `controllerchange` too, and a listener installed at startup would
 * reload every first-time visitor's page out from under them.
 */
export function applyUpdate(
  waiting: ServiceWorker,
  container: ServiceWorkerContainer = navigator.serviceWorker,
  reload: () => void = () => location.reload(),
): void {
  let reloaded = false;
  container.addEventListener("controllerchange", () => {
    if (reloaded) return; // once, however many times the controller changes
    reloaded = true;
    reload();
  });
  waiting.postMessage({ type: SKIP_WAITING });
}
