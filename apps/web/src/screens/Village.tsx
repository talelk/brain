import type { JSX } from "solid-js";
import { Board } from "./Live";

/** Village: the same live answers as Live, drawn as a small role-playing game; its ambient mode fills the screen with the village. */
export default function VillageScreen(): JSX.Element {
  return <Board view="village" />;
}
