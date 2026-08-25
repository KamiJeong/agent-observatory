# Security Policy

## Supported versions

Agent Observatory is currently in the `0.x` release series. Security fixes are
provided for the latest published release only. Please upgrade before reporting
an issue that may already be fixed.

| Version | Supported |
| --- | --- |
| Latest published release | Yes |
| Earlier releases | No |
| Unreleased or modified builds | Best effort |

## Reporting a vulnerability

Do not open a public issue, discussion, or pull request for a suspected
vulnerability. Report it privately through
[GitHub Private Vulnerability Reporting](https://github.com/KamiJeong/agent-observatory/security/advisories/new).

Please include as much of the following as is practical:

- The affected component and Agent Observatory version or commit.
- Your operating system and relevant Node.js, Bun, and Codex CLI versions.
- The security impact, affected data or capabilities, and required conditions.
- Reproduction steps or a minimal proof of concept.
- Any known mitigations or suggested remediation.
- Whether you want public credit and any disclosure constraints.

Redact tokens, credentials, personal data, and unrelated project content. Do not
include a real secret when a synthetic value can demonstrate the issue.

## What to expect

The maintainer will acknowledge and triage reports as soon as reasonably
practical. Response and remediation time depends on severity, reproducibility,
and release complexity, so a fixed resolution timeline is not guaranteed.
Meaningful status updates will be shared through the private advisory, and the
maintainer may ask for additional details or validation of a proposed fix.

Please keep the report and related technical details private until a disclosure
date is coordinated. If the issue is accepted, the maintainer will work with the
reporter on remediation, release timing, advisory publication, and credit.

## Scope

This policy covers vulnerabilities in this repository and the official
`agent-observatory` npm package, including the local server, web application,
Codex integration, CLI packaging, and release automation.

Issues in Codex CLI, GitHub, npm, or another upstream dependency should normally
be reported to that project's security contact. If an upstream issue is directly
exploitable through Agent Observatory, please also report the integration impact
privately here. Bugs without a security impact belong in the public issue
tracker.

When researching, avoid accessing data that is not your own, disrupting other
users or services, or retaining sensitive data beyond what is necessary to
demonstrate the issue.
