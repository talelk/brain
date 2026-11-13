# Watch rows moved out of the backlog 2026-11-13 (engine lane)

Still true; moved to keep the always-read backlog short.

| # | Item | Notes |
|---|------|-------|
| 15 | Evaluator quality 2026-11-12 (qwen3.8-flash-next-a5b, 3 runs per sample): parsed 14/15, validator 14/15; the one failure was malformed JSON, a model flake | watch retries on unparsed answers; detail in archive |
| 66 | Email: STARTTLS/smtps tested only against a fake server; `startSupervisor` loop not run end to end | test against a real relay before relying on it |
| 67 | RTL checked live 2026-11-12: layout mirrors correctly; English strings put trailing punctuation on the left (do not patch with bidi CSS). Compare view in RTL unseen | needs Arabic translations (no message catalog yet); detail in archive/backlog-2026-11-12.md |
