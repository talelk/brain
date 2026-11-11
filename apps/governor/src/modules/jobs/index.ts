/**
 * jobs module: the runner session protocol, the attempt lifecycle and both
 * dispatch loops live behind one interface — JobProtocol, constructed once
 * with the Store and the host ports. The two row primitives below are the
 * declared cross-module surface: governance permits and evidence artifact
 * ingestion assert against live attempt rows without owning them, and the
 * operations module reads runner views / issues enrollment tokens. The jobs
 * module is the only writer of jobs and job attempts (check-boundaries);
 * operations restore holds every live job through quarantineJobsForRestore.
 */
export { JobProtocol, type JobProtocolPorts } from "./job-protocol";
export type { ToolReadPorts } from "./tool-reads";
export type { CreateJobInput } from "./lifecycle";
export { quarantineJobsForRestore } from "./lifecycle";
export { issueEnrollment } from "./protocol";
export { assertAttemptLive, loadAttempt, runnerView } from "./attempts";
export {
  explainJob, getJob, getRunner, listJobs, listRunners, searchJobs,
} from "./read";
export { jobCommands } from "./commands";
