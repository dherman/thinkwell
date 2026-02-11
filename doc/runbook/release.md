# Release Runbook

This runbook describes how to publish releases of thinkwell to npm and Homebrew.

## Prerequisites

- You're working on the main branch
- All changes for the release have been merged

## Pre-release (Alpha)

Pre-releases are published with the npm `next` tag and Homebrew `thinkwell-next` formula. Version format: `X.Y.Z-alpha.N` (e.g., `0.5.0-alpha.1`).

### 1. Version Bump

Update the version in:
- All `packages/*/package.json` files
- The `VERSION` constant in `packages/thinkwell/src/cli/main.cjs`

All versions must match.

Commit the version bump:

```bash
git add packages/*/package.json packages/thinkwell/src/cli/main.cjs
git commit -m "chore: bump version to 0.5.0-alpha.1"
```

### 2. Create and Push Tag

```bash
git tag v0.5.0-alpha.1
git push origin main
git push origin v0.5.0-alpha.1
```

This triggers the GitHub Actions release workflow, which:
- Builds binaries for all platforms (darwin-arm64, darwin-x64, linux-x64, linux-arm64)
- Creates a GitHub Release with binaries and checksums
- Marks it as a pre-release (due to "alpha" in the tag)

### 3. Publish to npm

```bash
pnpm -r publish --tag next --access public --no-git-checks
```

This publishes all packages to the `next` tag (for pre-releases).

### 4. Update Homebrew Formula

After the GitHub Release is created (wait for the workflow to complete):

1. Fetch the SHA256 checksums from the release:
   ```bash
   gh release download v0.5.0-alpha.1 --repo dherman/thinkwell --pattern 'SHA256SUMS.txt' --output -
   ```

2. Update the formula in the Homebrew tap repository:
   ```bash
   cd /Users/dherman/Code/homebrew-thinkwell
   ```

   Edit `Formula/thinkwell-next.rb`:
   - Update `version` to the new version
   - Update all `url` fields to point to the new release
   - Update all `sha256` fields with the new checksums

3. Commit and push the formula update:
   ```bash
   git add Formula/thinkwell-next.rb
   git commit -m "chore: update thinkwell-next to 0.5.0-alpha.1"
   git push origin main
   ```

### 5. Verify Installation

Test both installation methods:

```bash
# npm
npx thinkwell@next --version

# Homebrew
brew update
brew upgrade thinkwell-next
# or for fresh install:
brew install dherman/thinkwell/thinkwell-next
```

---

## Stable Release

Stable releases are published with the npm `latest` tag (default) and Homebrew `thinkwell` formula.

### 1. Version Bump

Update the version in:
- All `packages/*/package.json` files
- The `VERSION` constant in `packages/thinkwell/src/cli/main.cjs`

All versions must match.

Commit the version bump:

```bash
git add packages/*/package.json packages/thinkwell/src/cli/main.cjs
git commit -m "chore: bump version to 0.5.0"
```

### 2. Create and Push Tag

```bash
git tag v0.5.0
git push origin main
git push origin v0.5.0
```

This triggers the GitHub Actions release workflow, which:
- Builds binaries for all platforms (darwin-arm64, darwin-x64, linux-x64, linux-arm64)
- Creates a GitHub Release with binaries and checksums
- Since the tag doesn't contain "alpha", "beta", or "rc", it's marked as a stable release

### 3. Publish to npm

```bash
pnpm -r publish --access public --no-git-checks
```

This publishes all packages to the `latest` tag (default for stable releases).

### 4. Update Homebrew Formula

After the GitHub Release is created (wait for the workflow to complete):

1. Fetch the SHA256 checksums from the release:
   ```bash
   gh release download v0.5.0 --repo dherman/thinkwell --pattern 'SHA256SUMS.txt' --output -
   ```

2. Update the formula in the Homebrew tap repository:
   ```bash
   cd /Users/dherman/Code/homebrew-thinkwell
   ```

   Edit `Formula/thinkwell.rb`:
   - Update `version` to the new version
   - Update all `url` fields to point to the new release
   - Update all `sha256` fields with the new checksums

3. Commit and push the formula update:
   ```bash
   git add Formula/thinkwell.rb
   git commit -m "chore: update thinkwell to 0.5.0"
   git push origin main
   ```

### 5. Verify Installation

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
