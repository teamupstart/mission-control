# AI Harness - shorthand commands.  Run `make` (or `make help`) for the list.
#
# Day-to-day:  `make dev` (foreground, auto-reload) is the simplest.
# Background:  `make up` runs the daemon detached and auto-reloading, so code
#              changes reload themselves - no more manual restarts.  Pair it with
#              a Vite server (`make web`) or just use `make dev` for both.

PORT ?= 7317
LOG  := .harness.log
# Every server process (watcher + child) has this in its argv, so pkill/pgrep
# find the whole tree regardless of how it was started.
MATCH := src/server/index.ts

.DEFAULT_GOAL := help
.PHONY: help init session dev server web up down restart status logs build test check hooks setup

help: ## List the available commands
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-9s\033[0m %s\n", $$1, $$2}'

init: ## First-run bootstrap: deps, build, hooks, treehouse + no-mistakes, gate repo
	node scripts/init.mjs

session: ## Start an agent in a fresh, gated worktree (e.g. make session ARGS="-- claude")
	node scripts/new-session.mjs $(ARGS)

dev: ## Daemon + web in the foreground, both auto-reload (Ctrl-C to stop)
	npm run dev

server: ## Just the daemon in the foreground, auto-reload
	npm run dev:server

web: ## Just the Vite web dev server
	npm run dev:web

up: ## Start the daemon in the background (auto-reload); logs to .harness.log
	@$(MAKE) --no-print-directory down >/dev/null 2>&1 || true
	@nohup npm run dev:server > $(LOG) 2>&1 & \
		sleep 1.5; \
		if lsof -ti tcp:$(PORT) >/dev/null 2>&1; then \
			echo "daemon up on http://127.0.0.1:$(PORT)  (make logs | make status | make down)"; \
		else \
			echo "daemon failed to bind :$(PORT) - see: make logs"; fi

down: ## Stop the background daemon
	@if pgrep -f "$(MATCH)" >/dev/null 2>&1; then \
		pkill -f "$(MATCH)"; echo "daemon stopped"; \
	else echo "no daemon running"; fi

restart: ## Restart the background daemon (also picks up code changes)
	@$(MAKE) --no-print-directory up

status: ## Show whether the daemon is running
	@pid=$$(lsof -ti tcp:$(PORT) 2>/dev/null | head -1); \
	if [ -n "$$pid" ]; then echo "running (pid $$pid) on http://127.0.0.1:$(PORT)"; \
	else echo "not running"; fi

logs: ## Tail the background daemon log
	@touch $(LOG); tail -f $(LOG)

build: ## Build the web UI + MCP bundle
	npm run build

test: ## Run the unit tests
	npm test

check: ## Typecheck + tests
	npm run typecheck && npm test

hooks: ## Install the Claude status hooks
	npm run install-hooks

setup: ## Install deps, build, and wire hooks
	npm install && npm run build && npm run install-hooks
