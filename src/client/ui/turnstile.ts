// Lazily load the Cloudflare Turnstile script and render a widget. The script
// origin is allowed by the CSP. With the test site key it auto-passes.

interface TurnstileApi {
  render(el: HTMLElement, opts: { sitekey: string; callback: (token: string) => void; "error-callback"?: () => void; theme?: string }): string;
  reset(id?: string): void;
  remove(id: string): void;
}
declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let loader: Promise<void> | null = null;

function loadScript(): Promise<void> {
  if (loader) return loader;
  loader = new Promise((resolve, reject) => {
    if (window.turnstile) return resolve();
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("turnstile_load_failed"));
    document.head.appendChild(s);
  });
  return loader;
}

export async function renderTurnstile(
  el: HTMLElement,
  sitekey: string,
  onToken: (token: string) => void,
  theme = "auto",
): Promise<string> {
  await loadScript();
  // poll briefly in case window.turnstile attaches a tick after load
  for (let i = 0; i < 50 && !window.turnstile; i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  if (!window.turnstile) throw new Error("turnstile_unavailable");
  return window.turnstile.render(el, { sitekey, callback: onToken, theme });
}

export function resetTurnstile(id?: string): void {
  window.turnstile?.reset(id);
}
