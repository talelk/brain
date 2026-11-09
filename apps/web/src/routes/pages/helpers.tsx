import { useApp } from "../../ui/app-context";

export function useDetailWorkspace(): () => string {
  const app = useApp();
  return () => app.workspaceId() || app.identity()?.workspaces[0]?.workspaceId || "";
}

export function monthPeriod(): { periodStart: string; periodEnd: string } {
  const now = new Date();
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return { periodStart: periodStart.toISOString(), periodEnd: now.toISOString() };
}
