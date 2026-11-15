import type { EstimateBasis } from "@brain/contracts";
import { formatUsd } from "../format";

export const minutesText = (minutes: number): string => (minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ""}`);

/** Where a figure comes from, in the words a person reads next to it. The Governor decides the basis; this only words it. */
export function basisWords(basis: EstimateBasis | undefined): string {
  if (!basis || basis.kind === "unknown") return "unknown";
  if (basis.kind === "declared") return "declared by the planner";
  const runs = `${basis.runs ?? 0} ${basis.runs === 1 ? "run" : "runs"}`;
  return basis.kind === "history" ? `median of ${runs}` : `median of at least ${runs} for some tasks, declared by the planner for the rest`;
}

/** The typical range (25th to 75th percentile of past runs), when the sample was large enough to have one. */
export function rangeWords(basis: EstimateBasis | undefined, unit: "minutes" | "usd"): string {
  if (basis?.low === undefined || basis.high === undefined || basis.kind === "declared") return "";
  const text = unit === "minutes" ? minutesText : formatUsd;
  return `; typically ${text(basis.low)} to ${text(basis.high)}`;
}
