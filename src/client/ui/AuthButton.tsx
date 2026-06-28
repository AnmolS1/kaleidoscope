import { useState } from "preact/hooks";
import * as S from "../state";
import { loginUrl, logout } from "../api";

export function AuthButton() {
  const [open, setOpen] = useState(false);
  const user = S.me.value;

  if (!S.authLoaded.value) {
    return <div class="auth-skel" aria-hidden="true" />;
  }

  if (!user) {
    return (
      <a class="btn btn-primary" href={loginUrl(location.pathname)}>
        Sign in with Google
      </a>
    );
  }

  const initial = (user.name ?? "?").trim().charAt(0).toUpperCase() || "?";

  return (
    <div class="auth-menu">
      <button class="avatar-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} aria-label="Account menu">
        {/* Initials only — the strict CSP (img-src 'self') deliberately excludes
            third-party avatar hosts like googleusercontent.com. */}
        <span class="avatar-fallback">{initial}</span>
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
              await logout().catch(() => {});
              S.me.value = null;
              setOpen(false);
            }}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
