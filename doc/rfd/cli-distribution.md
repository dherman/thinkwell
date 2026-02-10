# RFD: Thinkwell CLI Installation and Distribution

**Implementation:** [PR #15](https://github.com/dherman/thinkwell/pull/15)

## Summary

This document describes the distribution strategy for the `thinkwell` CLI, providing a frictionless installation experience across multiple channels: npm/npx for universal access, Homebrew for macOS/Linux power users, and local project installation for development workflows.

## Current Architecture

Thinkwell uses a unified distribution strategy where both the npm distribution and the compiled binary use the same execution path based on Node.js 24 with experimental TypeScript support.

### Key Design Decisions

1. **Node.js 24 Runtime** — Both distributions use Node.js 24's `--experimental-transform-types` for native TypeScript execution
2. **pkg for Binary Compilation** — Self-contained binaries are built using [yao-pkg/pkg](https://github.com/yao-pkg/pkg)
3. **Unified Loader** — Both npm and binary distributions use the same script loader infrastructure
4. **Pre-bundled Packages** — Thinkwell packages are pre-bundled into CJS format for reliable resolution

### Distribution Tiers

| Method | Use Case | Command |
|--------|----------|---------|
| **npx** | Try it out, one-off usage | `npx thinkwell init` |
| **Local install** | Project development | `npm install -D thinkwell` |
| **Homebrew** | System-wide for power users | `brew install dherman/thinkwell/thinkwell` |

## Architecture Overview

### Execution Flow

Both the npm distribution (`bin/thinkwell`) and the pkg binary (`main-pkg.cjs`) share the same execution path:

```
┌─────────────────────────────────────────────────────────────────┐
│ thinkwell run script.ts                                         │
│ ───────────────────────────────────────────────────────────────│
│ 1. CLI entry point validates Node.js 24+ (npm) or starts (pkg) │
│ 2. CLI parses args, identifies "run" command                    │
│ 3. Pre-bundled thinkwell packages loaded into global.__bundled__│
│ 4. Script loader reads user script                              │
│ 5. Transforms thinkwell:* imports and @JSONSchema types         │
│ 6. Writes transformed script to temp file                       │
│ 7. Node.js require() loads script with transform-types enabled  │
└─────────────────────────────────────────────────────────────────┘
```

### Module Resolution Architecture

The CLI uses a custom loader that routes imports appropriately:

```javascript
// Bundled thinkwell packages
if (global.__bundled__[moduleName]) {
  return global.__bundled__[moduleName];
}

// External packages from user's node_modules
const resolved = require.resolve(moduleName, {
  paths: [scriptDir, path.join(scriptDir, 'node_modules')]
});
return require(resolved);
```

This ensures:
- **Bundled packages** (thinkwell, @thinkwell/acp, etc.) are served from the binary's virtual filesystem
- **User packages** are resolved from the user's actual `node_modules` directory

### Virtual Module Registry

The CLI entry point registers bundled exports before loading user scripts:

```javascript
global.__bundled__ = {
  'thinkwell': require('./dist-pkg/thinkwell.cjs'),
  '@thinkwell/acp': require('./dist-pkg/acp.cjs'),
  '@thinkwell/protocol': require('./dist-pkg/protocol.cjs'),
};
```

### Import Transformation

User scripts using `thinkwell:*` imports are transformed at load time:

```typescript
// User writes:
import { Agent } from "thinkwell:agent";

// Transformed to:
const { Agent } = global.__bundled__["thinkwell"];
```

### @JSONSchema Processing

Types marked with `@JSONSchema` JSDoc tags are processed at load time:

1. **Type Discovery** — TypeScript AST traversal finds marked types
2. **Schema Generation** — ts-json-schema-generator creates JSON schemas
3. **Code Injection** — Namespace declarations with `SchemaProvider` are injected

```typescript
// User writes:
/** @JSONSchema */
interface Person {
  name: string;
  age: number;
}

// Runtime injects:
namespace Person {
  export const Schema: SchemaProvider<Person> = ...;
}

// User can then:
const schema = Person.Schema.toJsonSchema();
```

## Build Process

### Pre-bundling Stage

Thinkwell packages are pre-bundled into CJS format using esbuild:

```
scripts/bundle-for-pkg.ts → dist-pkg/
  ├── thinkwell.cjs      (~711 KB) - bundled thinkwell package
  ├── acp.cjs            (~242 KB) - bundled @thinkwell/acp package
  ├── protocol.cjs       (~7 KB)   - bundled @thinkwell/protocol package
  └── cli-loader.cjs     (~11 MB)  - loader + ts-json-schema-generator + typescript
```

### pkg Compilation Stage

The pre-bundled CJS files are compiled into platform-specific binaries:

```bash
pkg src/cli/main-pkg.cjs --targets node24-macos-arm64 --options experimental-transform-types -o thinkwell
```

**Build scripts:**
```json
{
  "build:binary": "tsx scripts/bundle-for-pkg.ts && tsx scripts/build-binary-pkg.ts",
  "build:binary:darwin-arm64": "tsx scripts/bundle-for-pkg.ts && tsx scripts/build-binary-pkg.ts darwin-arm64",
  "build:binary:darwin-x64": "tsx scripts/bundle-for-pkg.ts && tsx scripts/build-binary-pkg.ts darwin-x64",
  "build:binary:linux-x64": "tsx scripts/bundle-for-pkg.ts && tsx scripts/build-binary-pkg.ts linux-x64",
  "build:binary:linux-arm64": "tsx scripts/bundle-for-pkg.ts && tsx scripts/build-binary-pkg.ts linux-arm64"
}
```

## npm Distribution

### Package Structure

```
thinkwell/
├── package.json
├── bin/
│   └── thinkwell          # CLI launcher (validates Node.js 24+)
├── dist/
│   └── *.js               # Compiled library code
└── dist-pkg/
    ├── thinkwell.cjs      # Pre-bundled thinkwell
    ├── acp.cjs            # Pre-bundled @thinkwell/acp
    ├── protocol.cjs       # Pre-bundled @thinkwell/protocol
    └── cli-loader.cjs     # Script loader with dependencies
```

### package.json Configuration

```json
{
  "name": "thinkwell",
  "bin": {
    "thinkwell": "./bin/thinkwell"
  },
  "engines": {
    "node": ">=24"
  },
  "files": [
    "bin",
    "dist",
    "dist-pkg"
  ]
}
```

### npx Experience

Users can immediately try thinkwell without installation:

```bash
# Initialize a new project
npx thinkwell init

# Get help
npx thinkwell --help

# Run a script (requires Node.js 24+)
npx thinkwell run hello.ts
```

## Binary Distribution

### Homebrew Formula

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

### Binary Characteristics

- **Self-contained** — No Node.js or other runtime dependencies
- **Size** — ~63 MB per platform (includes Node.js runtime)
- **TypeScript support** — Native via `--experimental-transform-types`
- **External packages** — User scripts can import from their own `node_modules`

## Runtime Requirements

| Installation Method | Runtime Required | Notes |
|---------------------|------------------|-------|
| **Homebrew / Binary** | None | Self-contained with embedded Node.js |
| **npm/pnpm/yarn** | Node.js 24+ | Lightweight package, requires Node.js 24 |

## Limitations

### Top-Level Await

User scripts cannot use top-level `await` because thinkwell uses Node.js's `require(esm)` feature:

```typescript
// ❌ Does NOT work
const data = await fetchData();

// ✅ Works
async function main() {
  const data = await fetchData();
}
main();
```

This affects approximately 0.02% of npm packages (6 out of top 5000).

### TypeScript Features

All standard TypeScript features are supported via `--experimental-transform-types`:

**Fully Supported:**
- Type annotations, interfaces, type aliases
- Generic functions and classes
- Type-only imports
- Enums (regular and const)
- Namespaces
- Parameter properties

**Not Supported:**
- JSX in `.ts` files (use `.tsx`)
- Legacy decorators

## CI/CD Integration

### Direct Binary Download (Recommended)

```yaml
# GitHub Actions
- name: Install thinkwell
  run: |
    curl -fsSL https://github.com/dherman/thinkwell/releases/latest/download/thinkwell-linux-x64.tar.gz | tar xz
    sudo mv thinkwell /usr/local/bin/

- name: Run agent
  run: thinkwell run src/agent.ts
```

### npm + Node.js 24

```yaml
# GitHub Actions
- name: Setup Node.js 24
  uses: actions/setup-node@v4
  with:
    node-version: '24'

- name: Install thinkwell
  run: npm install -g thinkwell

- name: Run agent
  run: thinkwell run src/agent.ts
```

## Historical Context

This architecture replaced an earlier Bun-based implementation. The migration was necessary because Bun's compiled binaries have a fundamental limitation: they cannot resolve npm packages from a user's `node_modules` directory at runtime. See [RFD: Migrate Binary Distribution from Bun to pkg](./pkg-migration.md) for the full analysis.

For historical reference, the original Bun-based architecture is documented in:
- [archive/cli-distribution-bun.md](./archive/cli-distribution-bun.md) — Original distribution strategy
- [archive/bun-schema-plugin.md](./archive/bun-schema-plugin.md) — Original Bun plugin design
- [archive/binary-module-resolution.md](./archive/binary-module-resolution.md) — Bun binary resolution challenges

## References

- [yao-pkg/pkg GitHub](https://github.com/yao-pkg/pkg)
- [Node.js Native TypeScript](https://nodejs.org/en/learn/typescript/run-natively)
- [RFD: Migrate Binary Distribution from Bun to pkg](./pkg-migration.md)
