# RFD: Thinkwell CLI Installation and Distribution

## Summary

This document proposes a distribution strategy for the `thinkwell` CLI that provides a frictionless installation experience across multiple channels: npm/npx for universal access, Homebrew for macOS/Linux power users, and local project installation for development workflows.

## Motivation

### User Expectations

Modern CLI tools set high standards for installation UX:

1. **Try before you buy** — Users expect `npx <tool>` to work instantly for exploration
2. **Minimal prerequisites** — Installation shouldn't require a complex toolchain
3. **Multiple channels** — Different users prefer npm, Homebrew, or direct downloads
4. **Fast startup** — CLI invocations should feel instant, not blocked by large downloads

### Thinkwell's Architecture

Thinkwell uses a two-tier distribution strategy:

1. **npm distribution (lightweight)** — A Node.js CLI that spawns Bun for script execution. Requires external Bun installation.
2. **Binary distribution (self-contained)** — A compiled binary with the Bun runtime embedded. No external dependencies.

Both tiers provide identical functionality:
- TypeScript-native execution (no transpilation step for users)
- Automatic schema generation from `@JSONSchema` types
- `thinkwell:*` import resolution

The binary distribution is made possible by Bun's `--compile` flag, which embeds the complete Bun runtime (~65MB) into a standalone executable. Critically, this embedded runtime retains full dynamic import capability—user scripts are loaded and executed at runtime, not bundled at build time. This means the compiled `thinkwell` binary can run arbitrary `.ts` files without any external Bun installation.

## Proposal

### Distribution Tiers

| Method | Use Case | Command |
|--------|----------|---------|
| **npx** | Try it out, one-off usage | `npx thinkwell init` |
| **Local install** | Project development | `bun add -D thinkwell` |
| **Homebrew** | System-wide for power users | `brew install dherman/thinkwell/thinkwell` |

### Package Structure

The `thinkwell` npm package is a standard TypeScript package compiled to JavaScript:

```
thinkwell/
├── package.json
├── bin/
│   └── thinkwell.js      # CLI entry point (Node-compatible)
├── src/
│   └── cli.ts            # CLI implementation
└── dist/
    └── cli.js            # Compiled JavaScript
```

**package.json:**
```json
{
  "name": "thinkwell",
  "bin": {
    "thinkwell": "./bin/thinkwell.js"
  },
  "engines": {
    "node": ">=18"
  }
}
```

This is intentionally simple—no platform-specific binaries, no `optionalDependencies`, just a standard npm package.

### npx Experience

Users can immediately try thinkwell without installation:

```bash
# Initialize a new project
npx thinkwell init

# Get help
npx thinkwell --help

# Run a script (requires Bun)
npx thinkwell run hello.ts
```

The package size is small (a few MB), so `npx thinkwell` downloads quickly and starts immediately.

### Runtime Detection (npm distribution only)

The npm package uses a Node.js launcher that delegates to Bun. When a command requires the Bun runtime (like `run`), the CLI:

1. Checks if Bun is installed (`which bun` or equivalent)
2. If not installed, displays a helpful error with installation instructions
3. If installed, spawns Bun with the appropriate arguments

```
┌─────────────────────────────────────────────────────────────────┐
│  npx thinkwell run myscript.ts                                  │
│  ───────────────────────────────────────────────────────────────│
│  1. Node executes the thinkwell CLI launcher                    │
│  2. CLI parses args, identifies "run" command                   │
│  3. CLI checks: is Bun installed?                               │
│     ├─ No  → Error with installation instructions               │
│     └─ Yes → Spawn Bun with thinkwell plugin preloaded          │
│  4. Bun executes the user's script                              │
└─────────────────────────────────────────────────────────────────┘
```

**Note:** This detection only applies to npm distribution. The compiled binary has Bun embedded and executes scripts directly:

```
┌─────────────────────────────────────────────────────────────────┐
│  thinkwell run myscript.ts  (compiled binary)                   │
│  ───────────────────────────────────────────────────────────────│
│  1. Embedded Bun runtime starts                                 │
│  2. CLI parses args, identifies "run" command                   │
│  3. bun-plugin registers @JSONSchema transformer                │
│  4. dynamic import() loads and executes user script             │
└─────────────────────────────────────────────────────────────────┘
```

**Error message when Bun is not installed (npm distribution only):**
```
error: Bun is required to run thinkwell scripts

The thinkwell runtime uses Bun for TypeScript execution and schema
generation. This also enables features like compiled executables.

To install Bun:

  curl -fsSL https://bun.sh/install | bash

Or via Homebrew:

  brew install oven-sh/bun/bun

For more information: https://bun.sh
```

### Bun Requirements by Distribution

The Bun requirement depends on how thinkwell is installed:

