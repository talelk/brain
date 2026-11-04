/**
 * jobs module: the runner session protocol, the attempt lifecycle and both
 * dispatch loops live behind one interface — JobProtocol, constructed once
 * with the Store and the host ports. The two row primitives below are the
 * declared cross-module surface: governance permits and evidence artifact
 * ingestion assert against live attempt rows without owning them, and the
 * operations module reads runner views / issues enrollment tokens.
 */
export { JobProtocol, type JobProtocolPorts } from "./job-protocol";
export { issueEnrollment } from "./protocol";
export { assertAttemptLive, loadAttempt, runnerView } from "./attempts";
export {
  explainJob, getJob, getRunner, listJobs, listRunners, searchJobs,
} from "./read";
