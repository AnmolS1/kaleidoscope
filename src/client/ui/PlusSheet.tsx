// The Kaleidoscope Plus sheet — DESIGN.md §5, "one sheet, six states".
//
// Driven by `S.plusOpen`, opened from the account menu and from the save
// dialog's cap copy. Which state renders is decided by `plusState.ts`, not here;
// this file is the markup, the two API calls, and the focus/escape plumbing.
//
// 🔴 The whole sheet is hidden while `plus.enabled` is false, and a null `plus`
// block counts as false. That switch is what keeps an unapproved IAP invisible,
// so it fails CLOSED: an /api/me that failed, or a worker that predates the
// entitlement block, must not produce a paywall.

import { useEffect, useRef, useState } from "preact/hooks";
import * as S from "../state";
import {
  fetchCheckoutUrl,
  loginUrl,
  logout,
  refreshPlus,
  type PlusInfo,
} from "../api";
import {
  PLUS_PRICE,
  plusOutcomeForError,
  priceFootnote,
  resolvePlusState,
  unlockLabel,
  type PlusOutcome,
} from "./plusState";
import "../styles/plus.css";

type P = { size?: number };

const CheckIcon = ({ size = 16 }: P) => (
  <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="m4 10.5 4 4 8-9" />
  </svg>
);

const InfoIcon = ({ size = 18 }: P) => (
  <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="10" cy="10" r="7" />
    <path d="M8 8a2 2 0 1 1 2.8 1.8c-.6.3-.8.7-.8 1.2M10 14h.01" />
  </svg>
);

const LockIcon = ({ size = 18 }: P) => (
  <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <rect x="5" y="9" width="10" height="8" rx="1.5" />
    <path d="M7 9V6.5a3 3 0 0 1 6 0V9" />
  </svg>
);

const AlertIcon = ({ size = 18 }: P) => (
  <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="10" cy="10" r="7" />
    <path d="M7.5 7.5 12.5 12.5M12.5 7.5l-5 5" />
  </svg>
);

/** DESIGN.md §5: three lines, same words on both platforms. */
const FEATURES: Array<[string, string]> = [
  ["Unlimited public posts", "Free accounts show 10 pieces on the public wall at a time"],
  ["Eight layers", "Free accounts get three"],
  ["One-time purchase", "No subscription. Yours on web and iOS."],
];

export function PlusSheet() {
  const open = S.plusOpen.value;
  const plus = S.plus.value;
  // Read both signals BEFORE the early return so this component subscribes to
  // them either way — and then fail closed on anything that is not an explicit
  // `enabled: true`.
  // Gated on the SURFACE flag so the paywall (and Restore) can be found
  // while caps are still off. See the two-flag note in wrangler.jsonc.
  if (!open || !plus || !plus.surface) return null;
  return <PlusSheetInner plus={plus} />;
}

