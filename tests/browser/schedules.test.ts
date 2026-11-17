import { expect, openWorkspace, signIn, starter, test } from "./stack";

const PLAY = (title: string, trigger: string) => `title = "${title}"\n${trigger}\n[[step]]\nid = "write"\nagent = "worker"\ngoal = "Write the report."\n`;

test("schedules: one list of every Play that starts by itself, a form to schedule one in plain words, pause and remove @phone", async ({ page, stack }) => {
  const api = await stack.setUp();
  const workspace = await starter(api);
  await workspace.write({
    "brain.toml": 'name = "Starter"\ntimezone = "Africa/Tunis"\npacks = ["base"]\n',
    "plays/report.toml": PLAY("Weekly report", '[trigger]\nschedule = "0 8 * * 1"'),
    "plays/on-issue.toml": PLAY("Triage issues", '[trigger]\nwebhook = "github.issues.opened"'),
    "plays/digest.toml": PLAY("Daily digest", ""),
  });
  await signIn(page, stack);
  const nav = page.getByRole("navigation", { name: "Main" });
  if (!(await nav.isVisible())) await page.getByRole("button", { name: "Open application navigation" }).click();
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Schedules" }).first().click();
  await expect(page.getByRole("heading", { level: 1, name: "Schedules" })).toBeVisible();

  // The scheduled Play says when in words, with the raw cron, its time zone, its next start and what it will do; the webhook one is listed too.
  const report = page.getByRole("listitem").filter({ hasText: "Weekly report" });
  await expect(report.getByText("Every Monday at 08:00, Africa/Tunis")).toBeVisible();
  await expect(report.getByText("0 8 * * 1")).toBeVisible();
  await expect(report.getByText("Never started")).toBeVisible();
  await expect(report.getByText("write")).toBeVisible();
  await expect(report.getByText("Active")).toBeVisible();
  expect((await api.query("schedules.list", {})).schedules.find((item) => item.play === "report")?.nextRunAt).toBeGreaterThan(Date.now());
  const hook = page.getByRole("listitem").filter({ hasText: "Triage issues" });
  await expect(hook.getByText("On GitHub issues opened")).toBeVisible();

  // Schedule a Play: a preset, a live preview of the next three times, and the file is written and committed.
  await page.getByRole("button", { name: "Schedule a Play" }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("combobox", { name: "Play" }).click();
  await page.getByRole("option", { name: "Daily digest" }).click();
  await dialog.getByRole("combobox", { name: "Repeat" }).click();
  await page.getByRole("option", { name: "Every month" }).click();
  await dialog.getByLabel("Day of the month").fill("15");
  await dialog.getByLabel("At", { exact: true }).fill("09:30");
  await expect(dialog.getByText("On day 15 of every month at 09:30, Africa/Tunis")).toBeVisible();
  await expect(dialog.getByRole("list", { name: /Next three times/u }).getByRole("listitem")).toHaveCount(3);
  // The advanced field checks as it is typed.
  await dialog.getByRole("combobox", { name: "Repeat" }).click();
  await page.getByRole("option", { name: "Advanced (cron)" }).click();
  await dialog.getByLabel("Cron expression").fill("99 * * * *");
  await expect(dialog.getByText("This is not a schedule that ever comes.").first()).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Save" })).toBeDisabled();
  await dialog.getByLabel("Cron expression").fill("30 9 15 * *");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("listitem").filter({ hasText: "Daily digest" }).getByText("On day 15 of every month at 09:30, Africa/Tunis")).toBeVisible();
  expect((await api.query("file.read", { workspaceId: workspace.id, path: "plays/digest.toml" })).content).toContain('schedule = "30 9 15 * *"');

  // Pause keeps the Play listed and says nothing is next; resume brings the next time back; remove takes the trigger out.
  const digest = page.getByRole("listitem").filter({ hasText: "Daily digest" });
  await digest.getByRole("button", { name: "Pause" }).click();
  await expect(digest.getByText("Paused").first()).toBeVisible();
  expect((await api.query("file.read", { workspaceId: workspace.id, path: "plays/digest.toml" })).content).toContain("paused = true");
  await digest.getByRole("button", { name: "Resume" }).click();
  await expect(digest.getByText("Active")).toBeVisible();
  await digest.getByRole("button", { name: "Change" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Remove the schedule" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByRole("listitem").filter({ hasText: "Daily digest" })).toHaveCount(0);
  expect((await api.query("file.read", { workspaceId: workspace.id, path: "plays/digest.toml" })).content).not.toContain("trigger");
  await openWorkspace(page, "Starter");
});
