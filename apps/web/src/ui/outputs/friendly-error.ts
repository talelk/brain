import { t } from "../../i18n";

/** A failed read in words a person can act on, never the raw server message ("artifact not found"). */
export function friendlyReadError(message: string | undefined): string {
  if (message && /not found|no such|unknown artifact|404/iu.test(message)) return t("outputs.error.gone");
  if (message && /denied|forbidden|403|401|access/iu.test(message)) return t("outputs.error.denied");
  return t("outputs.error.retry");
}