function PlusSheetInner({ plus }: { plus: PlusInfo }) {
  const user = S.me.value;
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<PlusOutcome | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  const kind = resolvePlusState({
    signedIn: !!user,
    owned: plus.active,
    busy,
    outcome,
  });

  const close = () => {
    S.plusOpen.value = false;
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Focus management, patterned on SaveDialog: into the card on open, Tab
  // trapped inside it, focus back to the opener on close. The card itself is
  // the target rather than its first control, because the body swaps under the
  // user as an action resolves.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const card = cardRef.current;
    const focusables = () =>
      Array.from(
        card?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
    card?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    card?.addEventListener("keydown", onKey);
    return () => {
      card?.removeEventListener("keydown", onKey);
      opener?.focus();
    };
  }, []);

  // ---- actions ----

  async function buy() {
    // Belt and braces against the sheet being opened by something that did not
    // check for a session: the route answers 401 and we land in the same state,
    // but there is no reason to spend a request finding that out.
    if (!user) {
      setOutcome({ kind: "sign-in" });
      return;
    }
    setOutcome(null);
    setBusy(true);
    try {
      const url = await fetchCheckoutUrl();
      // A full-page redirect to Lemon Squeezy's hosted checkout, never an
      // overlay — the overlay would need LS's script host in `script-src` and
      // PLAN §2.3 pins the CSP as unchanged.
      //
      // `busy` is deliberately NOT cleared: the document is on its way out, and
      // flipping the button back to "Unlock" for the last frame before it goes
      // invites a second click that starts a second checkout.
      location.assign(url);
    } catch (err) {
      setOutcome(plusOutcomeForError(err));
      setBusy(false);
    }
  }

  async function restore() {
    setOutcome(null);
    setBusy(true);
    try {
      const fresh = await refreshPlus();
      // 🔴 /api/me omits the block ENTIRELY when there is no session (index.ts
      // guards it on `user`), so a null here means the session expired — not
      // "no entitlement". Publishing that null would trip this sheet's own
      // enabled gate and make it VANISH mid-click, leaving `me` still claiming
      // a session and the layer cap silently back at 3. Say what is true
      // instead, and leave the stale block for the next load to correct.
      if (!fresh) {
        setOutcome({ kind: "sign-in" });
        return;
      }
      // Publish the fresh block so the layer gate and the cap copy agree with
      // what the sheet just said. `me` is untouched on purpose — see api.ts.
      S.plus.value = fresh;
      S.layerCap.value = fresh.layerCap;
      setOutcome(fresh.active ? { kind: "purchased" } : { kind: "restore-none" });
    } catch (err) {
      setOutcome(plusOutcomeForError(err));
    } finally {
      setBusy(false);
    }
  }

  async function switchAccount() {
    // End this session first, or the OAuth round-trip comes back to the very
    // account that cannot use the purchase.
    await logout().catch(() => {});
    S.me.value = null;
    location.assign(loginUrl(location.pathname));
  }

  // ---- pieces ----

  const meter = plus.publicCap !== null && (
    <div class="plus-meter">
      <div class="plus-meter-head mono">
        <span>Public posts</span>
        <span>
          {plus.publicCount} of {plus.publicCap}
        </span>
      </div>
      {/* Decorative: the line above already states the numbers. */}
      <div class="plus-meter-track" aria-hidden="true">
        <div
          class="plus-meter-fill"
          style={{ width: `${Math.min(100, (plus.publicCount / plus.publicCap) * 100)}%` }}
        />
      </div>
    </div>
  );

  const features = (
    <ul class="plus-features">
      {FEATURES.map(([title, sub]) => (
        <li key={title}>
          <span class="plus-tick" aria-hidden="true">
            <CheckIcon />
          </span>
          <div>
            <div class="plus-feature-title">{title}</div>
            <div class="plus-feature-sub">{sub}</div>
          </div>
        </li>
      ))}
    </ul>
  );

  const unlockButton = (
    <button class="btn btn-primary plus-cta" onClick={buy} disabled={busy}>
      {busy ? "Unlocking…" : unlockLabel(PLUS_PRICE)}
    </button>
  );

  const footnote = (
    <p class="plus-foot mono">
      {priceFootnote(PLUS_PRICE)}{" "}
      <a href="https://ponderance.dev/terms" target="_blank" rel="noreferrer">
        Terms
      </a>{" "}
      ·{" "}
      <a href="https://ponderance.dev/privacy" target="_blank" rel="noreferrer">
        Privacy
      </a>{" "}
      ·{" "}
      <button type="button" class="link-inline" onClick={restore} disabled={busy}>
        Restore purchase
      </button>
    </p>
  );

  const body = () => {
    switch (kind) {
      case "purchased":
        return (
          <>
            <div class="note plus-note-ok">
              <span class="note-icon" aria-hidden="true">
                <CheckIcon size={18} />
              </span>
              <div>
                <b>You&rsquo;re in.</b> Eight layers and unlimited public posts, on web and in the
                app.
              </div>
            </div>
            <button class="btn plus-cta" onClick={close}>
              Back to canvas
            </button>
          </>
        );

      case "bound-elsewhere":
        return (
          <>
            <div class="note note-alert">
              <span class="note-icon" aria-hidden="true">
                <LockIcon />
              </span>
              <div>
                This purchase is linked to another Kaleidoscope account. Sign in with that account
                to use it here.
              </div>
            </div>
            <button class="btn plus-cta" onClick={switchAccount}>
              Switch account
            </button>
          </>
        );

      case "sign-in":
        return (
          <>
            {features}
            <div class="note">
              <span class="note-icon" aria-hidden="true">
                <InfoIcon />
              </span>
              <div>Sign in first so the purchase follows your account across web and iOS.</div>
            </div>
            <a class="btn btn-primary plus-cta" href={loginUrl(location.pathname)}>
              Sign in to continue
            </a>
            {footnote}
          </>
        );

      case "restore-none":
        return (
          <>
            <div class="note">
              <span class="note-icon" aria-hidden="true">
                <InfoIcon />
              </span>
              {/* Reworded from DESIGN.md's iOS sentence: there is no Apple ID on
                  the web, and a purchase here follows the Kaleidoscope account. */}
              <div>
                No purchase found for this account. If you bought Plus with a different account,
                sign in with that one instead.
              </div>
            </div>
            {unlockButton}
            {footnote}
          </>
        );

      case "error":
        return (
          <>
            <div class="note note-alert">
              <span class="note-icon" aria-hidden="true">
                <AlertIcon />
              </span>
              <div>{outcome?.kind === "error" ? outcome.message : ""}</div>
            </div>
            {unlockButton}
            {footnote}
          </>
        );

      // `before` and `purchasing` are the same body; the button is what differs,
      // and it reads `busy` itself. The meter stays put through the purchase on
      // purpose — the card must not resize under a cursor that just pressed a
      // 44px target.
      case "before":
      case "purchasing":
      default:
        return (
          <>
            {meter}
            {features}
            {unlockButton}
            {footnote}
          </>
        );
    }
  };

  return (
    <div class="overlay" onClick={close}>
      <div
        class="overlay-card plus-card"
        role="dialog"
        aria-modal="true"
        aria-label="Kaleidoscope Plus"
        data-plus-state={kind}
        tabIndex={-1}
        ref={cardRef}
        onClick={(e) => e.stopPropagation()}
      >
        <header class="overlay-head plus-head">
          <span class="plus-mark" aria-hidden="true" />
          <h2>Kaleidoscope Plus</h2>
          <button class="icon-btn plus-close" aria-label="Close" onClick={close}>
            ✕
          </button>
        </header>
        {body()}
      </div>
    </div>
  );
}
