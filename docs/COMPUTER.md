# The agent computer

OpenMuse combines a persistent browser with an optional Linux workspace for commands and files. The app and CopilotKit tools use the same authenticated computer service, so you can inspect what the agent ran and continue working with its results.

## Start the Linux workspace

The API host needs Docker CLI access to a running Docker engine. Build the image from this repository:

```sh
docker build -t openmuse-computer:local apps/computer
```

Enable it on the API and any separate task worker, then restart them:

```dotenv
COMPUTER_ENABLED=true
COMPUTER_IMAGE=openmuse-computer:local
```

Open **Computer → Terminal → Start computer**. Run `pwd` or `python3 --version`. Commands execute inside the Linux container with `/workspace` as their default working directory. Their output, exit code, and status appear in command history.

If Docker is unavailable, the app reports the connection error. There is no fallback that executes commands on the API host.

### Optional isolated runtime on macOS

Colima is an open-source way to run Docker in a Linux VM. A separate profile keeps OpenMuse independent of other Docker workloads:

```sh
brew install colima
colima start openmuse --cpus 2 --memory 3 --disk 12 --root-disk 12 \
  --vm-type vz --activate=false --mount none --ssh-config=false
DOCKER_CONTEXT=colima-openmuse docker build -t openmuse-computer:local apps/computer
DOCKER_CONTEXT=colima-openmuse COMPUTER_ENABLED=true pnpm dev
```

The explicit context applies to that command and its child processes. It does not change the default Docker context. Stop this VM with `colima stop openmuse` when you no longer need it.

## Work with files

- **Computer → Files** lists the persistent `/workspace` directory. Create folders, add text files, edit them, and save.
- **Copy a document here** copies an owned PDF from OpenMuse into the current folder. A matching filename is replaced.
- Open a PDF in the workspace to save a copy to OpenMuse Documents and view it in the native/web reader.
- Browser downloads first enter Documents through **Import PDF downloads**, then can be copied into the Linux workspace.
- Stopping the computer ends its running commands and keeps the named workspace volume. Starting it again restores those files.

The terminal runs bounded commands and displays their saved results. It is not an interactive PTY: full-screen terminal apps and prompts that require ongoing keyboard input are not supported. Write noninteractive scripts or edit files through the Files tab.

## Isolation and scope

The workspace is a Docker container running as a nonroot user, with a read-only root filesystem, limited temporary storage and resources, dropped capabilities, and no added privileges. It receives no host directory mounts, Docker socket, model keys, Google tokens, or API access key. A named volume provides persistent `/workspace` storage.

Terminal networking is disabled. The existing browser worker handles public web access through its own destination checks; see its [network boundary](../apps/worker/README.md#network-boundary). Browser profiles and workspace files have separate storage and lifecycle controls.

This is a self-hosted, single-owner computer environment. Docker isolation does not provide a dedicated operating-system VM or a hostile-tenant security guarantee. The optional Colima VM provides the Linux host on macOS; the application still manages a Docker container within it.
