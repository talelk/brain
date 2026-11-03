import type { JSX } from "solid-js";
import { TvBoard } from "./helpers";

export default function TvSupportPage(): JSX.Element {
  return <div class="brain-tv-dense">
    <TvBoard area="support" />
    <style>{`
      .brain-tv-dense [data-testid="tv-kiosk"] { padding: var(--spacing-5); }
      .brain-tv-dense [data-testid="tv-kiosk"] > div { gap: var(--spacing-5); }
      .brain-tv-dense header { gap: var(--spacing-4); padding-bottom: var(--spacing-4); }
      .brain-tv-dense article, .brain-tv-dense section { min-width: 0; overflow-wrap: anywhere; }
      @media (min-width: 1600px) {
        .brain-tv-dense [data-testid="tv-kiosk"] > div { gap: var(--spacing-4); }
        .brain-tv-dense section[aria-label="Highest severity incident"] { padding: var(--spacing-5); }
        .brain-tv-dense section[aria-label="Highest severity incident"] h2 { margin-top: var(--spacing-2); font-size: 2rem; }
        .brain-tv-dense section[aria-label="Highest severity incident"] > div:last-child { margin-top: var(--spacing-3); }
        .brain-tv-dense section[aria-label="Support exception queue"] .grid,
        .brain-tv-dense section[aria-label="Other observed incidents"] .grid { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--spacing-3); }
        .brain-tv-dense article { padding: var(--spacing-4); }
      }
    `}</style>
  </div>;
}
