---
status: superseded by ADR-0009
---

# Delegate verified user identity to the OpenMuse Bot

For each remote OpenMuse Bot run, OpenBot will issue a short-lived identity credential scoped to the receiving service, the authenticated user, the Bot, and the run. OpenMuse verifies it before constructing its user-bound agent. The credential is separate from OpenBot's existing opaque `openbotRun` tool callback assertion and does not require sharing OpenBot's deployment signing key. Client-supplied user IDs and a shared agent instance cannot establish data ownership.

OpenBot controls which OpenMuse business tools are offered to the designated Bot and records their calls. OpenMuse remains responsible for user ownership, durable task state, and the exact review and execution checks for external writes. Each OpenBot user connects their own Google account; credentials, documents, tasks, and memories belong to that user.

The alternative of making the remote Bot entirely user-blind would require replacing the existing owner-bound conversation and tool model with callbacks for every personal read and write. Relying only on OpenMuse's local tool checks would leave OpenBot's per-Bot grants unable to constrain the tools offered during a run.
