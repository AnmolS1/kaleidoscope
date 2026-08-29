import { useState } from "preact/hooks";
import * as S from "../state";
import { loginUrl, logout } from "../api";
import { Avatar } from "./Avatar";
import { PLUS_PRICE, publicPostsLine } from "./plusState";
// The menu's Plus row is styled next to the sheet it opens, so this file has to
// pull the stylesheet in too — the account menu renders on pages where the
// studio (and its sheet) never mounts.
import "../styles/plus.css";

async function doLogout() {
  await logout().catch(() => {});
  S.me.value = null;
}

/**
 * The `Kaleidoscope Plus` row (DESIGN.md, "Account menu + cap elsewhere").
 *
 * Returns nothing at all while `plus.enabled` is false, and a null `plus` block
 * counts as false — this is one of the two doors to the sheet, and the sheet is
 * invisible until the IAP is approved.
 *
 * The price chip is web-only by design (App Review 3.1.1 forbids it in the
 * app) and is additionally dropped once the entitlement is active: quoting a
 * price to someone who has already paid reads as a second charge. DESIGN.md
 * does not cover the owned case; reported as a gap.
 */
function PlusMenuItem({ onNavigate }: { onNavigate?: () => void }) {
  const plus = S.plus.value;
  if (!plus?.enabled) return null;
  return (
    <button
      role="menuitem"
      class="plus-menu-item"
      onClick={() => {
        onNavigate?.();
        S.plusOpen.value = true;
      }}
    >
      Kaleidoscope Plus
      {!plus.active && <span class="chip chip-sm">{PLUS_PRICE}</span>}
    </button>
  );
}

// Flat menu items for embedding inside another popover (the compact toolbar's
// ⋯ overflow). Signed-out → a sign-in link; signed-in → account actions. No
// "Gallery" item here — the overflow panel already lists Gallery.
export function AuthMenuItems() {
  const user = S.me.value;
  if (!user) {
    return (
      <a role="menuitem" href={loginUrl(location.pathname)}>
        Sign in with Google
      </a>
    );
  }
  return (
    <>
      <button role="menuitem" onClick={() => S.navigate("/me")}>
        My pieces
      </button>
      <PlusMenuItem />
      <button role="menuitem" onClick={doLogout}>
        Sign out
      </button>
    </>
  );
}

export function AuthButton() {
  const [open, setOpen] = useState(false);
  const user = S.me.value;
  const plus = S.plus.value;

  if (!S.authLoaded.value) {
    return <div class="auth-skel" aria-hidden="true" />;
  }

  if (!user) {
    return (
      <a class="btn btn-primary" href={loginUrl(location.pathname)}>
        Sign in<span class="signin-tail">with Google</span>
      </a>
    );
  }

  // A count with no cap is not a limit: while Plus is dark `publicCap` is null
  // and there is nothing to count towards, so the row stays off.
  const showCount = !!plus && plus.enabled && plus.publicCap !== null;

  return (
    <div class="auth-menu">
      <button class="avatar-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} aria-label="Account menu">
        <Avatar src={user.avatar} name={user.name} size={36} />
      </button>
      {open && (
        <div class="menu-panel auth-panel" role="menu" onMouseLeave={() => setOpen(false)}>
          <div class="auth-name">
            {user.name ?? "Signed in"}
            {showCount && (
              <span class="mono auth-count">
                {publicPostsLine(plus.publicCount, plus.publicCap!)}
              </span>
            )}
          </div>
          <button role="menuitem" onClick={() => { setOpen(false); S.navigate("/me"); }}>
            My pieces
          </button>
          <button role="menuitem" onClick={() => { setOpen(false); S.navigate("/gallery"); }}>
            Gallery
          </button>
          <PlusMenuItem onNavigate={() => setOpen(false)} />
          <button
            role="menuitem"
            onClick={async () => {
              setOpen(false);
              await doLogout();
            }}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
