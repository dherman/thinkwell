#!/bin/bash
# Update the Homebrew formula with checksums from a GitHub release
#
# Usage: ./update-formula.sh <version>
# Example: ./update-formula.sh 0.3.0-alpha.1

set -euo pipefail

VERSION="${1:-}"
if [[ -z "$VERSION" ]]; then
  echo "Usage: $0 <version>"
  echo "Example: $0 0.3.0-alpha.1"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FORMULA="$SCRIPT_DIR/Formula/thinkwell.rb"
BASE_URL="https://github.com/dherman/thinkwell/releases/download/v${VERSION}"

echo "Updating formula for version $VERSION..."

# Download SHA256SUMS.txt from the release
CHECKSUMS_URL="${BASE_URL}/SHA256SUMS.txt"
echo "Fetching checksums from $CHECKSUMS_URL"
CHECKSUMS=$(curl -fsSL "$CHECKSUMS_URL")

# Parse checksums
get_sha256() {
  local filename="$1"
  echo "$CHECKSUMS" | grep "$filename" | awk '{print $1}'
}

DARWIN_ARM64=$(get_sha256 "thinkwell-darwin-arm64.tar.gz")
DARWIN_X64=$(get_sha256 "thinkwell-darwin-x64.tar.gz")
LINUX_ARM64=$(get_sha256 "thinkwell-linux-arm64.tar.gz")
LINUX_X64=$(get_sha256 "thinkwell-linux-x64.tar.gz")

echo "Checksums:"
echo "  darwin-arm64: $DARWIN_ARM64"
echo "  darwin-x64:   $DARWIN_X64"
echo "  linux-arm64:  $LINUX_ARM64"
echo "  linux-x64:    $LINUX_X64"

# Update the formula
sed -i.bak \
  -e "s/version \"[^\"]*\"/version \"${VERSION}\"/" \
  -e "s|/v[^/]*/thinkwell-|/v${VERSION}/thinkwell-|g" \
  -e "s/PLACEHOLDER_DARWIN_ARM64/${DARWIN_ARM64}/" \
  -e "s/PLACEHOLDER_DARWIN_X64/${DARWIN_X64}/" \
  -e "s/PLACEHOLDER_LINUX_ARM64/${LINUX_ARM64}/" \
  -e "s/PLACEHOLDER_LINUX_X64/${LINUX_X64}/" \
  "$FORMULA"

# Also replace any existing SHA256 hashes (for updates after initial placeholders are replaced)
# This handles the case where we're updating from a previous release
sed -i.bak \
  -e "/darwin-arm64/,/sha256/{s/sha256 \"[a-f0-9]*\"/sha256 \"${DARWIN_ARM64}\"/}" \
  -e "/darwin-x64/,/sha256/{s/sha256 \"[a-f0-9]*\"/sha256 \"${DARWIN_X64}\"/}" \
  -e "/linux-arm64/,/sha256/{s/sha256 \"[a-f0-9]*\"/sha256 \"${LINUX_ARM64}\"/}" \
  -e "/linux-x64/,/sha256/{s/sha256 \"[a-f0-9]*\"/sha256 \"${LINUX_X64}\"/}" \
  "$FORMULA"

rm -f "$FORMULA.bak"

echo ""
echo "Formula updated successfully!"
echo "Review the changes with: git diff $FORMULA"
