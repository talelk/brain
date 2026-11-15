import type { PlacementExplanation } from "@brain/contracts";
import { t, type MessageKey } from "../../i18n";
import { formatDateTime } from "../format";

export type Choice = PlacementExplanation["choices"][number];
type Facts = Record<string, unknown>;

const text = (value: unknown): string => (typeof value === "string" || typeof value === "number" ? String(value) : "");
const list = (value: unknown): string[] => (Array.isArray(value) ? value.map(text).filter(Boolean) : []);
const rows = (value: unknown): Facts[] => (Array.isArray(value) ? value.filter((row): row is Facts => typeof row === "object" && row !== null) : []);
const known = (prefix: string, code: string): MessageKey => `why.${prefix}.${code}` as MessageKey;
const when = (iso: string): string => (iso ? formatDateTime(iso) : "");

/** The role a model route served, in the glossary's words. */
const roleWord = (role: string): string => (role === "evaluator" ? t("why.role.evaluator") : role === "second-attempt" ? t("why.role.secondAttempt") : role === "judge" ? t("why.role.judge") : role);

function skippedLine(skip: Facts): string {
  const why = text(skip["why"]);
  return t(known("route.skipped", why), { route: text(skip["routeId"]), until: when(text(skip["until"])) });
}

/** One recorded choice as a plain sentence and the facts it was judged by, one per line. Nothing here is computed from today's state: it only words what was recorded. */
export function choiceView(choice: Choice): { title: string; lines: string[] } {
  const facts = choice.facts as Facts;
  if (choice.kind === "way-of-working") {
    const rejected = rows(facts["rejected"]).map((row) => {
      const why = text(row["why"]);
      return t(known("wow.rejected", why), { workflow: text(row["workflowId"]), tools: list(row["missingTools"]).join(", "), detail: text(row["detail"]) });
    });
    const tools = list(facts["requiredTools"]);
    return {
      title: t(known("wow", choice.code), { workflow: text(facts["workflowId"]) }),
      lines: [tools.length ? t("why.wow.tools", { tools: tools.join(", ") }) : t("why.wow.noTools"), ...rejected],
    };
  }
  if (choice.kind === "team-member") {
    const others = list(facts["alsoEligible"]);
    const tools = list(facts["requiredTools"]);
    const cap = typeof facts["taskMaxMicroUsd"] === "number" ? t("why.member.cap", { task: (Number(facts["taskMaxMicroUsd"]) / 1_000_000).toFixed(2), agent: (Number(facts["agentMaxMicroUsd"]) / 1_000_000).toFixed(2) }) : "";
    return {
      title: t("why.member.chosen", { member: text(facts["memberId"]), role: text(facts["role"]) }),
      lines: [
        t("why.member.agent", { agent: text(facts["agentId"]), engine: text(facts["engine"]) }),
        tools.length ? t("why.member.tools", { tools: tools.join(", ") }) : t("why.member.noTools"),
        ...(cap ? [cap] : []),
        others.length ? t("why.member.others", { members: others.join(", ") }) : t("why.member.alone"),
      ],
    };
  }
  const role = roleWord(text(facts["role"]));
  if (choice.code === "first-route") {
    const behind = rows(facts["fallbacks"]).map((row) => `${text(row["model"])} (${text(row["routeId"])})`);
    return {
      title: t("why.route.first", { role, model: text(facts["model"]), route: text(facts["routeId"]), position: text(facts["position"]), tier: text(facts["costTier"]) }),
      lines: [
        behind.length ? t("why.route.behind", { routes: behind.join(", ") }) : t("why.route.alone"),
        ...(list(facts["agentPrefers"]).length ? [t("why.route.prefers", { routes: list(facts["agentPrefers"]).join(", ") })] : []),
        ...(text(facts["agentCostCeiling"]) ? [t("why.route.ceiling", { tier: text(facts["agentCostCeiling"]) })] : []),
        ...rows(facts["skipped"]).map(skippedLine),
      ],
    };
  }
  if (choice.code === "held") {
    return {
      title: t("why.route.held", { role }),
      lines: [...rows(facts["skipped"]).map(skippedLine), ...(text(facts["retryAt"]) ? [t("why.route.retryAt", { at: when(text(facts["retryAt"])) })] : [])],
    };
  }
  const tried = rows(facts["tried"]);
  const passed = tried.filter((row) => row["outcome"] !== "served").map((row) => text(row["routeId"]));
  return {
    title: choice.code === "none-served" ? t("why.route.noneServed") : t("why.route.served", { model: text(facts["model"]), route: text(facts["servedBy"]) }),
    lines: passed.length ? [t("why.route.passed", { routes: passed.join(", ") })] : [],
  };
}
