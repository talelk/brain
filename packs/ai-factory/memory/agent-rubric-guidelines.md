# Agent rubric guidelines

The rules the evaluation author, the designer and the judge follow. Edit them to match how your team judges an agent. Brain has no registry of scenarios: an agent's cases are the Markdown file `evals/<agent>/cases.md` in the project, and a change to that file is a change to the definition of done.

## A rubric check

- It is true or false, never "good" or "appropriate". "The answer names the file and the line" is a check; "the answer is helpful" is not.
- It is about what can be observed: the final answer, a tool called or not called, a file written. It is never about what the agent "meant".
- Two to five checks per case. More than five means the case is two cases.

## A good case

- One input, exactly as the agent receives it, with the context it would have.
- One expected behaviour in a sentence.
- A reason it exists: a real failure, a risk, or the ordinary job. A case with no reason is dropped.
- At least one case in the file where the right behaviour is to stop, ask a person or say it cannot.

## What counts as evidence

A tool call recorded in the task, a line of a file, or the text of the answer. "It would work" is not evidence. A check no prompt text decides counts as not met.

## Scoring

The score is the share of checks met and evidenced. A file with a case that has no check, or no refusal case, fails whatever the score. The agent has no more tools and no higher `native` level than its prompt uses.
