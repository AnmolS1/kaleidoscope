// The service-worker update prompt's state machine (T07).
//
// THE VACUOUS TEST this file refuses to be: "the service worker registered".
// That assertion holds with the update prompt deleted, with `skipWaiting`
// deleted, and with the toast deleted. What actually has behaviour is WHEN the
// prompt fires — and its one genuinely subtle case is the negative one, that a
// FIRST install must not prompt, which no amount of "a worker appeared" can
// see.
//
// Driven with fakes rather than a browser because the negative case needs a
// page with no controller and the positive one needs a page with a controller,
// and getting a real browser into both states inside one run is exactly the
// kind of harness that fails for its own reasons. The real thing is driven
// end-to-end in test/e2e/sw-update.spec.ts.

/// <reference types="node" />
// tsconfig.app.json compiles test/ with `types: ["vite/client", "vitest/globals"]`,
// so @types/node is not in scope here and `node:*` imports do not resolve. This is
// the per-file escape hatch; the alternative is adding "node" to that shared
// tsconfig, which would put Node globals in front of every DOM module in the app.
import { describe, expect, it, vi } from "vitest";
import { SKIP_WAITING, applyUpdate, watchForUpdate } from "../../src/client/swUpdate";

/** A ServiceWorker with a settable state and a working statechange listener. */
function fakeWorker(state: ServiceWorkerState = "installing") {
  const listeners: Record<string, ((e?: unknown) => void)[]> = {};
  const posted: unknown[] = [];
  return {
    posted,
    worker: {
      state,
      postMessage: (m: unknown) => posted.push(m),
      addEventListener: (t: string, fn: () => void) => (listeners[t] ??= []).push(fn),
    } as unknown as ServiceWorker,
    /** Move to a new state and fire statechange, as the browser would. */
    become(next: ServiceWorkerState) {
      (this.worker as { state: ServiceWorkerState }).state = next;
      for (const fn of listeners.statechange ?? []) fn();
    },
  };
}

function fakeRegistration(waiting: ServiceWorker | null = null) {
  const listeners: Record<string, (() => void)[]> = {};
  const reg = {
    waiting,
    installing: null as ServiceWorker | null,
    addEventListener: (t: string, fn: () => void) => (listeners[t] ??= []).push(fn),
  };
  return {
    reg: reg as unknown as ServiceWorkerRegistration,
    /** The browser's sequence: installing is set, then updatefound fires. */
    updateFound(w: ServiceWorker) {
      reg.installing = w;
      for (const fn of listeners.updatefound ?? []) fn();
    },
  };
}

