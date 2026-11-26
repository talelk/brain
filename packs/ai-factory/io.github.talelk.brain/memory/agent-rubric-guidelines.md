# Agent rubric guidelines

The rules the evaluation author, the designer and the judge follow. Edit them to match how your team judges an agent. An agent's cases are the Markdown file `evals/<agent>/cases.md` in the project, and a change to that file is a change to the definition of done. `evals/<agent>/run.sh` runs them; each answer is kept as `/out/cases/<agent>/<case id>.md`.

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

The answer a run kept for the case, a tool call recorded in the task, or a line of a file. "It would work" is not evidence, and neither is what the prompt says the agent should do. A check the run cannot show counts as not met. The expected behaviour and the rubric are never sent to the agent under test.

## Scoring

The score is the share of checks met and evidenced. A file with a case that has no check, or no refusal case, fails whatever the score. The agent has no more tools and no higher `native` level than its prompt uses.
