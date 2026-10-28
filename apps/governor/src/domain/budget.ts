import { BrainDomainError } from "./errors";

// Hierarchical budget reservations: a child reservation can never exceed the
// unreserved remainder of its parent, at any depth. Reservations are atomic
// (check + deduct in one call), depth-bounded, and releases return capacity
// exactly once. Oversubscription fails closed with BUDGET_EXHAUSTED.
export interface BudgetLimits {
  readonly microUsd: number;
  readonly tokens: number;
  readonly turns: number;
}

interface Node {
  limits: BudgetLimits;
  reserved: BudgetLimits;
  depth: number;
}

const ZERO: BudgetLimits = { microUsd: 0, tokens: 0, turns: 0 };
export const MAX_BUDGET_DEPTH = 4;

function add(a: BudgetLimits, b: BudgetLimits): BudgetLimits {
  return { microUsd: a.microUsd + b.microUsd, tokens: a.tokens + b.tokens, turns: a.turns + b.turns };
}
function sub(a: BudgetLimits, b: BudgetLimits): BudgetLimits {
  return { microUsd: a.microUsd - b.microUsd, tokens: a.tokens - b.tokens, turns: a.turns - b.turns };
}
function exceeds(amount: BudgetLimits, available: BudgetLimits): boolean {
  return amount.microUsd > available.microUsd || amount.tokens > available.tokens || amount.turns > available.turns;
}
function assertSane(amount: BudgetLimits, label: string): void {
  for (const v of [amount.microUsd, amount.tokens, amount.turns]) {
    if (!Number.isSafeInteger(v) || v < 0) throw new BrainDomainError("INVALID_ARGUMENT", `${label}: budget values must be non-negative safe integers`);
  }
}

export class BudgetTree {
  private readonly nodes = new Map<string, Node>();
  private readonly released = new Set<string>();

  createRoot(id: string, limits: BudgetLimits): void {
    assertSane(limits, id);
    if (this.nodes.has(id)) throw new BrainDomainError("CONFLICT", `budget ${id} already exists`);
    this.nodes.set(id, { limits, reserved: ZERO, depth: 0 });
  }

  reserve(parentId: string, childId: string, amount: BudgetLimits): void {
    assertSane(amount, childId);
    const parent = this.nodes.get(parentId);
    if (!parent) throw new BrainDomainError("NOT_FOUND", `budget ${parentId} not found`);
    if (parent.depth + 1 > MAX_BUDGET_DEPTH) throw new BrainDomainError("BUDGET_EXHAUSTED", `budget depth exceeds ${MAX_BUDGET_DEPTH}`);
    if (this.nodes.has(childId)) throw new BrainDomainError("CONFLICT", `budget ${childId} already exists`);
    const available = sub(parent.limits, parent.reserved);
    if (exceeds(amount, available)) {
      throw new BrainDomainError("BUDGET_EXHAUSTED", `budget ${childId} exceeds unreserved remainder of ${parentId}`);
    }
    parent.reserved = add(parent.reserved, amount);
    this.nodes.set(childId, { limits: amount, reserved: ZERO, depth: parent.depth + 1 });
  }

  release(parentId: string, childId: string): void {
    const key = `${parentId}->${childId}`;
    if (this.released.has(key)) return; // exactly-once release: replay is a no-op
    const parent = this.nodes.get(parentId);
    const child = this.nodes.get(childId);
    if (!parent || !child) throw new BrainDomainError("NOT_FOUND", "budget node not found");
    this.released.add(key);
    parent.reserved = sub(parent.reserved, child.limits);
    this.nodes.delete(childId);
  }

  available(id: string): BudgetLimits {
    const node = this.nodes.get(id);
    if (!node) throw new BrainDomainError("NOT_FOUND", `budget ${id} not found`);
    return sub(node.limits, node.reserved);
  }
}
