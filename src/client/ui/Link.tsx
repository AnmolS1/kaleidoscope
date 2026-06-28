import type { ComponentChildren } from "preact";
import { navigate } from "../state";

// Internal link that routes client-side (preserves modifier-click behavior).
export function Link(props: { href: string; class?: string; children: ComponentChildren; "aria-label"?: string }) {
  return (
    <a
      href={props.href}
      class={props.class}
      aria-label={props["aria-label"]}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(props.href);
      }}
    >
      {props.children}
    </a>
  );
}
