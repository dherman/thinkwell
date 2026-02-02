# Homebrew Tap for Thinkwell

This directory contains the Homebrew formula for installing thinkwell.

## Installation

```bash
brew tap dherman/thinkwell https://github.com/dherman/thinkwell
brew install thinkwell
```

Or install directly:

```bash
brew install dherman/thinkwell/thinkwell
```

## Self-Contained Binary

The Homebrew formula installs a self-contained binary that includes the Bun runtime. No additional dependencies (Node.js, Bun, etc.) are required.

## Updating the Formula

When creating a new release:

1. Tag the release:
   ```bash
   git tag v0.3.0
   git push origin v0.3.0
   ```

2. Wait for the GitHub Actions workflow to build and upload binaries

3. Update the formula with the new checksums:
   ```bash
   ./homebrew/update-formula.sh 0.3.0
   ```

4. Test locally:
   ```bash
   brew install --build-from-source ./homebrew/Formula/thinkwell.rb
   ```

5. Commit and push the updated formula

## Manual Formula Update

If you need to update manually, download the SHA256SUMS.txt from the GitHub release and update the sha256 values in `Formula/thinkwell.rb`.
