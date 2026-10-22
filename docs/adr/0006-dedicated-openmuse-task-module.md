---
status: accepted
---

# Add a dedicated OpenMuse Task module in OpenBot

OpenBot will add a Task module for OpenMuse's single jobs, document workflows, finance jobs, plans, and recurring monitors. The module owns their task state, plan steps, run history, evidence and artifact references, business retry state, monitor schedule, observation cursor, and deduplication. It reuses OpenBot's existing work queue, headless Bot runner, user and Bot authorization, computer gateway, and delivery infrastructure through their interfaces.

Responsibilities remain long-lived goals driven by subscriptions and events. Making them also represent document filling, single jobs, and price monitoring would force unrelated lifecycle and state rules into one concept. A dedicated Task interface makes completion, input waits, cancellation, evidence, and monitor outcomes explicit without duplicating OpenBot's underlying job queue.
