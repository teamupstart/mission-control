---
category: tooling-trap
date: 2026-08-14
source-session: unknown
times-confirmed: 1
---

# A raw URL is not a private PR image attachment

A commit-pinned `raw.githubusercontent.com` URL can return `404` in a private pull request comment even when the commit, path, and blob are all valid. Pinning the SHA makes the revision stable, but it does not carry the repository authentication needed to retrieve the image. PR #566 demonstrated this with the same 79,881-byte blob at both the linked commit and the current PR head.

For any image that must render in an issue or pull request comment, attach or paste it through GitHub's signed-in comment UI and use the anonymized attachment URL GitHub inserts. Verify it from an authorized reviewer context, or fetch it with an authenticated client and compare its byte count with the local file. An anonymous `404` is expected for private assets and is not a useful verification. A documentation image may also remain under `docs/images/`, but its raw repository URL is not the comment transport.
