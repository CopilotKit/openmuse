# Makefile for OpenMuse deployment across Linux (Docker) and macOS (Apple Containers).
# Usage:
#   make docker          # Linux: build + start all services via docker compose
#   make docker-stop     # Linux: stop all services
#   make container       # macOS: build + start via Apple Containers
#   make container-stop  # macOS: stop via Apple Containers
#   make typecheck       # Run TypeScript strictness checks (all configs)
#   make lint            # Run Biome lint (0 errors, 0 warnings)
#   make test            # Run full test suite
#   make check           # Run typecheck + lint + test

.PHONY: docker docker-stop container container-stop typecheck lint test check

docker: ## Start all services with docker compose (Linux)
	docker compose up --build -d

docker-stop: ## Stop all docker compose services
	docker compose down -v

container: ## Start all services with Apple Containers (macOS)
	container compose up --build -d

container-stop: ## Stop all Apple Container services
	container compose down -v

# --- Development checks ---

typecheck: ## Run TypeScript strictness checks
	pnpm typecheck

lint: ## Run Biome lint
	pnpm lint

test: ## Run full test suite (requires PostgreSQL)
	DATABASE_URL=postgresql://openmuse:$${POSTGRES_PASSWORD:-openmuse}@localhost:5432/openmuse_test pnpm test

check: typecheck lint test ## Run all checks in sequence

# --- Strictness helpers ---

format: ## Format with Biome
	npx biome format --write .

biome-fix: ## Auto-fix Biome issues
	npx biome check --write .
