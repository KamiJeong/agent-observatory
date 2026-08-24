# Contributing to Agent Observatory

## Development flow

This repository uses GitHub Flow. `main` is the only long-lived branch and must
remain releasable. All changes go through a focused pull request and the required
CI checks before merge.

1. Open or select an issue for non-trivial work.
2. Create a short-lived branch from the latest `main`.
3. Make the change, add tests, and run the local checks.
4. Open a pull request using the repository template.
5. Resolve review comments and wait for the `Quality` and `E2E` checks.
6. Squash-merge after approval and all required checks pass.

Use these branch prefixes:

- `feat/<issue>-<description>` for user-facing features
- `fix/<issue>-<description>` for defects
- `docs/<description>` for documentation-only changes
- `chore/<description>` for maintenance and CI changes
- `release/<version>` for version-only release pull requests

Use a Conventional Commits title for each pull request, such as `feat: add agent
filtering` or `fix: retain waiting state`. The squash commit inherits this title
and keeps generated release notes readable.

## Local verification

Run the same checks used by CI before requesting review:

```bash
npm ci
npm run typecheck
npm test
npm run build:cli
npx playwright install chromium
npm run test:e2e
```

Keep pull requests focused. Update documentation when commands, configuration,
protocol compatibility, or supported platforms change. Never include tokens,
private prompts, or user-specific Codex data in fixtures, logs, screenshots, or
issues.

## Release flow

Releases are initiated by a version-only pull request after the intended feature
and fix pull requests have reached `main`.

1. Create `release/x.y.z` from the latest `main`.
2. Run `npm version patch --no-git-tag-version` (or `minor`/`major`).
3. Review `package.json` and `package-lock.json`, then open a pull request labeled
   `release`.
4. Merge only after `Quality` and `E2E` pass.
5. The `Publish npm` workflow repeats the full test suite, publishes the new
   version with npm Trusted Publishing, and creates a matching GitHub Release and
   `vX.Y.Z` tag.

The publish job uses the protected `npm` GitHub environment. Configure the npm
package's trusted publisher with repository `KamiJeong/agent-observatory`,
workflow `publish.yml`, and environment `npm`. The workflow intentionally skips
an already-published version, so reruns are safe.

Version numbers must never be reused. If publication fails after a version is
reserved, create a new patch version instead of replacing the published package.
