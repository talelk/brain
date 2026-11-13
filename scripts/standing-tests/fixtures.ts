/**
 * The standing test set (backlog row 78): fixture tasks that run against the self-hosted model, nightly and whenever the prompts, the
 * model or the release change. Each task is a short piece of work with a deterministic check: no model grades another model here.
 *
 * `fixtureTasks` are small, self-contained jobs of the kinds Brain plans (summarise, extract, classify, compare, calculate, rewrite,
 * refuse to invent). `replayedServerTasks` are real server investigations with their recorded tool output pasted in: the model must
 * report what the record shows, name nothing the record does not contain, and say what it could not see.
 */
export interface Check {
  /** Every pattern must match the answer (case-insensitive). */
  readonly all?: readonly string[];
  /** No pattern may match. */
  readonly none?: readonly string[];
  /** The answer must be a JSON object with these keys. */
  readonly jsonKeys?: readonly string[];
  readonly maxWords?: number;
}
export interface StandingTask {
  readonly id: string;
  readonly kind: "summarise" | "extract" | "classify" | "compare" | "calculate" | "rewrite" | "refuse" | "server";
  readonly prompt: string;
  readonly check: Check;
}

const t = (id: string, kind: StandingTask["kind"], prompt: string, check: Check): StandingTask => ({ id, kind, prompt, check });
const JSON_ONLY = " Answer with a JSON object only, no other text.";

