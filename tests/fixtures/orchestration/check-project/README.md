# check-project

A tiny project used as the target of a real check run inside the sandbox (stage-4-contract.md §9). It is a fixture:
copied into a temporary source repository by the tests, never installed and never published.

- `src/sum.mjs` — the code under test.
- `tests/sum.test.mjs` — the check that passes.
- `tests/broken.test.mjs` — the check that fails, used for the `failed` verdict.
- `package-lock.json` — a lockfile with no dependencies: `preparedDeps.lockfileSha256` is its sha256, so a test can
  change it and get `not_verified(deps_changed)`.
- `node_modules/` is not part of the fixture: the runner symlinks it to the prepared dependencies of the source.
