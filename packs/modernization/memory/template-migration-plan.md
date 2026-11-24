# Migration plan template: one entry per migration

Copy this entry once for each migration, name the copy `migration-<what>.md`, and replace everything in angle brackets. The agents find these entries with `memory.search` (they search for "migration" and the target's name), so keep the headings as they are. Until a migration has its own entry, the agents work only from the goal.

**Agents: this entry is a template. Its values are placeholders. Never treat them as facts about a real project.**

## Target

<what the code moves to: framework and version, structure, language>

## Why and when

<the reason, and the date after which the old way stops being supported>

## Modules, in order

1. <module path>: <risk low, medium or high>, <how to run its tests>
2. <module path>: <risk>, <how to run its tests>

## Must not change

<public interfaces, routes, file formats and messages that other systems rely on>

## Done when

<what proves the migration is complete: all modules moved, tests green, old dependency removed>

## Out of scope

<what looks related and must be left alone>
