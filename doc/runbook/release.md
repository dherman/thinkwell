# Release Runbook

This runbook describes how to publish releases of thinkwell to npm, Homebrew, and the VSCode Marketplace.

## Prerequisites

- You're working on the main branch
- All changes for the release have been merged
- You're logged in to `vsce` (`npx @vscode/vsce login thinkwell`) with a valid Azure DevOps PAT (Marketplace > Manage scope)

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

### 4. Publish VSCode Extension

Build the `.vsix` package and publish to the VSCode Marketplace:

```bash
pnpm --filter thinkwell-vscode package
npx @vscode/vsce publish --pre-release --packagePath packages/vscode-extension/thinkwell-vscode-0.5.0-alpha.1.vsix
```

The `--packagePath` flag publishes the pre-built `.vsix` directly, bypassing `npm list` validation (which doesn't work with pnpm workspaces). The `--pre-release` flag marks it as a pre-release in the marketplace.

### 5. Update Homebrew Formula

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

### 6. Verify Installation

Test all installation methods:

```bash
# npm
npx thinkwell@next --version

# Homebrew
brew update
brew upgrade thinkwell-next
# or for fresh install:
brew install dherman/thinkwell/thinkwell-next

# VSCode Extension
# Search for "Thinkwell" in the Extensions panel and verify the pre-release version
```

---

## Stable Release

Stable releases are published with the npm `latest` tag (default), Homebrew `thinkwell` formula, and as a stable VSCode Marketplace release.

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

### 4. Publish VSCode Extension

Build the `.vsix` package and publish to the VSCode Marketplace:

```bash
pnpm --filter thinkwell-vscode package
npx @vscode/vsce publish --packagePath packages/vscode-extension/thinkwell-vscode-0.5.0.vsix
```

### 5. Update Homebrew Formula

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

### 6. Verify Installation

Test all installation methods:

```bash
# npm
npx thinkwell --version

# Homebrew (may need to wait for tap to update)
brew update
brew upgrade thinkwell
# or for fresh install:
brew install dherman/thinkwell/thinkwell

# VSCode Extension
# Search for "Thinkwell" in the Extensions panel and verify the stable version
```
