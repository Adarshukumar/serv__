# ADUSKILLS — Start Here

**Bundle author: Adarsh**

1. Extract the archive into your repository or agent workspace.
2. Configure the host agent to read `ACTIVATE.md` and `ADUSKILLS.md` as project instructions. Where supported, `AGENTS.md` contains the same core operating instructions.
3. Send the standalone chat command `ACTIVATE` to initialize ADUSKILLS for the current session.
4. Then provide a task, repository URL, API documentation URL, or attached file.
5. Skills are under `.agents/skills/`; OpenCode discovery is available through `.opencode/skills` where supported.
6. Read `CAPABILITIES.md` for the capability map and `DEEP-RESEARCH.md` for evidence-driven web research.
7. Review `policies/` before enabling MCP tools, credentials, deployments, or security validation.
8. Run `python scripts/verify-bundle.py` after extraction.
9. Preserve `LICENSE`, `LICENSE-ADUSKILLS`, `NOTICE`, nested licenses, and `integrations/licenses/`.
10. Restricted defensive validation is installed but disabled by default and requires fresh scoped approval for every run.