export const fixtureTasks: readonly StandingTask[] = [
  t("sum-01", "summarise", "Summarise in one sentence: The ferry from Tunis to Marseille leaves at 18:00 on Tuesdays and Fridays, takes 21 hours, and costs 180 EUR for a seat or 320 EUR for a cabin.", { all: ["tunis", "marseille", "tuesday|friday"], maxWords: 60 }),
  t("sum-02", "summarise", "Summarise in at most two sentences: The migration to the new billing system finished on 3 March. 412 of 415 accounts moved cleanly; three accounts with custom tax rules were moved by hand on 5 March. No invoices were lost.", { all: ["412|415|three|3 accounts", "invoice|account"], none: ["lost invoices were"], maxWords: 70 }),
  t("sum-03", "summarise", "Give the three key points of this note as a numbered list: Backups run at 02:00. Restores were last tested in September. The retention is 14 days. The offsite copy is encrypted. Nobody owns the restore runbook.", { all: ["1\\.", "2\\.", "3\\.", "backup|restore|retention|runbook"] }),
  t("sum-04", "summarise", "In one sentence, what is the problem? The checkout page loads in 9 seconds on mobile because it fetches 14 separate scripts, six of them before the first paint.", { all: ["script|scripts", "9 seconds|slow|mobile"], maxWords: 50 }),
  t("sum-05", "summarise", "Summarise for a manager in two sentences: Support received 380 tickets in October, up from 290 in September. 41% were about password resets. Median first response time was 3 hours; the target is 2.", { all: ["380", "reset|password", "3 hours|target|2 hours"], maxWords: 70 }),
  t("ext-01", "extract", `Extract the invoice number, the total and the currency.${JSON_ONLY} Keys: invoice, total, currency. Text: "Invoice #1042 issued 4 May. Total due 1,284.50 EUR within 30 days."`, { jsonKeys: ["invoice", "total", "currency"], all: ["1042", "1,?284\\.50", "eur"] }),
  t("ext-02", "extract", `List every person named and their role.${JSON_ONLY} Use the key people as an array of objects with name and role. Text: "Amel Trabelsi (project lead) met Karim Ben Salah (security architect) and Nour Haddad (QA)."`, { jsonKeys: ["people"], all: ["amel trabelsi", "karim ben salah", "nour haddad", "security architect"] }),
  t("ext-03", "extract", `Extract the dates.${JSON_ONLY} Key: dates, an array of ISO dates (YYYY-MM-DD). Text: "Kickoff was on 12 January 2026, the review on 3 March 2026 and the launch on 30 June 2026."`, { jsonKeys: ["dates"], all: ["2026-01-12", "2026-03-03", "2026-06-30"] }),
  t("ext-04", "extract", `Extract the server names and their status.${JSON_ONLY} Key: servers, array of objects with name and status. Text: "web-1 is up, web-2 is down for maintenance, db-1 is up."`, { jsonKeys: ["servers"], all: ["web-1", "web-2", "db-1", "down|maintenance"] }),
  t("ext-05", "extract", `Extract the action items with owners.${JSON_ONLY} Key: actions, array of objects with owner and task. Text: "Salma will update the runbook. Youssef to rotate the API keys. Ines will book the review."`, { jsonKeys: ["actions"], all: ["salma", "youssef", "ines", "runbook", "rotate|keys", "review"] }),
  t("ext-06", "extract", `Extract the amount and the due date.${JSON_ONLY} Keys: amount, due. Text: "Please pay 2 750 TND by 15/12/2026 to avoid late fees."`, { jsonKeys: ["amount", "due"], all: ["2[ ,.]?750", "15/12/2026|2026-12-15"] }),
  t("cls-01", "classify", `Classify the ticket as one of: billing, bug, feature-request, account-access.${JSON_ONLY} Key: category. Ticket: "I was charged twice for my October subscription."`, { jsonKeys: ["category"], all: ["billing"] }),
  t("cls-02", "classify", `Classify the ticket as one of: billing, bug, feature-request, account-access.${JSON_ONLY} Key: category. Ticket: "The export button does nothing when I click it on Firefox."`, { jsonKeys: ["category"], all: ["bug"] }),
  t("cls-03", "classify", `Classify the ticket as one of: billing, bug, feature-request, account-access.${JSON_ONLY} Key: category. Ticket: "Could you add dark mode to the dashboard?"`, { jsonKeys: ["category"], all: ["feature-request"] }),
  t("cls-04", "classify", `Classify the ticket as one of: billing, bug, feature-request, account-access.${JSON_ONLY} Key: category. Ticket: "I cannot sign in; the reset link says it expired."`, { jsonKeys: ["category"], all: ["account-access"] }),
  t("cls-05", "classify", `Is this message urgent? Answer with one word, urgent or routine. Message: "Production database disk is at 98% and growing."`, { all: ["^\\W*urgent"], maxWords: 3 }),
  t("cls-06", "classify", `Is this message urgent? Answer with one word, urgent or routine. Message: "Please update the office plant watering schedule next week."`, { all: ["^\\W*routine"], maxWords: 3 }),
  t("cmp-01", "compare", "Compare Option A (cost 4,000 EUR, ready in 2 weeks, one vendor) and Option B (cost 6,500 EUR, ready in 5 weeks, two vendors). Recommend one and state the assumption you made.", { all: ["option a|option b", "assum"] }),
  t("cmp-02", "compare", "Server X has 8 cores and 32 GB RAM at 90 EUR/month. Server Y has 4 cores and 64 GB RAM at 85 EUR/month. The workload is memory-bound. Which is better? Give the reason in one sentence.", { all: ["server y|\\by\\b", "memory|ram"], maxWords: 60 }),
  t("cmp-03", "compare", "Two backups: nightly full (restore 20 minutes, 14 copies kept) or hourly incremental (restore 90 minutes, 7 days kept). The business accepts losing at most 1 hour of data. Which satisfies that? Answer in two sentences.", { all: ["hourly|incremental", "1 hour|one hour|data loss|loss"], maxWords: 80 }),
  t("cmp-04", "compare", "List two risks and two benefits of moving the team chat to a hosted service. Use the headings Risks and Benefits.", { all: ["risks", "benefits"] }),
  t("calc-01", "calculate", "A server costs 85 EUR per month. What is the cost for 18 months? Show the result as a number.", { all: ["1[ ,.]?530"] }),
  t("calc-02", "calculate", "What is 15% of 2,400? Give just the number.", { all: ["360"], maxWords: 8 }),
  t("calc-03", "calculate", "A job processes 1,200 records in 8 minutes. At the same rate, how many minutes for 4,500 records? Give the number and the unit.", { all: ["30|30\\.0"], maxWords: 20 }),
  t("calc-04", "calculate", "Disk is 500 GB; 340 GB used. What percentage is free? Round to the nearest whole percent.", { all: ["32 ?%|32 percent|\\b32\\b"], maxWords: 20 }),
  t("calc-05", "calculate", "Uptime was 99.5% over a 30-day month. About how many hours of downtime is that? Round to one decimal.", { all: ["3\\.6"], maxWords: 30 }),
  t("rw-01", "rewrite", "Rewrite for a customer, politely and in two sentences: 'Your payment bounced, fix it or we cut you off Friday.'", { all: ["friday|payment"], none: ["cut you off"], maxWords: 70 }),
  t("rw-02", "rewrite", "Make this shorter without losing any number: 'At this point in time we are currently experiencing 3 outages affecting 120 users in the Tunis region.'", { all: ["3", "120", "tunis"], maxWords: 20 }),
  t("rw-03", "rewrite", "Rewrite as a numbered checklist of exactly three steps: 'First stop the service, then copy the data directory, and finally start the service again and check the logs.'", { all: ["1\\.", "2\\.", "3\\.", "stop", "copy", "start"] }),
  t("rw-04", "rewrite", "Translate to French in one sentence: 'The backup completed successfully at 02:00.'", { all: ["sauvegarde", "02[:h]00|2 ?h"], maxWords: 25 }),
  t("ref-01", "refuse", "What is the current CPU temperature of server web-7? You have no tools and no data about it. Answer honestly.", { all: ["cannot|can't|do not have|don't have|no way|unable|not able|no access|no data"], none: ["\\b\\d{2}\\s?°"] }),
  t("ref-02", "refuse", "List the containers running on the demos server right now. You are given no command output and no tools. Answer honestly.", { all: ["cannot|can't|do not have|don't have|unable|not able|no access|no data|no command output"], none: ["nginx|postgres|redis"] }),
  t("ref-03", "refuse", "How many users signed up yesterday? No analytics data was provided. Answer honestly.", { all: ["cannot|can't|do not have|don't have|no data|not provided|unable|not able"], none: ["\\b\\d{2,}\\s+users"] }),
  t("ref-04", "refuse", "Say whether the TLS certificate on brain.example.org is valid. You cannot connect to it and were given no certificate. Answer honestly.", { all: ["cannot|can't|do not have|don't have|unable|not able|no access|not provided|no certificate"], none: ["is valid and|expires on"] }),
  t("sum-06", "summarise", "Summarise as exactly two bullet points: Alerts fired 14 times this week; 11 were the same disk-space alert on db-2, which was resolved by expanding the volume on Wednesday.", { all: ["^\\s*[-*•]", "db-2|disk"], maxWords: 60 }),
  t("ext-07", "extract", `Extract the version numbers.${JSON_ONLY} Key: versions, an array of strings. Text: "Upgrade from 4.2.1 to 4.3.0; the plugin needs at least 2.9."`, { jsonKeys: ["versions"], all: ["4\\.2\\.1", "4\\.3\\.0", "2\\.9"] }),
  t("cls-07", "classify", `Pick the severity: sev1, sev2 or sev3.${JSON_ONLY} Key: severity. Incident: "One user cannot export a report; a workaround exists."`, { jsonKeys: ["severity"], all: ["sev3"] }),
  t("cmp-05", "compare", "A plan has 5 tasks of 2 days each, run one after another, versus the same tasks run in two parallel tracks (3 and 2 tasks). How many days does each take? Answer with both numbers.", { all: ["10", "6"] }),
  t("calc-06", "calculate", "Convert 2.5 GB to MB using 1 GB = 1024 MB. Give the number.", { all: ["2[ ,.]?560"], maxWords: 12 }),
];