| Command | npm distribution | Binary distribution |
|---------|------------------|---------------------|
| `thinkwell --help` | No Bun needed | No Bun needed |
| `thinkwell --version` | No Bun needed | No Bun needed |
| `thinkwell init` | No Bun needed | No Bun needed |
| `thinkwell run <script>` | **Requires Bun** | No Bun needed |
| `thinkwell types` | **Requires Bun** | No Bun needed |
| `thinkwell build` | **Requires Bun** | No Bun needed |

For npm users, this means they can explore thinkwell, initialize projects, and read documentation without installing Bun. They only need Bun when they're ready to run code.

For Homebrew/binary users, **no external Bun installation is ever required**—the binary is fully self-contained.

### Homebrew Distribution

For users who prefer system-wide installation, a Homebrew formula provides a convenient option.

**Tap structure:**
```
homebrew-thinkwell/
└── Formula/
    └── thinkwell.rb
```

**Formula (npm-based):**
```ruby
class Thinkwell < Formula
  desc "AI agent orchestration framework"
  homepage "https://github.com/dherman/thinkwell"
  url "https://registry.npmjs.org/thinkwell/-/thinkwell-1.0.0.tgz"
  sha256 "..."
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  def caveats
    <<~EOS
      thinkwell requires Bun to run scripts. Install Bun with:

        brew install oven-sh/bun/bun

      Or visit https://bun.sh for other installation options.
    EOS
  end

  test do
    assert_match "thinkwell", shell_output("#{bin}/thinkwell --version")
  end
end
```

**Installation:**
```bash
brew tap dherman/thinkwell
brew install thinkwell
```

The formula installs from npm and displays a caveat about the Bun requirement. This is suitable for initial testing but not the recommended long-term approach.

### Recommended: Compiled Binary via Homebrew

The preferred Homebrew distribution uses self-contained binaries with the Bun runtime embedded:

```ruby
class Thinkwell < Formula
  desc "AI agent orchestration framework"
  homepage "https://github.com/dherman/thinkwell"
  version "1.0.0"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/dherman/thinkwell/releases/download/v1.0.0/thinkwell-darwin-arm64.tar.gz"
      sha256 "..."
    end
    on_intel do
      url "https://github.com/dherman/thinkwell/releases/download/v1.0.0/thinkwell-darwin-x64.tar.gz"
      sha256 "..."
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/dherman/thinkwell/releases/download/v1.0.0/thinkwell-linux-arm64.tar.gz"
      sha256 "..."
    end
    on_intel do
      url "https://github.com/dherman/thinkwell/releases/download/v1.0.0/thinkwell-linux-x64.tar.gz"
      sha256 "..."
    end
  end

  def install
    bin.install "thinkwell"
  end

  test do
    assert_match "thinkwell", shell_output("#{bin}/thinkwell --version")
  end
end
```

This approach:
- **Fully self-contained** — No Node.js or Bun dependencies required
- **Faster CLI startup** — Embedded Bun runtime, no subprocess spawning
- **Simpler user experience** — `brew install` just works, no caveats about additional dependencies
- Requires release automation for binary uploads (see Phase 4)

The embedded Bun runtime (~65MB per platform) retains full dynamic import capability, so user TypeScript scripts are loaded and executed at runtime—not bundled at build time. This means the compiled binary provides the complete thinkwell experience without any external dependencies.

### Local Project Installation

For project development, users install thinkwell as a dev dependency:

```bash
# Recommended (if using Bun)
bun add -D thinkwell

# Also works
npm install -D thinkwell
pnpm add -D thinkwell
yarn add -D thinkwell
```

This makes `thinkwell` available in npm scripts:

```json
{
  "scripts": {
    "dev": "thinkwell run src/main.ts",
    "build": "thinkwell build src/main.ts -o dist/main"
  }
}
```

## User Communication

### Documentation Structure

The installation guide should use a tabbed interface (like Biome and Vite) showing multiple package managers:

```markdown
## Installation

### Quick Start

Try thinkwell without installing:

\`\`\`bash
npx thinkwell init my-project
\`\`\`

### Prerequisites

Thinkwell requires [Bun](https://bun.sh) to run scripts. Install it with:

\`\`\`bash
curl -fsSL https://bun.sh/install | bash
\`\`\`

### Project Installation

<!-- Tabs: npm | pnpm | yarn | bun -->

\`\`\`bash
npm install -D thinkwell
\`\`\`

### System-Wide Installation

\`\`\`bash
brew install dherman/thinkwell/thinkwell
\`\`\`
```

### Messaging the Bun Dependency

For **npm users**, the Bun requirement should be framed as a feature, not a limitation:

> Thinkwell uses Bun as its runtime, giving you:
> - Native TypeScript execution (no transpilation step)
> - Automatic schema generation from your types
> - The ability to compile agents into standalone executables
>
> Install Bun: `curl -fsSL https://bun.sh/install | bash`

