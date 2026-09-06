# Security policy

Mission Control's security posture, including loopback-only service access, local ingress
authentication, data minimization, and the separately armed Inspector and YOLO-mode
permissions, is documented in [Security](docs/security.md).

## Supported versions

Security fixes are provided for the latest stable release. Reproduce a suspected issue on the
latest release before reporting it when you can do so safely.

## Reporting a vulnerability

Do not open a public issue or discussion for a suspected vulnerability. Use Upstart's
[vulnerability reporting form](https://www.upstart.com/lenders/regulatory-compliance/vulnerability-reporting/)
so the report reaches the security team through a private channel.

Maintainers intend to switch this policy to GitHub private vulnerability reporting after that
repository feature is enabled and its reporting form has been verified. Do not publish an
unverified reporting link or include vulnerability details in a public issue.

Include:

- The affected version or commit.
- A clear description of the impact and affected component.
- Reproduction steps or a minimal proof of concept.
- Any known mitigations or workarounds.

Do not include live tokens, credentials, personal data, private repository content, or other
secrets. Use redacted examples instead. Maintainers will coordinate validation, remediation,
release timing, and disclosure through the private advisory.
