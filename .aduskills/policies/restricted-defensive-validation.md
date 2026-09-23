# Restricted Defensive Validation Policy

This category is disabled by default and is not part of routine autonomous execution.

It may be enabled for one bounded run only when normal passive and defensive checks cannot validate a necessary security control, and only after the complete authorization gate in `.agents/skills/restricted-defensive-validation/SKILL.md` is satisfied.

## Approval levels
- **Level 0 — Routine:** source review, SAST, dependency, secret, IaC, and configuration checks. No special unlock.
- **Level 1 — Controlled staging:** bounded defensive simulations with synthetic data. Requires asset-owner approval.
- **Level 2 — Production exceptional:** only when staging cannot reproduce the control, with owner + operations approval, monitoring, rollback, strict abort thresholds, and a fresh approval immediately before execution.
- **Forbidden:** destructive, evasive, persistent, credential-stealing, exfiltrating, third-party, or unauthorized activity. No approval level unlocks forbidden activity.

Approvals expire at the end of the stated window and never carry over automatically.
