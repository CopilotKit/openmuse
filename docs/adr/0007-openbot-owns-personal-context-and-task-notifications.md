---
status: accepted
---

# Keep personal context and task notifications with OpenBot

OpenBot will own each integrated user's new goals, ideas, and personal memories, alongside the Task module. They are available only to that user's private OpenMuse Bot; another Bot requires a later explicit grant even if the same user can access it. Task notifications and their read state are also stored in OpenBot, which presents them with policy approvals and reviewed-action requests in one Activity view. The earlier internal-service split was superseded by [ADR 0009](0009-openbot-as-sole-backend.md).

This makes task references to goals and notification events local to their execution authority. Leaving these records in OpenMuse would require two systems to agree on task progress, goal milestones, and notification read state during recovery.
