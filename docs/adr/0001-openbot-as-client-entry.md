---
status: superseded by ADR-0009
---

# Use OpenBot as the client entry and retain OpenMuse capabilities internally

OpenMuse clients will use OpenBot for user identity, Bots, channels, conversation threads, and computer access. OpenMuse's Gmail, Calendar, PDF, finance calculations, and reviewed external-write capabilities will remain available through an internal capability service connected to OpenBot. Client requests will enter through OpenBot; the internal service must keep data and credentials isolated by the authenticated OpenBot user. Later decisions place durable task execution and personal goals, ideas, memories, and task notifications in OpenBot; see [ADR 0005](0005-openbot-owns-durable-task-lifecycle.md) and [ADR 0007](0007-openbot-owns-personal-context-and-task-notifications.md).

Existing single-owner OpenMuse data is outside the cutover scope. The integrated product must support its full feature set for new users and new data, while the old instance can be retained separately.

The alternative of moving all OpenMuse business modules into OpenBot would concentrate the backend but requires migrating unrelated storage, OAuth, and document workflows at once. Letting clients call two public backends would expose two authentication and permission models to the app. The Bot-to-business interface remains a separate design decision.
