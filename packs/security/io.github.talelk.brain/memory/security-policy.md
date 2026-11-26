# Security policy for dependencies

This entry is the rule for every agent of this workspace. Edit the values to match the workspace; agents follow what is written here over their own judgement.

## What blocks

- **Critical and high** advisories in a package the code uses: fix now. A pull request is opened this week and a person approves it.
- **Medium**: fix within 30 days, in the next planned change to that project.
- **Low, or a package the code does not use**: list in the weekly report, no action required.
- A severity OSV does not give is treated as **high** until a person says otherwise.

## Who decides

- A person who is a member of this workspace approves every pull request that changes a dependency.
- An advisory that cannot be fixed (no fixed version exists, or the upgrade breaks the project) needs a written exception, copied from `template-security-exception`, approved by a person. Until then it stays in the report as open.

## How an agent proves a finding

- A finding names the `osv.query` call that returned it. No call, no finding.
- "No advisory returned for this version" is the only thing an agent may say about a clean package; it never says "safe".
- A fix is proven by the project's tests and by the audit run again, both shown with their output.
