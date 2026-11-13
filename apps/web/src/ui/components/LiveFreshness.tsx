import { onCleanup, onMount } from "solid-js";
import type { JSX } from "solid-js";
import { Button } from "@talelk/newui-atoms";
import { liveConnected, liveNow, liveUpdatedAt, liveUpdating, refreshLiveNow, useClock } from "../../data/live";
import { t } from "../../i18n";

/**
 * The one freshness control: when the screens were last re-read together, and the one Refresh that
 * re-reads all of them. Pages carry no refresh buttons of their own, so two parts of a page can
 * never show different ages (phase 2).
 */
export function LiveFreshness(): JSX.Element {
  onMount(() => { const release = useClock(); onCleanup(release); });
  const clock = liveNow();
  const label = () => {
    if (!liveConnected()) return t("live.reconnecting");
    if (liveUpdating()) return t("live.updating");
    const seconds = Math.max(0, Math.floor((clock() - liveUpdatedAt()) / 1000));
    if (seconds < 10) return t("live.updatedNow");
    return seconds < 90 ? t("live.updatedSeconds", { n: seconds }) : t("live.updatedMinutes", { n: Math.round(seconds / 60) });
  };
  return <div class="flex items-center gap-1" data-testid="live-freshness">
    <span class="max-lg:sr-only text-caption text-ink-gray-6" role="status" aria-live="off">{label()}</span>
    <Button variant="ghost" iconLeft="lucide-refresh-cw" aria-label={t("live.refresh")} title={t("live.refresh")} onClick={refreshLiveNow} />
  </div>;
}
