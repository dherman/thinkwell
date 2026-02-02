# Stable Release Runbook

This runbook describes how to publish a stable release of thinkwell to npm and Homebrew.

## Prerequisites

- All pre-release testing is complete
- PR has been merged to main
- You're working on the main branch

## 1. Version Bump

Update the version in:
- All `packages/*/package.json` files
- The `VERSION` constant in `packages/thinkwell/src/cli/main.ts`
- The `VERSION` constant in `packages/thinkwell/src/cli/main-pkg.cjs`

All versions must match.

Commit the version bump:

```bash
git add packages/*/package.json
git commit -m "chore: bump version to 0.3.0"
```

## 2. Create and Push Tag

```bash
git tag v0.3.0
git push origin main
git push origin v0.3.0
```

This triggers the GitHub Actions release workflow, which:
- Builds binaries for all platforms (darwin-arm64, darwin-x64, linux-x64, linux-arm64)
- Creates a GitHub Release with binaries and checksums
- Since the tag doesn't contain "alpha", "beta", or "rc", it's marked as a stable release

## 3. Publish to npm

```bash
pnpm -r publish --access public --no-git-checks
```

This publishes all packages to the `latest` tag (default for stable releases).

## 4. Update Homebrew Formula

After the GitHub Release is created (wait for the workflow to complete):

1. Fetch the SHA256 checksums from the release:
   ```bash
   gh release download v0.3.0 --repo dherman/thinkwell --pattern 'SHA256SUMS.txt' --output -
   ```

2. Update the formula in the Homebrew tap repository (separate repo):
   - Update `version` to the new version
   - Update all `url` fields to point to the new release
   - Update all `sha256` fields with the new checksums

3. Commit and push the formula update:
   ```bash
   cd /path/to/homebrew-thinkwell
   git add Formula/thinkwell.rb
   git commit -m "chore: update formula to 0.3.0"
   git push origin main
   ```

## 5. Verify Installation

Test both installation methods:

```bash
# npm
npx thinkwell --version

# Homebrew (may need to wait for tap to update)
brew update
brew upgrade thinkwell
# or for fresh install:
brew install dherman/thinkwell/thinkwell
```

## Pre-release Process

For pre-release versions (alpha, beta, rc):

1. Set version in all `packages/*/package.json` files and `VERSION` constants in `packages/thinkwell/src/cli/main.ts` and `main-pkg.cjs` to `0.3.0-alpha.2` (or similar)
2. Tag as `v0.3.0-alpha.2`
3. Publish to npm with next tag: `pnpm -r publish --tag next --access public --no-git-checks`
4. Update Homebrew formula (optional for pre-releases)

Users install pre-releases via:
```bash
npx thinkwell@next --version
```
