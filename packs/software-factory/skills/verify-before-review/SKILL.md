---
name: verify-before-review
description: "How to run and prove a code change before it goes to review: which of the project's commands to use, what to run first and what the result must show. Use it before you hand over a change, and when you review one."
---

# How to verify a change before asking for review

A change is ready for review when you have run it and can show the run. The reviewer sees your diff and the commands recorded in your task; a claim without a recorded run is sent back.

## Before you start

1. Find the project's own commands in `CLAUDE.md`, `AGENTS.md`, the README, or the scripts section of its manifest (`package.json`, `Makefile`, `pyproject.toml` and the like). Use those, not your guesses.
2. Run the tests of the area once before changing anything. If they already fail, note which ones, so that you do not take the blame for them or hide behind them.

## While you work

3. Write or update a test that fails without your change. Run it and see it fail for the right reason, then make the change and see it pass.
4. Run the narrowest thing that exercises your change after each meaningful edit: one test file, one package.

## Before you hand over

5. Run, in this order, whatever the project has:
   - the formatter or linter;
   - the type check or compile step;
   - the tests of the packages you touched;
   - the whole test suite, when it finishes in a reasonable time. If it does not, say what you ran and what you left out.
6. Read the output. A command that exits with an error, prints a warning that was not there before, or silently runs zero tests is not a pass.
7. Read your own `git diff` from top to bottom. Remove debug output, commented-out code, stray files and changes you did not mean to make.
8. Check the change against the goal once more: every part of it, and nothing else.

## What to write in your result

- The exact commands, in the order you ran them.
- For each, the summary line of its output: "142 passed, 0 failed", "no issues found".
- Any test that fails for a reason unrelated to your change, with the evidence that it failed before your change too.
- What you could not verify and why (no network, no database, a test that needs a secret).

## Never

- Never say tests pass without having run them in this task.
- Never weaken, skip or delete a test to make the suite pass. If a test is wrong, say so and let the reviewer decide.
- Never report the result of an earlier round as if it were this one. Run again after every fix.
