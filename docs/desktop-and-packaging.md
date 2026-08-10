# Desktop shell and packaging

Mission Control can run as a local daemon during development or as a macOS Electron app.
The [Electron main process](../src/main/index.ts) starts the daemon and embeds the dashboard;
the [preload entrypoint](../src/preload/index.ts) keeps the renderer boundary explicit.

The build creates separate bundles for the web dashboard, daemon, Electron main and preload
processes, MCP server, and hook bridges. The commands are defined in
[`package.json`](../package.json). [`electron-builder.yml`](../electron-builder.yml) packages
the built files and a small set of source assets that external tools read at runtime.

The package intentionally leaves `asar` disabled. Hook and MCP satellite scripts are launched
by an external Node process, and skills are read through filesystem links, so both require
plain files on disk. The Electron shell starts the daemon; it does not become a second state
owner.

See [Configuration and commands](configuration.md) for operating the app. Packaging and
build-surface rules are authoritative in the [Electron and build surfaces contract](agent-guides/change-contracts.md#electron-and-build-surfaces)
and [process-boundary guide](agent-guides/architecture.md#process-boundaries).
