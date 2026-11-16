/** Ports with more than one implementation. An implementation normalizes vendor types at its own boundary. */
export interface Clock {
  nowMs(): number;
  monotonicMs(): number;
}
