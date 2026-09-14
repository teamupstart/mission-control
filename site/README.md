# site/

The published root of <https://teamupstart.github.io/mission-control/>.

`.github/workflows/pages.yml` uploads this directory to GitHub Pages on every push to `main`
that touches it. Nothing else in the repository is served, and there is no build step: the
workflow copies these bytes as they are.

## What belongs here

Self-contained pages. Every document under `artifacts/` embeds its own images as data URIs and
references nothing over the network, so it opens from a checkout, from a download, and on a
plane. The first load is large and every scroll after it is instant.

A page that needs to be built, or that fetches anything at load time, does not belong here
until `pages.yml` grows a build step and this paragraph is rewritten to say so.

`docs/` stays Markdown for reading in the repository and is deliberately not published.

## Contents

- `index.html` - the artifact index.
- `artifacts/mission-control-feature-guide.html` - the product tour that [the root
  README](../README.md) walks through, as one page with 25 screenshots from a running fleet.
  Its thirteen sections track the README's, so a change to what a feature does belongs in
  both.

## Publishing

**Settings -> Pages -> Source must be set to "GitHub Actions".** This is a repository setting
rather than a file, and it is the one part of publishing that no commit can carry. It is
already set on `teamupstart/mission-control`. A fork that wants its own copy of the site has
to set it itself.

The workflow cannot set it: `actions/configure-pages` can enable Pages through its
`enablement` input, but that input requires a PAT with `repo` or an App with
`administration:write`, and this repository's App tokens are minted for contents, issues and
pull requests only. Rather than leave a fork to a deploy-time error that names no fix,
`pages.yml` reads the setting first and fails with the exact remediation.

Once the source is set, every push to `main` that touches `site/` republishes, and
`workflow_dispatch` republishes on demand.
