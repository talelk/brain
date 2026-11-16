# Pull request conventions

These are the workspace's defaults. A project's own rules (`CLAUDE.md`, `AGENTS.md`, a contributing guide or a pull request template) take precedence wherever they differ.

## One pull request, one purpose

- A pull request does one thing: one fix, or one feature. A refactoring the change needed is part of it; an unrelated clean-up is not.
- Keep it small enough to review in one sitting. If the diff passes about 400 changed lines, say in the description why it could not be split.
- No reformatting of lines the change did not touch, and no generated files unless the project commits them.

## Title

One line, at most 72 characters, that says what the change does, starting with a verb: "Reject expired invitations at sign-in". Not "Fix bug", and not the issue number alone. Follow the project's prefix style (such as `fix:` or `feat:`) when its history shows one.

## Description

Markdown, in this order:

1. **What**: the behaviour that changes, in two to four sentences, in terms a user of the code understands.
2. **Why**: the issue or goal it answers, with a link or reference when there is one.
3. **How it was verified**: the exact commands that were run and their outcome, and the test that was added. Only what was actually run.
4. **Notes for the reviewer**: risks, decisions that could have gone another way, follow-ups left out on purpose.

## What a pull request never contains

- A secret, a token, a password or a real customer's data, in code, tests, fixtures or the description.
- A disabled or deleted test without an explanation in the description.
- A new dependency without a sentence saying why it is needed.
- Changes to continuous integration, deployment or permissions files, unless the goal was exactly that.

## How pull requests are opened here

- Agents leave changes in the working copy. They never commit, push or merge.
- A pull request is opened only with the `git.open-pr` tool, from the diff of the working copy, on a branch Brain names. A person approves the call before it happens.
- Nothing is merged by an agent. A person merges after the project's own checks pass.
