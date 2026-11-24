# Template: a security exception

Copy this entry once for each advisory that cannot be fixed now, name the copy `security-exception-<advisory id>.md`, and replace everything in angle brackets. The agents find these entries with `memory.search` ("security exception" and the advisory id), and an advisory with a current exception is reported as accepted, not open.

## Advisory

- **Id**: <GHSA-... or CVE-...>
- **Package and version**: <name@version>
- **Project**: <project name>
- **Severity**: <as OSV gives it>

## Why it cannot be fixed now

<No fixed version exists / the upgrade breaks ... / the package is not reachable because ...>

## What limits the risk meanwhile

<A control that is in place, written as a fact that can be checked.>

## Approval

- **Approved by**: <a person's name>
- **Date**: <YYYY-MM-DD>
- **Review again by**: <YYYY-MM-DD, at most 90 days later>
