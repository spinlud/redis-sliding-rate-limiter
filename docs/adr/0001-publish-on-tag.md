# 1. Publish on tag

- Status: Accepted
- Date: 2026-09-12

## Context

CI published to npm on every push to `master`. Releases were therefore an
implicit side effect of merging, with no deliberate release gesture and no
correspondence between what shipped to npm and the git history:

- Version bumps were folded into unrelated commits. `6.0.0` was set in a commit
  titled "Libs", not a release commit.
- Several published versions (`5.0.4`–`5.0.8`, `6.0.0`) were never git-tagged, so
  the tag history stops at `v5.0.3` while npm's latest is `6.0.0`.
- Any accidental push to `master` carrying a new version number would publish.

## Decision

`npm publish` runs only when a `v*` tag is pushed. The CI `publish` job is gated
on `startsWith(github.ref, 'refs/tags/v')`; pushes to branches (including
`master`) run tests only. A guard step fails the publish when the pushed tag does
not match the `version` in `package.json`, so a stale or mistaken tag cannot ship.

To reconcile history, the missing `v6.0.0` tag was created on commit `bd1fb98`
(the commit that set `version` to `6.0.0`), recording the already-published `6.0.0`
release.

## Consequences

- A release is now an explicit act: bump `package.json`, then push a matching
  `v<version>` tag. Tag and npm version always correspond going forward.
- Branch and `master` pushes no longer publish; they only run the test matrix.
- Publishing a version that already exists on npm fails, as it should; the guard
  catches tag/version mismatches earlier.
- Older published-but-untagged versions (`5.0.4`–`5.0.8`) remain untagged;
  backfilling them is out of scope for this change.
