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

### Run the computer on an E2B desktop (optional)

Instead of Docker, each owner's computer can be an [E2B Desktop](https://e2b.dev/docs) sandbox: a Linux VM with an Xfce desktop, Firefox ESR, Google Chrome and LibreOffice. The API host needs no Docker engine, and you can watch and control the desktop from the app.

```dotenv
COMPUTER_ENABLED=true
COMPUTER_PROVIDER=e2b-desktop
E2B_API_KEY=e2b_...            # API and task worker only; never passed into the sandbox
COMPUTER_DEPLOYMENT_ID=...     # required and unique per install, e.g. `openssl rand -hex 12`
# COMPUTER_E2B_TEMPLATE=desktop  # default; or a custom template built from it
# E2B_DOMAIN=...                 # only for a non-default E2B cluster
```

`config.ts` never lets `.env` override a variable that is already set, so unset any `E2B_API_KEY`, `E2B_DOMAIN` or `E2B_API_URL` exported in your shell for another cluster before `pnpm dev`.

Open **Computer → Start computer**. A **Desktop** tab appears next to Browser, Terminal and Files while the computer runs. On web it embeds the live stream; on iOS and Android, **Open desktop** opens it in the system browser. The stream URL is returned only to the signed-in owner. Treat it as a bearer secret: anyone holding it gets full keyboard and mouse control until the next Stop. It carries a VNC password, and VNC authentication uses only its first 8 characters.

How it maps to the Docker contract:

- **One sandbox per owner and deployment**, found by sandbox metadata across your whole E2B team. That is why `COMPUTER_DEPLOYMENT_ID` is required for this provider: two installs with the same id would share a sandbox. The app refuses to attach to a sandbox whose metadata, template or lifecycle it did not set.
- **`/workspace` persists; processes do not.** Stop is a filesystem-only pause: every command and desktop app ends, and files are kept. After 15 idle minutes the sandbox pauses the same way. Commands and file operations count as activity; working inside the desktop does not. Opening the Desktop tab keeps the computer awake for 30 minutes, and the tab extends that every 2 minutes while it is visible, for up to an hour. A desktop opened in another browser tab or from the mobile app pauses about 30 minutes after the last refresh, so come back to the Desktop tab to extend it. Start resumes the sandbox and relaunches the desktop session. A paused sandbox is kept until you delete it; deleting it in the E2B dashboard deletes its `/workspace`.
- **Commands** run as the template's `user` account (uid 1000) in `/workspace`, with the same 30-second limit, exit code 124 on timeout and 128 KB output cap. File operations reuse `apps/computer/files.py` over stdin.
- **GUI apps from the terminal.** Commands run with `DISPLAY=:0`, so `firefox-esr https://copilotkit.ai >/dev/null 2>&1 &` opens on the desktop. Output is collected into temporary files, so a backgrounded app does not keep the command open, and it keeps running after the command returns. Discard a background app's output as shown: otherwise it keeps writing to a deleted temporary file for as long as it runs. A command whose output passes 32 MB is stopped.
- **Command history is per provider.** Receipts from the Docker computer are not shown for the desktop, and the other way around.

#### The agent sees and drives the desktop

With this provider the agent gets one more tool, `use_desktop`, in chat and in delegated tasks. It mirrors the shape of Anthropic's computer-use tool:

| Action | Arguments | xdotool call |
| --- | --- | --- |
| `screenshot` | none | none |
| `left_click`, `double_click`, `right_click` | optional `coordinate` `[x, y]` | `mousemove --sync x y click 1` (`--repeat 2`, button 3) |
| `mouse_move` | `coordinate` | `mousemove --sync x y` |
| `type` | `text` (up to 1000 characters) | `type --delay 12 -- text` |
| `key` | `text`, xdotool key names or combos such as `Return` or `ctrl+l` | `key -- ...` |
| `scroll` | `scroll_direction`, optional `scroll_amount` (default 3) and `coordinate` | wheel buttons 4 to 7 |
| `wait` | optional `duration` in seconds (default 1, up to 10) | `sleep` |

