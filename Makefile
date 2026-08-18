# AI Harness - shorthand commands.  Run `make` (or `make help`) for the list.
#
# Day-to-day:  `make dev` (foreground, auto-reload) is the simplest.
# Full stack:  `make start` runs everything - daemon, Vite, the Electron shell,
#              and the Foreman auto-responder - in one foreground group;
#              `make restart` stops any running stack and starts it fresh.
# Background:  `make up` runs the daemon detached and auto-reloading, so code
#              changes reload themselves - no more manual restarts.  Pair it with
#              a Vite server (`make web`) or just use `make dev` for both.

PORT     ?= 7317
WEB_PORT ?= 5173
LOG  := .harness.log
# Every server process (watcher + child) has this in its argv, so pkill/pgrep
# find the whole tree regardless of how it was started.
MATCH := src/server/index.ts
# The Foreman worker's argv marker (unique to the auto-responder worker).
FOREMAN_MATCH := src/server/foreman/worker.ts
# Proof that the installed tree matches the manifests. Defined up here because make
# expands a rule's prerequisites as it parses that rule, so a definition below the first
# use would silently leave that target with no prerequisite. See the rule for why.
NPM_STAMP := node_modules/.install-stamp

.DEFAULT_GOAL := help
.PHONY: help init session claude dev desktop start server web up down restart stop-all status logs db build app install-app icons demo demo-fresh test lint check smoke hooks setup

help: ## List the available commands
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-9s\033[0m %s\n", $$1, $$2}'

init: ## First-run bootstrap: deps, build, and hooks (ARGS="--with-e2e" also checks Chromium)
	node scripts/init.mjs $(ARGS)

session: ## Ask the running daemon for a manual worktree lease (e.g. make session ARGS="-- claude")
	node scripts/new-session.mjs $(ARGS)

claude: ## One shot: bootstrap, ensure the daemon, lease a worktree, open Claude in it (harness-ready). Pass flags via ARGS="--resume"
	@$(MAKE) --no-print-directory init
	@lsof -ti tcp:$(PORT) >/dev/null 2>&1 \
		&& echo "✓ harness daemon already up on http://127.0.0.1:$(PORT)" \
		|| $(MAKE) --no-print-directory up
	node scripts/new-session.mjs -- claude $(ARGS)

dev: ## Daemon + web in the foreground, both auto-reload (Ctrl-C to stop)
	npm run dev

desktop: ## Electron shell + daemon + Vite, all auto-reload (Ctrl-C to stop)
	npm run dev:desktop

start: ## Everything: daemon + Vite + Electron shell + Foreman, all auto-reload (Ctrl-C to stop)
	npm run dev:start

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

restart: ## Stop the whole stack and start it fresh in the foreground (daemon + Vite + Electron + Foreman)
	@$(MAKE) --no-print-directory stop-all
	@$(MAKE) --no-print-directory start

stop-all: ## Stop every harness dev process (daemon, Vite, Electron shell, Foreman)
	@pkill -f "$(FOREMAN_MATCH)" >/dev/null 2>&1 && echo "foreman stopped" || true
	@pkill -f "electronmon" >/dev/null 2>&1 && echo "electron shell stopped" || true
	@webpids=$$(lsof -ti tcp:$(WEB_PORT) 2>/dev/null); \
		if [ -n "$$webpids" ]; then kill $$webpids >/dev/null 2>&1; echo "web (vite) stopped"; fi
	@if pgrep -f "$(MATCH)" >/dev/null 2>&1; then pkill -f "$(MATCH)"; echo "daemon stopped"; else echo "no daemon running"; fi
	@sleep 1

status: ## Show whether the daemon is running
	@pid=$$(lsof -ti tcp:$(PORT) 2>/dev/null | head -1); \
	if [ -n "$$pid" ]; then echo "running (pid $$pid) on http://127.0.0.1:$(PORT)"; \
	else echo "not running"; fi

logs: ## Tail the background daemon log
	@touch $(LOG); tail -f $(LOG)

db: ## Open the Mission Control SQLite database in a read-only shell
	node scripts/db-shell.mjs

build: $(NPM_STAMP) ## Build everything (web UI, daemon, Electron main, MCP + hook satellites)
	npm run build

app: ## Build and package the macOS app (.app + .dmg) into release/
	npm run package

install-app: app ## Build, package, and copy Mission Control.app into /Applications
	@rm -rf "/Applications/Mission Control.app"
	@cp -R "release/mac-arm64/Mission Control.app" /Applications/ && echo "installed to /Applications/Mission Control.app"

icons: ## Regenerate the app icon + tray images from build/*.svg (needs rsvg-convert)
	node scripts/gen-icons.mjs

demo: ## Build and boot the token-free demo mode (real daemon, scripted agents), state at ~/.mission-control-demo
	npm run build && npm run demo

demo-fresh: ## Same as `demo`, but rebuilds state and seeds a lived-in fleet first (takes a few minutes)
	npm run build && npm run demo -- --fresh

# The quality gates need the dependency tree, and a freshly leased worktree has none
# (`make session` cuts a new one, and nothing in it has run `npm install` yet). Without
# this, `make check` fails with `TS2688: Cannot find type definition file for 'node'` and
# `make test` fails EVERY test file - a broken environment that reads as a broken change,
# which is exactly how it reads to a review workflow running the gates for you.
#
# A STAMP rather than the `node_modules` directory itself. Make is satisfied by a target
# that exists, and a directory always exists once anything has been installed into it -
# so depending on it directly would install once and then never again, quietly running
# the gates against stale dependencies after a pull or a branch switch moved
# `package.json` or the lockfile. The stamp carries the manifests as prerequisites, so
# it goes out of date exactly when they change.
#
# It lives INSIDE `node_modules` so `rm -rf node_modules` invalidates it too, and it is
# touched only after a successful install, so a failed one is retried rather than
# recorded as done. Never `.PHONY`, or every gate reinstalls.
$(NPM_STAMP): package.json package-lock.json
	npm install
	@touch $@

test: $(NPM_STAMP) ## Run the full test suite
	npm test

lint: $(NPM_STAMP) ## Lint src, hooks, test, scripts (oxlint)
	npm run lint

check: $(NPM_STAMP) ## Typecheck
	npm run typecheck

smoke: $(NPM_STAMP) ## Boot the built bundles to prove they run (needs `make build` first)
	npm run smoke

hooks: ## Install the Claude status hooks
	npm run install-hooks

setup: ## Install deps, build, and wire hooks
	npm install && npm run build && npm run install-hooks
