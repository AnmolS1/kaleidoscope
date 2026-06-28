import { Link } from "./Link";
import { AuthButton } from "./AuthButton";

export function PageNav() {
  return (
    <header class="page-nav">
      <Link href="/" class="tb-brand" aria-label="Kaleidoscope studio">
        <span class="tb-mark" /> Kaleidoscope
      </Link>
      <nav class="page-nav-links">
        <Link href="/" class="btn btn-ghost">
          Draw
        </Link>
        <Link href="/gallery" class="btn btn-ghost">
          Gallery
        </Link>
        <AuthButton />
      </nav>
    </header>
  );
}
