import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { STATE_MACHINES, canTransition } from "@brain/contracts";
import { transitionState, bulkTransition, statesTransitioningTo, MACHINE_TABLE } from "../../apps/governor/src/domain/states";

/**
 * State-machine seam: every state change of a machine-declared table must
 * flow through domain/states.ts. This test pins the invariant that no other
 * governor source writes `state` on those tables, and exercises the seam's
 * semantics (legal write, idempotent no-op, illegal/terminal rejection,
 * concurrent-change rejection, machine-derived bulk sweeps).
 */

const SEAM_FILE = join("apps", "governor", "src", "domain", "states.ts");
const DECLARED_TABLES = Object.values(MACHINE_TABLE).map((b) => b.table);

function sourceFiles(dir: string, extensions = [".ts"]): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(path, extensions));
    else if (extensions.some((e) => entry.name.endsWith(e))) found.push(path);
  }
  return found;
}

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE jobs(id TEXT PRIMARY KEY, state TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
    attempt_counter INTEGER NOT NULL DEFAULT 0, job_fence INTEGER NOT NULL DEFAULT 0, queue_reason TEXT);
    CREATE TABLE job_attempts(id TEXT PRIMARY KEY, job_id TEXT, state TEXT NOT NULL);
    CREATE TABLE approval_requests(id TEXT PRIMARY KEY, state TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE workflow_runs(id TEXT PRIMARY KEY, state TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, wait_generation INTEGER NOT NULL DEFAULT 0);`);
  return db;
}

describe("state-machine seam", () => {
  it("no governor source writes state on a machine-declared table outside domain/states.ts", () => {
    const pattern = new RegExp(`UPDATE\\s+(${DECLARED_TABLES.join("|")})\\s+SET[^\\n]*\\bstate\\s*=`, "iu");
    const offenders: string[] = [];
    for (const file of sourceFiles(join(process.cwd(), "apps/governor/src"))) {
      if (file.endsWith(SEAM_FILE)) continue;
      if (pattern.test(readFileSync(file, "utf8"))) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it("MACHINE_TABLE binds exactly the machines declared in contracts", () => {
    expect(Object.keys(MACHINE_TABLE).sort()).toEqual(Object.keys(STATE_MACHINES.machines).sort());
  });

  it("statesTransitioningTo is the exact inverse of the machine relation", () => {
    for (const [machine, transitions] of Object.entries(STATE_MACHINES.machines)) {
      const allStates = Object.keys(transitions);
      for (const to of new Set([...allStates, ...allStates.flatMap((s) => transitions[s] ?? [])])) {
        const froms = statesTransitioningTo(machine, to);
        for (const from of allStates) {
          expect(froms.includes(from), `${machine}: ${from} -> ${to}`).toBe(canTransition(machine, from, to));
        }
      }
    }
  });

  it("applies a legal transition with CAS and version bump", () => {
    const db = freshDb();
    db.prepare("INSERT INTO jobs(id,state) VALUES('j1','queued')").run();
    expect(transitionState(db, "job", "j1", "offered", { bumpVersion: true })).toBe(true);
    expect(db.prepare("SELECT state,version FROM jobs WHERE id='j1'").get()).toEqual({ state: "offered", version: 2 });
  });

  it("writes extra columns and computed fragments in the same statement", () => {
    const db = freshDb();
    db.prepare("INSERT INTO jobs(id,state) VALUES('j1','queued')").run();
    transitionState(db, "job", "j1", "offered", {
      rawSet: ["attempt_counter=attempt_counter+1", "job_fence=job_fence+1"], bumpVersion: true,
    });
    expect(db.prepare("SELECT state,attempt_counter,job_fence FROM jobs WHERE id='j1'").get())
      .toEqual({ state: "offered", attempt_counter: 1, job_fence: 1 });
  });

  it("is an idempotent no-op when the row already sits in the target state", () => {
    const db = freshDb();
    db.prepare("INSERT INTO jobs(id,state) VALUES('j1','running')").run();
    expect(transitionState(db, "job", "j1", "running", { bumpVersion: true })).toBe(false);
    expect(db.prepare("SELECT version FROM jobs WHERE id='j1'").get()).toEqual({ version: 1 });
  });

  it("rejects an illegal transition without writing", () => {
    const db = freshDb();
    db.prepare("INSERT INTO jobs(id,state) VALUES('j1','queued')").run();
    expect(() => transitionState(db, "job", "j1", "succeeded")).toThrow(/job illegal transition queued -> succeeded/);
    expect(db.prepare("SELECT state FROM jobs WHERE id='j1'").get()).toEqual({ state: "queued" });
  });

  it("rejects a transition out of a terminal state", () => {
    const db = freshDb();
    db.prepare("INSERT INTO jobs(id,state) VALUES('j1','succeeded')").run();
    expect(() => transitionState(db, "job", "j1", "running")).toThrow(/terminal state succeeded/);
  });

  it("throws CONFLICT when a concurrent change defeats the CAS", () => {
    const db = freshDb();
    db.prepare("INSERT INTO jobs(id,state) VALUES('j1','queued')").run();
    // The row is queued, but the caller's stale version guard cannot match.
    expect(() => transitionState(db, "job", "j1", "offered", { and: { version: 99 } })).toThrow(/changed concurrently/);
    expect(db.prepare("SELECT state FROM jobs WHERE id='j1'").get()).toEqual({ state: "queued" });
  });

  it("throws NOT_FOUND for a missing row", () => {
    const db = freshDb();
    expect(() => transitionState(db, "job", "nope", "running")).toThrow(/not found/);
  });

  it("bulkTransition moves exactly the rows in legal from-states", () => {
    const db = freshDb();
    for (const [id, state] of [["j1", "queued"], ["j2", "offered"], ["j3", "running"], ["j4", "verifying"], ["j5", "succeeded"]] as const) {
      db.prepare("INSERT INTO jobs(id,state) VALUES(?,?)").run(id, state);
    }
    // job: only running and verifying legally reach outcome_unknown.
    expect(bulkTransition(db, "job", "outcome_unknown", { bumpVersion: true })).toBe(2);
    const after = Object.fromEntries((db.prepare("SELECT id,state FROM jobs ORDER BY id").all() as Array<{ id: string; state: string }>).map((r) => [r.id, r.state]));
    expect(after).toEqual({ j1: "queued", j2: "offered", j3: "outcome_unknown", j4: "outcome_unknown", j5: "succeeded" });
  });

  it("bulkTransition honours extra CAS predicates", () => {
    const db = freshDb();
    db.prepare("INSERT INTO workflow_runs(id,state) VALUES('r1','running'),('r2','running'),('r3','succeeded')").run();
    expect(bulkTransition(db, "workflow", "cancelled", { and: { id: "r1" }, bumpVersion: true })).toBe(1);
    expect(db.prepare("SELECT state FROM workflow_runs WHERE id='r1'").get()).toEqual({ state: "cancelled" });
    expect(db.prepare("SELECT state FROM workflow_runs WHERE id='r2'").get()).toEqual({ state: "running" });
  });

  it("approval revoke follows the declared machine, not an ad-hoc guard", () => {
    const db = freshDb();
    db.prepare("INSERT INTO approval_requests(id,state) VALUES('a1','pending'),('a2','rejected')").run();
    expect(transitionState(db, "approval", "a1", "revoked", { bumpVersion: true })).toBe(true);
    // rejected is terminal in the approval machine.
    expect(() => transitionState(db, "approval", "a2", "revoked")).toThrow(/terminal state rejected/);
  });
});
