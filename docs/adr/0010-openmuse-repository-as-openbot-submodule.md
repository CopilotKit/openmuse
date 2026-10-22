---
status: accepted
---

# Reference the OpenMuse repository from OpenBot

The existing OpenMuse repository is the frontend source and will be referenced from OpenBot as a Git submodule. The copied `OpenBot/apps/openmuse-mobile` subtree is removed after its relevant changes have been reconciled with the OpenMuse source. OpenBot builds only the submodule's `apps/mobile` client; its legacy `apps/server` and `apps/worker` are not deployed for the integrated product.

A Git submodule records a committed OpenMuse revision and cannot include uncommitted local edits or mount only `apps/mobile` from a larger repository. The `.gitmodules` URL should be the accessible OpenMuse remote (`https://github.com/1123786563/openmuse`) rather than a local absolute path. OpenBot's CI and build commands must initialize the submodule and use its `apps/mobile` directory without launching the legacy backend.
