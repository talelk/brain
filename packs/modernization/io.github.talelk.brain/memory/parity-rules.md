---
type: Rule
title: "Behaviour parity: what a migration must prove"
---

A migration is done when the module does what it did before, and the record shows it. Agents read this entry before changing a module and before reviewing one.

## What counts as parity

1. **The same tests, green before and after.** The tests of the module are run before the change and again after, with the same commands. Both runs are recorded in the task, with the summary line of their output.
2. **A run that exercises something.** A run of zero tests is not a pass.
3. **No test weakened.** No test deleted, skipped, loosened or edited to match new output, unless the goal says that behaviour was meant to change.
4. **The public interface as it was.** Exported names, signatures, routes, file formats and messages stay the same unless the goal changes them; then every caller is updated in the same change.
5. **Untested behaviour is covered first.** A module with no test gets characterisation tests that pass on the old code before it is changed; they record what the code does now, not what it should do.

## How to run before and after

- Use the project's own commands from `CLAUDE.md`, `AGENTS.md`, the README or the manifest.
- Run the narrow tests of the module, then the linter, the type check and the wider suite when it is affordable.
- If a test already fails before the change, name it, and show that it fails the same way after.

## What the result says

- The commands, in order, each with its summary line.
- What could not be verified and why.
- The public interface: unchanged, or changed with the list of callers updated.
