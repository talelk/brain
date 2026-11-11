import type { JsonValue } from "@brain/contracts";
import { BrainDomainError } from "../../domain/errors";
import { iso } from "../../domain/clock";
import { nextCronFire, parseCron } from "../workflows/index";

/**
 * The preset schedules behind "Repeat this" (#56). The cron expression for
 * each preset lives here, on the server, so the browser never writes or
 * translates cron; the client submits what this read returns through the
 * ordinary `automation.upsert`.
 */
const PRESETS = [
  { presetId: "weekdays-0800", label: "Every weekday at 08:00", cron: "0 8 * * 1-5" },
  { presetId: "weekly-monday-0800", label: "Every Monday at 08:00", cron: "0 8 * * 1" },
  { presetId: "monthly-first-0800", label: "The first day of every month at 08:00", cron: "0 8 1 * *" },
] as const;

/** An IANA timezone the runtime knows, else INVALID_ARGUMENT. */
export function requireTimezone(timezone: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    throw new BrainDomainError("INVALID_ARGUMENT", `${timezone} is not a timezone Brain knows (use a name like Europe/Paris)`);
  }
  return timezone;
}

/** The next `count` instants a cron fires in a timezone, computed from `fromMs`. */
export function nextFires(cron: string, timezone: string, fromMs: number, count = 5): number[] {
  const spec = parseCron(cron);
  const fires: number[] = [];
  let cursor = fromMs;
  while (fires.length < count) {
    const next = nextCronFire(spec, timezone, cursor);
    if (next === null) break;
    fires.push(next);
    cursor = next;
  }
  return fires;
}

/** `automations.preview`: every preset (or the one asked for) with its next five fires, in the requested timezone. */
export function presetPreview(nowMs: number, presetId: string | undefined, timezone: string | undefined): JsonValue {
  const zone = requireTimezone(timezone?.trim() || "UTC");
  const chosen = presetId ? PRESETS.filter((preset) => preset.presetId === presetId) : PRESETS;
  if (presetId && chosen.length === 0) throw new BrainDomainError("NOT_FOUND", `no schedule preset ${presetId}`);
  return {
    timezone: zone,
    presets: chosen.map((preset) => ({ ...preset, timezone: zone, nextOccurrences: nextFires(preset.cron, zone, nowMs).map(iso) })),
  } as unknown as JsonValue;
}