For **Homebrew/binary users**, emphasize the zero-dependency experience:

> Install thinkwell with a single command—no additional dependencies required:
> ```bash
> brew install dherman/thinkwell/thinkwell
> ```
> The thinkwell binary includes everything needed to run your TypeScript agents.

## Alternatives Considered

### 1. Compiled Binaries via npm optionalDependencies

Distribute platform-specific Bun-compiled binaries using npm's `optionalDependencies`:

```json
{
  "optionalDependencies": {
    "@thinkwell/darwin-arm64": "1.0.0",
    "@thinkwell/darwin-x64": "1.0.0",
    "@thinkwell/linux-arm64": "1.0.0",
    "@thinkwell/linux-x64": "1.0.0",
    "@thinkwell/win32-x64": "1.0.0"
  }
}
```

**Pros:**
- Fastest possible CLI startup
- No runtime dependencies

**Cons:**
- 50-100MB download per platform
- Adds significant latency to first `npx thinkwell` invocation
- Complex release process (5+ packages per release)
- Overkill when workloads are IO-bound anyway

**Decision:** Rejected. The CLI itself doesn't benefit enough from Bun's speed to justify the download size and complexity. This pattern makes sense for compute-bound tools like esbuild, but thinkwell's agent invocations dominate performance.

### 2. Require Bun for CLI Invocation

Make `bunx thinkwell` the primary invocation, don't support `npx thinkwell`.

**Pros:**
- Simpler implementation
- Single runtime path

**Cons:**
- Poor discoverability (npx is more universal)
- Barrier to trying thinkwell
- Some commands (`init`, `--help`) don't need Bun

**Decision:** Rejected. The CLI should be accessible via npx for discoverability. Bun is only required when actually executing scripts.

### 3. npx bun thinkwell

Use `npx bun` as a bridge to run thinkwell under Bun without requiring Bun installation.

**Pros:**
- Works anywhere npm works
- No Bun pre-installation needed

**Cons:**
- Verbose: `npx bun thinkwell` instead of `npx thinkwell`
- First run downloads ~100MB Bun binary
- Confusing mental model

**Decision:** Rejected. The verbosity and download size make this a poor user experience.

### 4. Shell Script Installer

Provide a curl-based installer like Deno:

```bash
curl -fsSL https://thinkwell.dev/install.sh | bash
```

**Pros:**
- Single command installation
- Can install both thinkwell and Bun together

**Cons:**
- Requires hosting infrastructure
- Some users distrust curl-pipe-bash
- Adds maintenance burden

**Decision:** Deferred. npm and Homebrew cover most use cases. A shell installer could be added later for specific deployment scenarios (CI/CD, Docker).

## Future Work

### Runtime Flexibility

As discussed in the bun-schema-plugin RFD, Node.js runtime support may be added in the future. The CLI's runtime detection could be extended:

```bash
# Future: explicit runtime selection
thinkwell run --runtime=node script.ts
thinkwell run --runtime=bun script.ts   # default

# Future: environment variable
THINKWELL_RUNTIME=node thinkwell run script.ts
```

This maintains `thinkwell run` as the stable interface regardless of which runtime executes the script.

### Version Management

Consider integration with version managers:

- **asdf:** `asdf plugin add thinkwell`
- **mise:** `mise use thinkwell@latest`

These would be community-contributed plugins rather than first-party maintained.

### CI/CD Considerations

For CI/CD environments, two approaches are available:

**Option 1: npm + Bun (smaller download, requires Bun setup)**
```yaml
# GitHub Actions example
- uses: oven-sh/setup-bun@v1
- run: npm install -g thinkwell
- run: thinkwell build src/agent.ts -o dist/agent
```

**Option 2: Direct binary download (self-contained, no setup)**
```yaml
# GitHub Actions example
- run: |
    curl -fsSL https://github.com/dherman/thinkwell/releases/download/v1.0.0/thinkwell-linux-x64.tar.gz | tar xz
    ./thinkwell build src/agent.ts -o dist/agent
```

The binary approach is simpler (no Bun setup step) but has a larger download (~65MB vs ~5MB for the npm package).

## References

- [Bun Installation](https://bun.sh/docs/installation)
- [npm package.json bin field](https://docs.npmjs.com/cli/v10/configuring-npm/package-json#bin)
- [Homebrew Formula Cookbook](https://docs.brew.sh/Formula-Cookbook)
- [Biome Installation Guide](https://biomejs.dev/guides/getting-started/) — Example of multi-channel distribution
- [esbuild Installation](https://esbuild.github.io/getting-started/) — Example of optionalDependencies pattern
- [RFD: Thinkwell CLI and Bun Plugin](./bun-schema-plugin.md)
