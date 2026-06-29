import { useState } from "preact/hooks";
import * as S from "../state";
import { loginUrl, logout } from "../api";
import { Avatar } from "./Avatar";

async function doLogout() {
  await logout().catch(() => {});
  S.me.value = null;
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
      <button role="menuitem" onClick={doLogout}>
        Sign out
      </button>
    </>
  );
}

export function AuthButton() {
  const [open, setOpen] = useState(false);
  const user = S.me.value;

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

  return (
    <div class="auth-menu">
      <button class="avatar-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} aria-label="Account menu">
        <Avatar src={user.avatar} name={user.name} size={36} />
      </button>
      {open && (
        <div class="menu-panel auth-panel" role="menu" onMouseLeave={() => setOpen(false)}>
          <div class="auth-name">{user.name ?? "Signed in"}</div>
          <button role="menuitem" onClick={() => { setOpen(false); S.navigate("/me"); }}>
            My pieces
          </button>
          <button role="menuitem" onClick={() => { setOpen(false); S.navigate("/gallery"); }}>
            Gallery
          </button>
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
