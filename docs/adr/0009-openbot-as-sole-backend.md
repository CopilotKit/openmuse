---
status: accepted
---

# Make OpenBot the sole backend for OpenMuse

OpenMuse will be a frontend for OpenBot. OpenBot owns identity, each user's private OpenMuse Bot, channels and threads, Google connections and connector calls, files and PDF artifacts, reviewed external writes, computer access, tasks, monitoring, goals, ideas, memories, approvals, and notifications. The existing OpenMuse assistant behavior and business rules are ported into OpenBot modules and tools. OpenMuse keeps rendering, navigation, forms, document viewing, and client-side interaction state; it does not operate a separate business API, OAuth store, TaskWorker, or file store for integrated users.

OpenBot's connector and file infrastructure are the starting points, not proof of feature parity. The selected connector path is OpenConnector. Its live provider directory currently includes Gmail and Google Calendar actions, but OpenBot's adapter selects custom credentials and does not implement the providers' OAuth2 connection flow. OpenBot must add the required per-user Google connection flow and stable mail/calendar interfaces before the existing OpenMuse Gmail and Calendar experience can move. Channel attachments currently reject PDF, while Craft files support PDF but are scoped to a Craft session. OpenBot therefore needs user-owned document and artifact contracts, with PDF inspection/filling and exact reviewed-write checks implemented on the backend. A connector or workspace file path alone does not supply those OpenMuse workflows.

This supersedes the former internal OpenMuse capability-service boundary and its cross-service identity credential. The common Activity interface remains, but OpenBot owns both policy approvals and reviewed external-write records as distinct decision types. Existing single-owner OpenMuse data is not migrated under the accepted cutover scope.
