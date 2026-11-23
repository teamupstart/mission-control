# residents/

The resident profiles Mission Control ships. Each document here is a **built-in resident**:
it is installed on every machine, opened read-only on the Residents page, and replaced by
the new build's copy when Mission Control upgrades. Operators customize one with
**Duplicate to edit**, which makes an ordinary profile they own.

Each document is compiled into the build: `npm run residents` embeds its exact bytes in
`src/server/residents/builtin-residents.generated.ts`. Edit the Markdown here, run the
generator, and commit the generated module. Never hand-edit it.

- The filename is the durable half of the profile id (`builtin:<filename>`). Never rename or
  remove a shipped document: running residents and their history name that id.
- The first level-one heading is the profile's name and the paragraph under it is its
  description. The whole document becomes the profile's instructions.
- Every other setting (harness, model, loop, authority) lives beside the document's slug in
  `src/server/residents/builtin-residents.ts`.

See [docs/residents.md](../docs/residents.md#built-in-residents).
