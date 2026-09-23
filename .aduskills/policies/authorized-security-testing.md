# Authorized Security Testing Policy
Active testing is disabled until the user supplies explicit authorization and a bounded scope. Production testing requires a separate approval immediately before execution.
Required scope fields: owner, targets, exclusions, window, allowed techniques, rate limits, test accounts, data rules, emergency contact, stop conditions.
Default mode is passive/local: source review, dependency/SBOM analysis, SAST, secret scanning, IaC/container checks, and configuration review.
Never run destructive, evasive, persistent, credential-theft, denial-of-service, phishing, mass-targeting, or real-data-exfiltration activity.
