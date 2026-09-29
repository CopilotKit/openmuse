# Container Deployment Reference

## Files

| File | Purpose |
|------|---------|
| `Dockerfile.server` | Multi-stage server image from `node:22-bookworm-slim` |
| `apps/computer/Dockerfile` | Computer container for browser/docker automation |
| `docker-compose.yml` | PostgreSQL + OpenMuse server + optional browser-worker |
| `docker-compose.apple.yml` | Apple Container override (macOS) |
| `Makefile` | Cross-platform deployment targets |

## Compose Services

### postgres
PostgreSQL 16 Alpine with healthcheck. Password from `POSTGRES_PASSWORD` env
(default: `openmuse`). Data persists in the `postgres-data` named volume.

### openmuse
The main API server. Key settings:
- `DATABASE_URL`: `postgresql://openmuse:${POSTGRES_PASSWORD:-openmuse}@postgres:5432/openmuse`
- `COMPUTER_ENABLED`: set to `true` to enable Docker-based computer tasks
- `COMPUTER_IMAGE`: Docker image name (default: `openmuse-computer:local`)
- Docker socket mounted at `/var/run/docker.sock:ro` for computer container support

### browser-worker (profile: workers)
Optional browser automation worker. Only starts with `--profile workers`:
```bash
docker compose --profile workers up --build -d
```
Requires `BROWSER_WORKER_URL=http://openmuse:8787` and `WORKER_TOKEN`.

## Platform Differences

| Feature | Docker (Linux) | Apple Containers (macOS) |
|---------|----------------|--------------------------|
| CLI | `docker` | `container` |
| Compose | `docker compose` | `container compose` |
| host.docker.internal | Not available (use host IP or `network_mode: host`) | Supported (resolves to host IP) |
| Docker socket | `/var/run/docker.sock` | `/var/run/docker.sock` (inside Linux VM) |
| Volume driver | default | `local` (explicit) |

## Computer Container Setup

```bash
# Build the computer image

docker build -t openmuse-computer:local apps/computer

# Enable in compose

COMPUTER_ENABLED=true docker compose up --build -d
```

On macOS with Apple Containers, the `container` CLI is largely compatible with
the `docker` CLI. Use `docker-compose.apple.yml` for any macOS-specific overrides.

## Environment Variables (compose)

All compose env vars support `${VAR:-default}` shell-style substitution:
- `POSTGRES_PASSWORD` (default: `openmuse`)
- `WORKSPACE_MODE` (default: `sample`)
- `AGENT_BACKEND` (default: `model`)
- `MODEL` (default: `openai/qwen3-8b`)
- `CHAT_MODEL` (default: `openai/qwen3-8b`)
- `TASK_MODEL` (default: `openai/qwen3-32b`)
- `OPENAI_API_FORMAT` (default: `chat-completions`)
- `CPK_INTELLIGENCE_API_KEY` (no default — required for live mode)
- `COMPUTER_ENABLED` (default: `false`)
- `COMPUTER_IMAGE` (default: `openmuse-computer:local`)

## Writing Literal Shell Variables in Compose Files

Pitfall: when writing `docker-compose.yml` via tools that interpret shell variables
(e.g. Python f-strings, Bash heredocs, or templated writes), `${POSTGRES_PASSWORD}`
expands to the literal value of the env var — often empty or `***` in masked
environments — corrupting the file. The compose file needs the literal string
`${POSTGRES_PASSWORD:-openmuse}` so the compose parser resolves it at runtime.

Use Python to write literal strings when shell expansion is undesirable:
```python
content = 'DATABASE_URL=postgresql://openmuse:${POSTGRES_PASSWORD:-openmuse}@postgres:5432/openmuse'
write_file(path, content)  # no f-string, no shell interpolation
```
Verify after writing: `grep '${POSTGRES_PASSWORD:-openmuse}' docker-compose.yml`
must show the literal `${...}` pattern, not an expanded value.