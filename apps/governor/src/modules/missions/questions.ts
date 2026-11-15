import type { Store } from "../../application/store";
import { BrainDomainError } from "../../domain/errors";

type Db = ReturnType<Store["workspaceDb"]>;

/**
 * What stops a session from spamming people (ADR 0048). A session is one attempt: it may ask this many questions in all, and one member may
 * have this many waiting for a person at once, so a task that fails and starts a new attempt cannot start the count over.
 */
export const MAX_QUESTIONS_PER_SESSION = 3;
export const MAX_OPEN_QUESTIONS_PER_MEMBER = 2;

export type QuestionRow = { id: string; mission_id: string; member_id: string; work_item_id: string | null; attempt_id: string; asker_id: string; body: string; created_at_ms: number };

/** The question, with whether a person has answered it. Answered is read from the answer message, never stored on the question. */
export function questionOf(db: Db, questionId: string, missionId: string): { question: QuestionRow; answered: boolean } {
  const question = db.prepare("SELECT * FROM mission_questions WHERE id=? AND mission_id=?").get(questionId, missionId) as QuestionRow | undefined;
  if (!question) throw new BrainDomainError("NOT_FOUND", "question not found in this mission");
  return { question, answered: db.prepare("SELECT 1 FROM mission_messages WHERE answers_question_id=?").get(questionId) !== undefined };
}

/** A session's question to a person: written once. The caps are checked here, in the command's own transaction, so two asks cannot both slip under them. */
export function recordQuestion(store: Store, db: Db, input: { missionId: string; memberId: string; attemptId: string; askerId: string; workItemId?: string; body: string }): string {
  if (input.workItemId && !db.prepare("SELECT 1 FROM work_items WHERE id=? AND mission_id=?").get(input.workItemId, input.missionId)) throw new BrainDomainError("NOT_FOUND", "work item not found in this mission");
  const asked = (db.prepare("SELECT COUNT(*) AS n FROM mission_questions WHERE attempt_id=?").get(input.attemptId) as { n: number }).n;
  if (asked >= MAX_QUESTIONS_PER_SESSION) throw new BrainDomainError("CONFLICT", `you have already asked ${asked} questions in this session; carry on with what you know and say in your answer what is still open`);
  const open = (db.prepare("SELECT COUNT(*) AS n FROM mission_questions q WHERE q.mission_id=? AND q.member_id=? AND NOT EXISTS (SELECT 1 FROM mission_messages a WHERE a.answers_question_id=q.id)").get(input.missionId, input.memberId) as { n: number }).n;
  if (open >= MAX_OPEN_QUESTIONS_PER_MEMBER) throw new BrainDomainError("CONFLICT", `${open} of your questions are still waiting for a person; carry on and wait for their answers before asking more`);
  const id = store.id("question");
  db.prepare("INSERT INTO mission_questions(id,mission_id,member_id,work_item_id,attempt_id,asker_id,body,created_at_ms) VALUES (?,?,?,?,?,?,?,?)")
    .run(id, input.missionId, input.memberId, input.workItemId ?? null, input.attemptId, input.askerId, input.body, store.now());
  store.emit(db, { aggregateType: "mission", aggregateId: input.missionId, eventType: "mission.questionAsked", payload: { missionId: input.missionId } });
  return id;
}