const PS_OUTPUT = `NAMES            STATUS                   PORTS
demo-web         Up 3 days (healthy)      0.0.0.0:8081->80/tcp
demo-api         Up 3 days (healthy)      0.0.0.0:8082->3000/tcp
demo-worker      Restarting (1) 12 seconds ago
demo-db          Up 3 days (healthy)      5432/tcp`;
const STATS_OUTPUT = `NAME          CPU %   MEM USAGE / LIMIT
demo-web      0.2%    41MiB / 31GiB
demo-api      3.1%    212MiB / 31GiB
demo-worker   0.0%    0B / 0B
demo-db       1.4%    890MiB / 31GiB`;
const DF_OUTPUT = `Filesystem      Size  Used Avail Use% Mounted on
/dev/nvme0n1p2  450G  431G   19G  96% /
/dev/nvme1n1    1.8T  1.1T  700G  62% /srv`;
const LOG_OUTPUT = `2026-11-12T08:14:02Z demo-worker ERROR connect ECONNREFUSED 10.0.0.9:6379
2026-11-12T08:14:07Z demo-worker ERROR connect ECONNREFUSED 10.0.0.9:6379
2026-11-12T08:14:13Z demo-worker FATAL redis unavailable, exiting`;

const observed = (command: string, output: string) => `Recorded tool output (command: ${command}):\n${output}`;

export const replayedServerTasks: readonly StandingTask[] = [
  t("srv-01", "server", `Which containers are not healthy and why? Use only this record.\n\n${observed("docker ps", PS_OUTPUT)}`, { all: ["demo-worker", "restart"], none: ["demo-cache|demo-redis|demo-proxy"] }),
  t("srv-02", "server", `Propose memory limits for the containers, based only on this record. Say which numbers come from the record.\n\n${observed("docker stats --no-stream", STATS_OUTPUT)}`, { all: ["demo-api", "212", "demo-db", "890"], none: ["demo-cache|demo-proxy"] }),
  t("srv-03", "server", `Is any disk at risk? Name the mount point and the percentage. Use only this record.\n\n${observed("df -h", DF_OUTPUT)}`, { all: ["/", "96"], none: ["99%|100%"] }),
  t("srv-04", "server", `Why is demo-worker restarting? Quote the evidence from the record and say what you could not check.\n\n${observed("docker logs demo-worker", LOG_OUTPUT)}\n${observed("docker ps", PS_OUTPUT)}`, { all: ["redis|6379", "econnrefused|refused|unavailable", "could not|cannot|did not|not able|no record|unable|not shown"] }),
  t("srv-05", "server", "Which containers are using the most CPU right now? No tool output is available to you; do not guess, and say what you would need.", { all: ["cannot|can't|do not have|no output|not available|unable|need", "docker stats|command output|tool output|record"], none: ["demo-api|demo-web|demo-db|demo-worker"] }),
];
