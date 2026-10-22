---
status: accepted
---

# Give each user a private OpenMuse Bot

Each OpenBot user will have a private OpenMuse Bot. OpenBot's computer is attached to a Bot profile, so this gives each user a separate browser profile, workspace, and computer lifecycle while preserving the personal assistant experience. A shared public OpenMuse Bot would share those computer assets among its users and is unsuitable for personal mail, files, and tasks.

The first self-hosted deployment targets approximately 1–20 simultaneously active users with ordinary OpenBot account sign-in. Gmail and Calendar are separately connected by each user. Computer capacity and worker concurrency must be bounded for that range. A private OpenMuse Bot is created automatically on a user's first entry, with idempotent provisioning from an administrator-managed template. Template versions roll out common security settings and tool grants to existing Bots; user-editable descriptions and preferences are preserved, with differences shown before updating them.
