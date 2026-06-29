import { useState } from "preact/hooks";

interface Props {
  src?: string | null;
  name?: string | null;
  size?: number;
}

// A user's cached avatar (served same-origin under our CSP) with an initials
// fallback. Falls back when there's no src or the image fails to load. The name
// is rendered as adjacent text by callers, so the image is decorative (alt="").
export function Avatar({ src, name, size = 24 }: Props) {
  const [failed, setFailed] = useState(false);
  const initial = (name ?? "?").trim().charAt(0).toUpperCase() || "?";

  if (src && !failed) {
    return (
      <img
        class="avatar-img"
        src={src}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        onError={() => setFailed(true)}
      />
    );
  }

  return (
    <span class="avatar-fallback" aria-hidden="true">
      {initial}
    </span>
  );
}
