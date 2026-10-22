---
status: superseded by ADR-0009
---

# Preserve the OpenMuse Bot and each system's review decision

The existing OpenMuse assistant will be adapted as a designated OpenBot Bot. It retains its task-planning and conversation behavior while OpenBot owns the user's channel, thread, and Bot access. Only this Bot receives OpenMuse's personal mail, calendar, PDF, and task capabilities initially; other Bots need an explicit later grant.

The client will show one Activity entry point for pending decisions. OpenBot remains responsible for its policy approvals, including computer actions. OpenMuse remains responsible for reviewed external writes, including proposal identity, expiry, connected account, target version, and the final execution receipt. The common Activity view must preserve the source and decision semantics of each item.

Replacing the OpenMuse assistant with a different Bot would change the established task behavior during a full-capability cutover. Mapping reviewed external writes into OpenBot's general approval flow would drop checks that OpenMuse currently performs at decision time. The cross-system Activity presentation is shared, while execution ownership is not.