describe("watchForUpdate", () => {
  it("prompts when a new worker finishes installing over a controlled page", () => {
    const onUpdate = vi.fn();
    const { reg, updateFound } = fakeRegistration();
    const w = fakeWorker();
    watchForUpdate(reg, onUpdate, () => true);

    updateFound(w.worker);
    expect(onUpdate, "still installing — nothing to offer yet").not.toHaveBeenCalled();

    w.become("installed");
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledWith(w.worker);
  });

  it("does NOT prompt on a first install, when nothing is controlling the page", () => {
    // 🔴 The case the whole `hasController` argument exists for. Without it every
    // first-time visitor is told their brand-new page is out of date — and a
    // test that only ever runs with a controller present passes either way.
    const onUpdate = vi.fn();
    const { reg, updateFound } = fakeRegistration();
    const w = fakeWorker();
    watchForUpdate(reg, onUpdate, () => false);

    updateFound(w.worker);
    w.become("installed");
    w.become("activated");
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("prompts for a worker that was ALREADY waiting when the page loaded", () => {
    // `updatefound` fired before this page existed and will not fire again, so a
    // watcher that only listens for the event never notices this one — which is
    // the common case for a tab opened after a deploy.
    const onUpdate = vi.fn();
    const w = fakeWorker("installed");
    const { reg } = fakeRegistration(w.worker);
    watchForUpdate(reg, onUpdate, () => true);
    expect(onUpdate).toHaveBeenCalledWith(w.worker);
  });

  it("ignores a waiting slot that is empty, and an updatefound with no worker", () => {
    const onUpdate = vi.fn();
    const { reg, updateFound } = fakeRegistration(null);
    watchForUpdate(reg, onUpdate, () => true);
    updateFound(null as unknown as ServiceWorker);
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("does not prompt for a worker that installs and goes redundant", () => {
    const onUpdate = vi.fn();
    const { reg, updateFound } = fakeRegistration();
    const w = fakeWorker();
    watchForUpdate(reg, onUpdate, () => true);
    updateFound(w.worker);
    w.become("redundant");
    expect(onUpdate).not.toHaveBeenCalled();
  });
});

describe("applyUpdate", () => {
  function fakeContainer() {
    const listeners: Record<string, (() => void)[]> = {};
    return {
      container: {
        addEventListener: (t: string, fn: () => void) => (listeners[t] ??= []).push(fn),
      } as unknown as ServiceWorkerContainer,
      controllerChange() {
        for (const fn of listeners.controllerchange ?? []) fn();
      },
      count: () => (listeners.controllerchange ?? []).length,
    };
  }

  it("asks the waiting worker to skip waiting, and reloads only once it has", () => {
    const w = fakeWorker("installed");
    const c = fakeContainer();
    const reload = vi.fn();

    applyUpdate(w.worker, c.container, reload);
    expect(w.posted, "the message sw.js listens for").toEqual([{ type: SKIP_WAITING }]);
    // Not before the swap: reloading first just re-fetches the old bundle from
    // the old worker's cache, which looks like the update silently failing.
    expect(reload).not.toHaveBeenCalled();

    c.controllerChange();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("reloads once even if the controller changes again", () => {
    const w = fakeWorker("installed");
    const c = fakeContainer();
    const reload = vi.fn();
    applyUpdate(w.worker, c.container, reload);
    c.controllerChange();
    c.controllerChange();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("registers the controllerchange listener only when the user acts", () => {
    // The listener IS the guard: sw.js claims clients on activate, so a first
    // install fires controllerchange too. A listener installed at startup would
    // reload every first-time visitor's page out from under them.
    const c = fakeContainer();
    expect(c.count(), "nothing is listening before applyUpdate").toBe(0);
    applyUpdate(fakeWorker("installed").worker, c.container, () => {});
    expect(c.count()).toBe(1);
  });
});

describe("the message contract between the page and sw.js", () => {
  it("is one constant, spelled the same on both sides", async () => {
    // sw.js is a plain script served as an asset — it cannot import the
    // constant, so it re-declares it. A rename on one side alone is silent:
    // the page posts a message nothing answers and the toast's Reload button
    // does nothing at all.
    const { readFile } = await import("node:fs/promises");
    const sw = await readFile(new URL("../../public/sw.js", import.meta.url), "utf8");
    expect(sw).toContain(`const SKIP_WAITING = "${SKIP_WAITING}"`);
    expect(sw).toContain("self.skipWaiting()");
    // And it must NOT skip unconditionally on install, which is what makes the
    // prompt possible at all: a worker that skips on install never waits, so
    // the page never has anything to offer. Scoped to the install handler's own
    // body — a whole-file regex matches the word "install" in a comment and
    // then the legitimate `skipWaiting` in the message handler, and fails on a
    // correct file.
    const from = sw.indexOf('addEventListener("install"');
    expect(from, "sw.js has an install handler").toBeGreaterThan(-1);
    const next = sw.indexOf("self.addEventListener(", from + 1);
    const installBody = sw
      .slice(from, next === -1 ? undefined : next)
      // Comments out too: the handler's own comment explains that it does not
      // call skipWaiting, and a substring search cannot tell the explanation
      // from the call.
      .replace(/\/\/.*$/gm, "");
    expect(installBody).not.toContain("skipWaiting");
  });
});
