import { createContext, useContext, type Accessor, type JSX } from "solid-js";
import type { Role, Today, User, Workspace, WorkspaceSummary } from "@brain/contracts";
import { roleAtLeast } from "../lib/model";
import { useQuery, type Loaded } from "./api";

/** Who is signed in and which workspace the page is in. Screens read these instead of asking again. */
export interface Session {
  readonly user: Accessor<User>;
  readonly workspaces: Accessor<readonly WorkspaceSummary[]>;
  readonly refetch: () => void;
}
const SessionContext = createContext<Session>();
export const SessionProvider = (props: { value: Session; children: JSX.Element }): JSX.Element => <SessionContext.Provider value={props.value}>{props.children}</SessionContext.Provider>;
export function useSession(): Session {
  const value = useContext(SessionContext);
  if (!value) throw new Error("no session");
  return value;
}

export interface Place {
  readonly summary: Accessor<WorkspaceSummary>;
  readonly id: Accessor<string>;
  /** The active snapshot: agents, tools, Plays, memory, projects and settings. */
  readonly workspace: Loaded<Workspace>;
  readonly today: Loaded<Today>;
  /** An address inside this workspace. */
  readonly to: (path?: string) => string;
  readonly can: (need: Role) => boolean;
}
const PlaceContext = createContext<Place>();
export function PlaceProvider(props: { summary: Accessor<WorkspaceSummary>; children: JSX.Element }): JSX.Element {
  const id = (): string => props.summary().id;
  const place: Place = {
    summary: props.summary,
    id,
    workspace: useQuery("workspace.get", () => ({ workspaceId: id() })),
    today: useQuery("today", () => ({ workspaceId: id() })),
    to: (path = "") => `/w/${props.summary().slug}${path}`,
    can: (need) => roleAtLeast(props.summary().role, need),
  };
  return <PlaceContext.Provider value={place}>{props.children}</PlaceContext.Provider>;
}
export function usePlace(): Place {
  const value = useContext(PlaceContext);
  if (!value) throw new Error("no workspace");
  return value;
}
