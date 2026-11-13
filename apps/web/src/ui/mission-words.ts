import type { Mission } from "@brain/contracts";
import { t, type MessageKey } from "../i18n";

const STATE_KEYS: Readonly<Record<Mission["state"], MessageKey>> = {
  active: "mission.state.active", paused: "mission.state.paused", verifying: "mission.state.verifying", closed: "mission.state.closed",
};
const OUTCOME_KEYS: Readonly<Record<NonNullable<Mission["outcome"]>, MessageKey>> = {
  achieved: "mission.outcome.achieved", ended: "mission.outcome.ended", cancelled: "mission.outcome.cancelled",
};
const PAUSE_KEYS: Readonly<Record<NonNullable<Mission["pauseReason"]>, MessageKey>> = { human: "mission.pause.human", budget: "mission.pause.budget" };

/** A mission's state in the current language (one place, so a list row and a header never word it differently). */
export const missionStateLabel = (state: Mission["state"]): string => t(STATE_KEYS[state]);
export const missionOutcomeLabel = (outcome: NonNullable<Mission["outcome"]>): string => t(OUTCOME_KEYS[outcome]);
export const missionPauseLabel = (reason: NonNullable<Mission["pauseReason"]>): string => t(PAUSE_KEYS[reason]);
