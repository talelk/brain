import { actingAs, systemActor } from "../../apps/governor/src/application/actor-context";
import type { Store } from "../../apps/governor/src/application/store";

/** Writes an event the way a fixture needs one: as a named system principal, since a store write outside any actor scope is refused in a test run (ADR 0032). */
export const seedEvent = (store: Store, db: Parameters<Store["emit"]>[0], input: Parameters<Store["emit"]>[1]): string => actingAs(systemActor("test-seed"), () => store.emit(db, input));
