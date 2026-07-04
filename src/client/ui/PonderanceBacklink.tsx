// A quiet backlink to the parent site, ponderance.dev. Lives on the right of the
// top bars in both the studio Toolbar and the page PageNav. The double bar (a
// crease-blue "double barline") separates the app's own controls from the parent
// brand; the amber constellation mark + lowercase wordmark echo ponderance's own
// header lockup. Opens in a new tab so an in-progress drawing is never lost.
export function PonderanceBacklink() {
  return (
    <a
      class="pdr-link"
      href="https://ponderance.dev"
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Ponderance — anmol's site (opens in a new tab)"
      title="Part of ponderance.dev"
    >
      <span class="pdr-bars" aria-hidden="true">
        <i />
        <i />
      </span>
      <img class="pdr-mark" src="/ponderance-mark.svg" width="22" height="22" alt="" aria-hidden="true" />
      <span class="pdr-word">ponderance</span>
    </a>
  );
}
