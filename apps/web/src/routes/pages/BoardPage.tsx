import type { JSX } from "solid-js";
import { t } from "../../i18n";
import { BrainPage } from "../../ui/components/PageLayout";
import { WorkspaceBoard } from "../../ui/work/WorkspaceBoard";

/**
 * `/w/:id/board` (#118): the work of every mission in the workspace on one board, a view of Missions like Live and
 * Schedules. Mission, team member, priority and tag live in the address; the cards move as on a mission's board.
 */
export default function BoardPage(): JSX.Element {
  return <BrainPage title={t("board.title")} description={t("board.description")}>
    <WorkspaceBoard />
  </BrainPage>;
}
