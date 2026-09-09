# GitHub Actions

A minimal workflow for running `metonym check` on every push and pull
request, with the generated-test cache preserved between runs.

```yaml
name: docs

on:
  push:
    branches: [main]
  pull_request:

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: oven-sh/setup-bun@v2

      - run: bun install --frozen-lockfile

      - uses: actions/cache@v4
        with:
          path: .metonym/
          key: ${{ runner.os }}-metonym-${{ hashFiles('bun.lock') }}

      - if: github.event_name == 'push'
        run: bunx metonym check --full

      - if: github.event_name == 'pull_request'
        run: git fetch origin ${{ github.base_ref }}

      - if: github.event_name == 'pull_request'
        run: bunx metonym check --changed=origin/${{ github.base_ref }}
```

On `push` to the default branch, `--full` bypasses the result cache and
runs every example, so the cached `.metonym/` state stays trustworthy for
the `--changed` runs on pull requests. On `pull_request`, `--changed`
narrows the run to examples affected by the diff against the PR's base
branch, which needs that branch fetched first since `actions/checkout`
only fetches the PR's own ref by default.

No `--reporter` flag is needed: `metonym check` auto-selects the `github`
reporter whenever `GITHUB_ACTIONS=true` (which GitHub sets on every
runner), so failures and pending examples show up as inline annotations
on the diff. Pass `--reporter=pretty` to opt back into plain output.

## Monorepos

`bunx metonym check --workspaces` runs `check` in every
`package.json#workspaces` package, and each package keeps its own result
cache under its own `.metonym/`, not a single top-level one. Change the
cache step's `path` to `"**/.metonym"` so every package's cache is saved
and restored, not just the root's:

```yaml
      - uses: actions/cache@v4
        with:
          path: "**/.metonym"
          key: ${{ runner.os }}-metonym-${{ hashFiles('bun.lock') }}
```

GitHub-hosted `pull_request` jobs already run in a VM, and fork PRs do
not get secrets by default. If you add secrets to this workflow or
switch to `pull_request_target`, treat `metonym check` like `bun test`:
run it without those secrets, or in a separate job. See the
[Security](../src/README.md#security) section of the README for the
full trust model.
