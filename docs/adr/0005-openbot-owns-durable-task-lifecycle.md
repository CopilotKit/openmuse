---
status: accepted
---

# Move durable task execution into OpenBot

OpenBot will own the lifecycle and data of newly created OpenMuse delegated tasks, including plans and steps, run records, artifacts and evidence references, background scheduling, monitor definitions and cursors, execution, recovery, pause and resume, and retry. The current OpenMuse TaskWorker will not remain the scheduler for integrated users. This lets offline work use OpenBot's user, Bot, computer, policy, and audit context without an external worker impersonating a user or retaining an expiring run assertion.

Google connections, PDF processing, finance calculations, and reviewed external writes also move into OpenBot under [ADR 0009](0009-openbot-as-sole-backend.md). Personal goals, ideas, memories, and task notification read state are owned by OpenBot under [ADR 0007](0007-openbot-owns-personal-context-and-task-notifications.md). Existing single-owner data remains outside cutover scope.

The rejected alternative retained OpenMuse's worker and introduced a new OpenBot background-call interface for each computer-dependent step. Migrating execution creates a larger initial implementation, because OpenBot's current headless runs do not by themselves prove parity with OpenMuse's task leases, input waits, proposal review, monitor rules, and recovery.
