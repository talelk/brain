import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as links from "../../apps/governor/src/modules/operations/notification-links";
import { AREA_NAVIGATION, ROUTES } from "../../apps/web/src/routes/index.gen";

/**
 * Environment guard: every in-app link an outbound notification carries (push, webhook, email) is built in notification-links.ts and
 * must resolve to a screen in the generated route table. The router's catch-all sends an unknown path to `/`, so a stale link
 * (the platform alert once pointed at /w/:id/health) silently lands somewhere else.
 */
const ROOT = join(__dirname, "../..");

/** One realistic input per builder. A builder added without a sample fails below, so none can skip the route check. */
const SAMPLES: Readonly<Record<string, readonly string[]>> = {
  platformAlertLink: [links.platformAlertLink()],
  approvalLink: [links.approvalLink(), links.approvalLink("apr-1")],
  digestLink: [links.digestLink("ws-1")],
  securitySettingsLink: [links.securitySettingsLink()],
  attentionLink: [
    links.attentionLink({ kind: "result-ready", workspaceId: "ws-1", missionId: "m-1", resourceId: "m-1" }),
    links.attentionLink({ kind: "result-ready", workspaceId: "ws-1", missionId: "m-1", resourceId: "wi-1" }),
    links.attentionLink({ kind: "result-ready", workspaceId: "ws-1", missionId: "m-1", knowledgeAssetId: "ka-1" }),
    links.attentionLink({ kind: "needs-attention", workspaceId: "ws-1", missionId: "m-1", resourceId: "m-1" }),
    links.attentionLink({ kind: "budget-pause", workspaceId: "ws-1", missionId: "m-1", resourceId: "m-1" }),
  ],
};

const matches = (pattern: string, path: string): boolean => {
  const want = pattern.split("/").filter(Boolean);
  const have = path.split("/").filter(Boolean);
  return want.length === have.length && want.every((part, index) => part.startsWith(":") || part === have[index]);
};
/** The tabs a `/settings?tab=` link may name are the ones the administration navigation offers. */
const settingsTabs = new Set((AREA_NAVIGATION["administration"] ?? []).flatMap((entry) => (entry.route.startsWith("/settings?tab=") ? [entry.route.slice("/settings?tab=".length)] : [])));

describe("notification links resolve to screens", () => {
  it("every builder has a sample, and every sample is a route in the generated table", () => {
    const builders = Object.entries(links).filter(([, value]) => typeof value === "function").map(([name]) => name);
    expect(builders.sort(), "a notification link builder without a sample in this test").toEqual(Object.keys(SAMPLES).sort());
    const unknown: string[] = [];
    for (const [name, urls] of Object.entries(SAMPLES)) {
      for (const url of urls) {
        const parsed = new URL(url, "http://brain.invalid");
        if (!ROUTES.some((route) => matches(route.route, parsed.pathname))) unknown.push(`${name}: ${url} matches no route`);
        const tab = parsed.searchParams.get("tab");
        if (parsed.pathname === "/settings" && tab && !settingsTabs.has(tab)) unknown.push(`${name}: ${url} names an unknown settings tab`);
      }
    }
    expect(unknown).toEqual([]);
  });

  it("the platform alert opens the Health tab", () => {
    expect(links.platformAlertLink()).toBe("/settings?tab=health");
    expect(settingsTabs.has("health")).toBe(true);
  });

  it("no notification code builds a link outside the builders", () => {
    const dirs = [join(ROOT, "apps/governor/src/application"), join(ROOT, "apps/governor/src/modules/operations")];
    const stray: string[] = [];
    for (const dir of dirs) {
      for (const name of readdirSync(dir).filter((file) => file.endsWith(".ts") && file !== "notification-links.ts")) {
        const text = readFileSync(join(dir, name), "utf8");
        for (const match of text.matchAll(/\burl: ["`]\//gu)) stray.push(`${name}: ${text.slice(match.index, match.index + 40)}`);
      }
    }
    expect(stray, "build the link in notification-links.ts so the route check covers it").toEqual([]);
  });
});
