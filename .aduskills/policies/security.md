# Security and Approval Policy
- Run tasks in disposable containers or equivalent isolated workspaces.
- Mount only the active project, never the entire home directory or host credential stores.
- Apply CPU, memory, disk, process, and execution-time limits.
- Deny outbound network by default; log and approve exceptions.
- Inject scoped secrets at runtime and redact them from prompts, output, traces, and artifacts.
- Pin reviewed skill, MCP, package, and container versions.
- Scan skills and MCP servers; inspect scripts, hooks, manifests, install commands, and data paths.
- Require a human gate before deployment, publishing, protected-branch merges, irreversible data changes, or financial actions.
- Authentication challenges must be completed by the user through the provider's official interface.