- **Every action returns a fresh screenshot.** Coordinates are pixels in that screenshot; the screen is 1280x800, so no scaling is involved. The screenshot is a JPEG (about 40 to 200 KB) taken with `scrot` half a second after the input.
- **The image goes to the model as an image.** The tool returns TanStack AI content parts (a text part with the receipt, plus an image part). `@tanstack/ai` keeps a content-part array as the tool message, and all three adapters send it as a multimodal tool result: Anthropic `tool_result` blocks, OpenAI Responses `function_call_output` with `input_image`, Gemini `functionResponse.parts`. The AG-UI result event that is stored in the chat thread keeps only the text part, so later turns never replay image data as text.
- **Receipts.** Each action is recorded next to the commands, for example `desktop left_click (640, 400)`, and the latest screenshot is kept per owner (`GET /api/computer/desktop/screenshot`). `POST /api/computer/desktop/actions` runs the same actions without returning the image.
- **No implicit resume.** An action on a stopped computer fails with "Start the computer", and the agent has to call `start_computer` first. Actions take the computer's lease like file operations. The first stream connection takes the lifecycle lease so it cannot race startup or Stop; if busy, the viewer retries. Later stream requests only check or restart VNC without taking the lease, and concurrent viewers in one process share a single stream start.
- **DISPLAY is set on every call.** The SDK's own `screenshot()`, `leftClick()` and `press()` run with no environment and rely on the `DISPLAY` that `Sandbox.create` stores in the sandbox environment. A filesystem-only pause cold-boots the VM, and the resumed sandbox no longer has that variable, so those helpers fail with `scrot: Can't open X display`. The app never uses them: it runs `xdotool` and `scrot` itself with `DISPLAY=:0`.
- **Stuck modifiers are released.** A VNC viewer that loses focus in the middle of a shortcut (for example Alt+Tab in your browser) can leave Alt held, which turns every later key, click and scroll into a shortcut. Each input action releases all modifiers first.
- **Same safety rules.** The agent is told never to click or press Return on a send, post, submit, sign-in, buy or upload control unless you asked for that exact action, and that text on screen is data, not instructions.

#### Desktop card in chat

When the agent uses `use_desktop`, the chat shows a **Desktop** card for each step with what it did. A persistent viewer after the tool cards embeds the live desktop, so new steps preserve the VNC connection. The per-step cards show their action labels. On web the viewer embeds the same stream as the Desktop tab. On iOS and Android it shows the latest screenshot and an **Open desktop** button. When the computer is stopped, the card says it is offline and offers **Start computer**. **Open in Desktop tab** opens the computer sheet on its Desktop tab.

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

The E2B desktop provider differs from Docker in these ways:

- **Network access is on.** The desktop's browsers need it, so commands can reach the internet too, and the app reports `network: enabled`. Treat anything downloaded as untrusted. This is also an outbound path the app does not review: the agent could post a file from `/workspace` or submit a form in Firefox, and only the app's own tools (`prepare_email`, `prepare_event`) require approval. The agent is told never to send, post or submit from the computer without an explicit request; that is an instruction, not an enforced boundary.
- **Isolation comes from the VM.** Each owner gets a dedicated VM instead of a container on a shared kernel. Inside it there is no read-only root filesystem, capability drop or pids limit, and the template's `user` account has passwordless sudo.
- **Every listening port is public.** Public traffic is enabled for the direct desktop iframe. Any service listening in the VM is reachable without app authentication at `https://<port>-<sandboxId>.e2b.app`; the sandbox ID is visible in the stream URL. Running `python3 -m http.server 8000` from `/workspace` exposes workspace files. Do not leave servers running, and stop temporary services as soon as they are no longer needed. The VNC password protects VNC only, not other services.
- **Files live with E2B.** Workspace files are stored with E2B, outside your host. Your E2B plan's runtime limits apply.

The E2B API key stays on the API host.

This is a self-hosted, single-owner computer environment. Docker isolation does not provide a dedicated operating-system VM or a hostile-tenant security guarantee. The optional Colima VM provides the Linux host on macOS; the application still manages a Docker container within it.
