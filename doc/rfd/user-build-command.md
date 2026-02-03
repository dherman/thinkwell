# RFD: `thinkwell build` Command

## Summary

This document proposes a new `thinkwell build` command that allows users to compile their thinkwell modules into self-contained executables. The command will leverage the same pkg-based tooling that we use to build the `thinkwell` CLI itself, enabling users to distribute their agents as standalone binaries without requiring Node.js or thinkwell to be installed on target machines.

## Motivation

### Use Cases

1. **Distributing Agents** — Users building production agents want to ship a single binary to servers, containers, or end-user machines without requiring a Node.js runtime or npm install.

2. **CI/CD Simplification** — A self-contained binary eliminates dependency management in deployment pipelines.

3. **Air-Gapped Environments** — Enterprise users often need to run agents in environments without internet access or package registries.

4. **Version Pinning** — A compiled binary guarantees the exact versions of thinkwell and all dependencies, eliminating "works on my machine" issues.

### Design Goals

- **Simple defaults** — `thinkwell build src/agent.ts` should produce a working binary for the current platform
- **Cross-compilation** — Support building for multiple platforms from a single machine
- **Familiar UX** — Follow conventions from tools like `deno compile`, `cargo build`, and `go build`
- **Unified tooling** — Reuse the existing pkg infrastructure from thinkwell's own build process

## Proposal

### Basic Usage

```bash
# Build for current platform (auto-detected)
thinkwell build src/agent.ts

# Specify output path
thinkwell build src/agent.ts -o dist/my-agent

# Build for specific platform(s)
thinkwell build src/agent.ts --target linux-x64
thinkwell build src/agent.ts --target darwin-arm64 --target linux-x64
```

### Command-Line Interface

```
thinkwell build [options] <entry>

Arguments:
  entry                  TypeScript or JavaScript entry point

Options:
  -o, --output <path>    Output file path (default: ./<name>-<target>)
  -t, --target <target>  Target platform (can be specified multiple times)
  --include <glob>       Additional files to embed as assets
  --verbose              Show detailed build output
  -h, --help             Show help message

Targets:
  host                   Current platform (default)
  darwin-arm64           macOS on Apple Silicon
  darwin-x64             macOS on Intel
  linux-x64              Linux on x64
  linux-arm64            Linux on ARM64
```

### Output Naming Convention

When `--output` is not specified:
- Single target: `<entry-basename>-<target>` (e.g., `agent-darwin-arm64`)
- Multiple targets: `<entry-basename>-<target>` for each

When `--output` is specified:
- Single target: Uses the exact path
- Multiple targets: Uses `<output>-<target>` for each

### Example Workflows

**Basic development workflow:**
```bash
# Build and test locally
thinkwell build src/agent.ts
./agent-darwin-arm64

# Or with explicit output
thinkwell build src/agent.ts -o ./my-agent
./my-agent
```

**Multi-platform release:**
```bash
# Build for all supported platforms
thinkwell build src/agent.ts \
  --target darwin-arm64 \
  --target darwin-x64 \
  --target linux-x64 \
  --target linux-arm64 \
  -o dist/my-agent

# Results in:
#   dist/my-agent-darwin-arm64
#   dist/my-agent-darwin-x64
#   dist/my-agent-linux-x64
#   dist/my-agent-linux-arm64
```

**Including additional assets:**
```bash
# Embed config files and templates
thinkwell build src/agent.ts --include "config/**/*.json" --include "templates/*"
```

## Architecture

### Build Pipeline

The user-facing `thinkwell build` command will orchestrate the same two-stage pipeline used to build thinkwell itself:

```
┌─────────────────────────────────────────────────────────────────────┐
│ Stage 1: Pre-Bundle with esbuild                                    │
│ ─────────────────────────────────────────────────────────────────── │
│                                                                     │
│ User entry point ──────────────────────────────────────┐            │
│                                                         │            │
│ thinkwell packages (from CLI's dist-pkg/) ─────────────┼──► .cjs    │
│   • thinkwell.cjs                                       │   bundle   │
│   • acp.cjs                                             │            │
│   • protocol.cjs                                        │            │
│   • cli-loader.cjs                                     │            │
│                                                         │            │
│ User's node_modules ───────────────────────────────────┘            │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────────┐
│ Stage 2: Compile with pkg                                           │
│ ─────────────────────────────────────────────────────────────────── │
│                                                                     │
│ .cjs bundle ───────────────────────────────────────────────────────►│
│                                                                     │
│ Node.js 24 runtime ────────────────────────────────────────────────►│
│   • --experimental-transform-types enabled                          │
│   • --disable-warning=ExperimentalWarning                          │
│                                                                     │
│ Additional assets (--include) ─────────────────────────────────────►│
│                                                                     │
│                              ↓                                      │
│                    Self-contained binary                            │
│                    (~70-90 MB per platform)                         │
└─────────────────────────────────────────────────────────────────────┘
```

### Module Resolution Strategy

The compiled binary uses the same module resolution strategy as the thinkwell CLI:

1. **Bundled thinkwell packages** — Pre-bundled CJS files are embedded and registered in `global.__bundled__`
2. **User dependencies** — If the user's script imports packages not bundled, esbuild bundles them into the entry point
3. **Native modules** — `.node` files are embedded as assets and extracted at runtime

### Entry Point Generation

`thinkwell build` generates a wrapper entry point that:

1. Registers the bundled thinkwell packages in `global.__bundled__`
2. Sets up the custom require hook for `thinkwell:*` imports
3. Processes `@JSONSchema` annotations at startup
4. Invokes the user's entry point

```javascript
// Generated: .thinkwell-build/<entry>-wrapper.cjs
const thinkwell = require('./thinkwell.cjs');
const acp = require('./acp.cjs');
const protocol = require('./protocol.cjs');

global.__bundled__ = {
  'thinkwell': thinkwell,
  '@thinkwell/acp': acp,
  '@thinkwell/protocol': protocol,
};

// User's bundled code follows...
```

### Cross-Compilation Considerations

pkg has limitations when cross-compiling between architectures due to V8 bytecode differences. `thinkwell build` handles this automatically:

| Host Platform | Can Compile For | Notes |
|---------------|-----------------|-------|
| macOS arm64 | darwin-arm64, darwin-x64 | x64 via Rosetta 2 |
| macOS x64 | darwin-x64 | arm64 requires --no-bytecode |
| Linux x64 | linux-x64 | Other archs require --no-bytecode |
| Linux arm64 | linux-arm64 | Other archs require --no-bytecode |

When cross-compiling to an incompatible architecture, `thinkwell build` automatically adds `--no-bytecode --public` flags, which includes source code instead of bytecode. This enables cross-compilation but exposes source code in the binary.

## Trade-offs

### Advantages

| Aspect | Benefit |
|--------|---------|
| Consistent tooling | Same pkg infrastructure used for thinkwell CLI |
| Cross-platform | Build for multiple platforms from one machine |
| Self-contained | No runtime dependencies on target machines |
| TypeScript support | Native TS via Node 24's transform-types |

### Disadvantages

| Aspect | Impact |
|--------|--------|
| Binary size | ~70-90 MB per platform (includes Node.js runtime) |
| Build time | Bundling + pkg compilation takes several seconds |
| No TLA | Top-level await not supported in user scripts |
| Source exposure | Cross-compilation requires --public flag |

### Binary Size Considerations

The large binary size (~70-90 MB) is inherent to pkg's approach of embedding the Node.js runtime. For users who need smaller binaries, alternatives include:

1. **Compression** — pkg supports `--compress Brotli` which can reduce size by 60-70%
2. **External runtime** — Ship a separate Node.js installation and use npm distribution
3. **Container images** — Use a minimal Node.js base image with npm-installed thinkwell

## Alternatives Considered

### Alternative 1: Expose Build Scripts Directly

**Description:** Document and support running the existing `bundle-for-pkg.ts` and `build-binary-pkg.ts` scripts directly.

**Pros:** No new code to maintain; power users get full control
**Cons:** Poor UX; users must understand the two-stage pipeline; not discoverable

### Alternative 2: Wrapper Shell Scripts

**Description:** Provide shell scripts that orchestrate the build process.

**Pros:** Simple implementation; easy to customize
**Cons:** Platform-specific scripts; harder to maintain; poor error handling

### Alternative 3: Separate `@thinkwell/build` Package

**Description:** Create a dedicated package for the build tooling.

**Pros:** Separation of concerns; optional dependency
**Cons:** More packages to maintain; fragmented user experience; version coordination challenges

## Advanced Features (Phase 4)

### External Package Exclusion (`--external`)

Users can exclude specific packages from bundling with `--external` (or `-e`). This is useful for:

1. **Native modules** — Packages like `sqlite3`, `pg`, or `better-sqlite3` that include platform-specific `.node` binaries
2. **Optional dependencies** — Packages that should only be loaded if available at runtime
3. **Large dependencies** — Reducing bundle size by keeping rarely-used dependencies external

```bash
thinkwell build src/agent.ts --external sqlite3 --external pg
```

External packages remain as `require()` calls in the bundled output. Users must ensure these packages are available in the runtime environment.

### Minification (`--minify`)

The `--minify` flag enables esbuild minification for smaller bundle output:

```bash
thinkwell build src/agent.ts --minify
```

While the Node.js runtime dominates binary size (~70-90 MB), minification can still reduce the user code portion significantly for large applications.

### Watch Mode (`--watch`)

The `--watch` flag enables automatic rebuilding on file changes:

```bash
thinkwell build src/agent.ts --watch
```

Watch mode features:
- Debounced rebuilds (100ms) to batch rapid changes
- Build queueing when changes occur during a build
- Recursive directory watching of the entry file's directory
- Filtering of non-source files (node_modules, .d.ts, dotfiles)
- Graceful shutdown on Ctrl+C

### Configuration via package.json

Build defaults can be specified in `package.json` under the `"thinkwell.build"` key:

```json
{
  "thinkwell": {
    "build": {
      "output": "dist/my-agent",
      "targets": ["darwin-arm64", "linux-x64"],
      "include": ["assets/**/*"],
      "external": ["sqlite3"],
      "minify": true
    }
  }
}
```

Configuration is loaded from both the entry file's directory and the current working directory. CLI options override package.json settings.

## Open Questions

### Native Module Handling

How should `thinkwell build` handle native modules (`.node` files) that require platform-specific compilation?

**Proposed answer:** Document that users must pre-compile native modules for each target platform. pkg extracts `.node` files to a cache directory at runtime, so they must match the target architecture.

## Embedding esbuild in the Compiled Binary

The `thinkwell build` command uses esbuild for the bundling stage. When the thinkwell CLI itself is compiled into a pkg binary, esbuild must also be available at runtime. This section documents the research, experimentation, and chosen approach for embedding esbuild.

### The Problem

esbuild uses platform-specific native executables distributed as optional dependencies:
- `@esbuild/darwin-arm64` (macOS Apple Silicon)
- `@esbuild/darwin-x64` (macOS Intel)
- `@esbuild/linux-x64` (Linux x64)
- `@esbuild/linux-arm64` (Linux ARM64)

When the thinkwell CLI is compiled with pkg, importing esbuild fails with:
```
Cannot find package 'esbuild' imported from /snapshot/thinkwell/dist/cli/build.js
```

This occurs because:
1. pkg's virtual filesystem (`/snapshot/`) cannot execute native binaries directly
2. esbuild spawns its platform-specific binary as a child process
3. The `spawn()` syscall fails for paths inside the pkg snapshot

### Research Findings

**pkg Native Addon Support:**
- pkg can bundle `.node` files (Node.js native addons) and extracts them to `~/.cache/pkg/` at runtime
- However, esbuild doesn't use `.node` files—it uses standalone native executables
- These executables cannot be spawned directly from the pkg snapshot

**esbuild Architecture:**
- esbuild checks for a `ESBUILD_BINARY_PATH` environment variable
- If set, esbuild uses the binary at that path instead of auto-detecting
- This provides a hook for custom binary locations

### Alternatives Considered

#### Alternative A: Disable Build Command in Compiled Binary

**Description:** Detect when running from a compiled binary and show an error directing users to use `npx thinkwell build` instead.

**Pros:**
- Simplest implementation
- No binary size increase
- No runtime extraction complexity

**Cons:**
- Poor user experience—the compiled binary advertises a command it can't run
- Confusing that some commands work and others don't
- Defeats the goal of a self-contained CLI

#### Alternative B: Use esbuild-wasm

**Description:** Use the WebAssembly version of esbuild (`esbuild-wasm`) which has no native dependencies.

**Pros:**
- Pure JavaScript/WASM, no native code issues
- Would work in any environment

**Cons:**
- **10x slower** than native esbuild (order of magnitude performance regression)
- Async-only API (no synchronous operations)
- Still requires bundling the ~8MB WASM binary
- Poor fit for CLI tools where responsiveness matters

**Conclusion:** Not recommended due to unacceptable performance impact.

#### Alternative C: Runtime Binary Extraction (Chosen Approach)

**Description:** Include the platform-specific esbuild binary as a pkg asset, extract it to a cache directory at runtime, and set `ESBUILD_BINARY_PATH`.

**Pros:**
- Full native esbuild performance
- One-time extraction overhead (subsequent runs use cached binary)
- Self-contained CLI with working build command

**Cons:**
- ~10MB increase in binary size per platform
- First-run extraction adds ~100ms overhead
- Requires write access to cache directory

### Chosen Approach: Runtime Binary Extraction

The implementation extracts the esbuild binary on first use:

```javascript
// Pseudocode for the extraction approach
if (isRunningFromCompiledBinary()) {
  const cacheDir = join(homedir(), '.cache', 'thinkwell', 'esbuild');
  const esbuildDest = join(cacheDir, 'esbuild');

  if (!existsSync(esbuildDest)) {
    // Extract from pkg snapshot to real filesystem
    const src = join(__dirname, 'node_modules/@esbuild/darwin-arm64/bin/esbuild');
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(esbuildDest, readFileSync(src));
    chmodSync(esbuildDest, 0o755);
  }

  process.env.ESBUILD_BINARY_PATH = esbuildDest;
}

// Now esbuild can be loaded and will use the extracted binary
const { build } = await import('esbuild');
```

**Build Configuration:**

The pkg build must include esbuild's platform-specific binary as an asset:

```json
{
  "pkg": {
    "assets": [
      "node_modules/@esbuild/darwin-arm64/**/*",
      "node_modules/@esbuild/darwin-x64/**/*",
      "node_modules/@esbuild/linux-x64/**/*",
      "node_modules/@esbuild/linux-arm64/**/*"
    ]
  }
}
```

Note: Each platform's binary is only included in the build for that platform. Cross-compilation requires building separate binaries for each target.

**Cache Location:**

The extracted esbuild binary is stored at:
- macOS/Linux: `~/.cache/thinkwell/esbuild/esbuild`

This follows XDG Base Directory conventions and can be overridden via `THINKWELL_CACHE_DIR` environment variable if needed.

### Experimental Validation

This approach was validated with a prototype in `experiments/pkg-esbuild-test/`. The test confirmed:

1. ✅ esbuild binary can be read from pkg snapshot via `readFileSync()`
2. ✅ Binary can be written to real filesystem and made executable
3. ✅ `ESBUILD_BINARY_PATH` is respected by esbuild
4. ✅ Subsequent bundling operations work correctly
5. ✅ Binary size increase is ~10MB (78MB total vs ~68MB without)

### Impact on Binary Size

| Component | Size |
|-----------|------|
| Base thinkwell binary | ~68 MB |
| esbuild darwin-arm64 | +9.3 MB |
| **Total** | **~78 MB** |

This is acceptable given that the alternative (esbuild-wasm) would add ~8MB anyway while being 10x slower.

### Windows Support

Should we support `--target win-x64`?

**Proposed answer:** Defer Windows support. pkg supports Windows, but thinkwell's Node 24 + TypeScript workflow hasn't been tested there. Add Windows support when there's demonstrated user demand.

## Open Issue: pkg Compilation from Compiled Binary

The esbuild embedding strategy (described above) successfully enables the **bundling stage** to work from a compiled thinkwell binary. However, the **pkg compilation stage** cannot run from within a compiled binary.

### Problem Statement

When `thinkwell build` runs from a pkg-compiled binary, the bundling stage works correctly:
1. ✅ esbuild binary is extracted from `/snapshot/.../dist-pkg/esbuild-bin/<platform>/esbuild` to `~/.cache/thinkwell/esbuild/<version>/`
2. ✅ `ESBUILD_BINARY_PATH` is set before esbuild loads
3. ✅ User script is bundled successfully

But the pkg compilation stage fails with:
```
Error: A dynamic import callback was not specified.
```

### Root Cause Analysis

The `@yao-pkg/pkg` library uses dynamic imports internally (`await import(...)`) which don't work inside pkg's virtual filesystem (`/snapshot/`). When Node.js running inside a pkg binary encounters a dynamic import, it fails because:

1. pkg's module resolution hooks don't support dynamic imports
2. pkg pre-compiles modules to bytecode at build time; dynamic imports bypass this
3. The error "A dynamic import callback was not specified" is Node.js's way of saying the import couldn't be resolved

This is fundamentally different from the esbuild problem, which was solved by extracting a native binary. pkg is a JavaScript library that uses Node.js module loading features that are incompatible with pkg's runtime environment.

### Attempted Solutions

1. **Marking pkg as external** - Doesn't help because pkg still needs to be loaded at runtime
2. **Bundling pkg into cli-build.cjs** - Fails because pkg's internal dynamic imports still execute
3. **Pre-loading pkg before compilation** - The dynamic imports happen during `exec()`, not at load time

### Potential Approaches to Explore

1. **Shell out to system pkg CLI** - Instead of using `@yao-pkg/pkg` programmatically, detect when running from a compiled binary and shell out to `npx pkg` or a globally installed `pkg`. This requires pkg to be available on the user's system.

2. **Embed a pre-built pkg binary** - pkg itself could potentially be compiled into a standalone binary and embedded as an asset, similar to how we embed esbuild. However, pkg is significantly more complex and may have additional runtime dependencies.

3. **Use pkg's internal APIs differently** - Investigate whether there's a way to call pkg's compilation logic without triggering dynamic imports. This would require deep diving into pkg's source code.

4. **Alternative compilation tools** - Explore whether other Node.js-to-binary tools (like `nexe` or `boxednode`) could be used instead of pkg for the user's script compilation. These might have different runtime characteristics.

5. **Two-phase build** - Accept the limitation and provide a workflow where the compiled thinkwell binary produces an intermediate bundle, which the user then compiles using a separate `npx pkg` command.

### Current Workaround

The current implementation detects when running from a compiled binary and shows a helpful error message directing users to use `npx thinkwell build` instead. This provides a clear path forward while the limitation exists.

### Impact Assessment

This limitation affects users who:
- Install thinkwell via a pre-compiled binary (e.g., from GitHub releases)
- Want to use the `build` command to create their own standalone executables

Users who install via npm (`npm install -g thinkwell` or `npx thinkwell`) are unaffected.

## Chosen Solution: Download Portable Node.js + Bundled pkg CLI

After researching multiple approaches, the chosen solution downloads a portable Node.js runtime and uses a pre-bundled pkg CLI to execute the compilation stage as a subprocess. This enables fully self-contained `thinkwell build` from compiled binaries without requiring npm, npx, or any external dependencies.

### Design Overview

When `thinkwell build` runs from a compiled binary:

1. **Stage 1 (Bundling)**: Works as-is using the embedded esbuild binary
2. **Stage 2 (Compilation)**: Instead of calling `@yao-pkg/pkg` programmatically:
   - Download portable Node.js to `~/.cache/thinkwell/node/v<version>/`
   - Extract pre-bundled `pkg-cli.cjs` from the compiled binary's assets
   - Execute: `<cached-node> <pkg-cli.cjs> <wrapper.cjs> --targets <target> -o <output>`

```
┌─────────────────────────────────────────────────────────────────────┐
│ Compiled thinkwell binary                                           │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  thinkwell build src/agent.ts                                       │
│         │                                                           │
│         ▼                                                           │
│  ┌─────────────────────────────────────┐                           │
│  │ Stage 1: esbuild bundling           │ ✅ Works (embedded binary) │
│  │ (extracts esbuild from assets)      │                           │
│  └─────────────────────────────────────┘                           │
│         │                                                           │
│         ▼                                                           │
│  ┌─────────────────────────────────────┐                           │
│  │ Stage 2: pkg compilation            │                           │
│  │                                     │                           │
│  │  if (!cachedNodeExists) {           │                           │
│  │    download Node.js → ~/.cache/     │ ⬇️ ~50-70 MB (first run)  │
│  │  }                                  │                           │
│  │                                     │                           │
│  │  extract pkg-cli.cjs from assets    │                           │
│  │                                     │                           │
│  │  spawn(cachedNode, [pkg-cli.cjs,    │                           │
│  │        wrapper.cjs, --targets, ...])│                           │
│  └─────────────────────────────────────┘                           │
│         │                                                           │
│         ▼                                                           │
│    Standalone executable                                            │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### Why This Approach

| Requirement | How It's Met |
|-------------|--------------|
| No external dependencies | Node.js downloaded automatically; pkg CLI bundled as asset |
| No npm/npx required | Direct execution with downloaded Node.js binary |
| Minimal binary size increase | Only ~1-2 MB for bundled pkg CLI (Node.js is cached, not embedded) |
| Acceptable first-run UX | Progress indicator during download; subsequent runs use cache |
| Offline after first run | Cached Node.js persists across invocations |

### Alternatives Considered and Rejected

#### Alternative A: Embed Node.js in the Binary

**Description**: Bundle a portable Node.js binary inside the thinkwell executable itself (like we do with esbuild).

**Why rejected**: Would add ~50-70 MB per platform to binary size, nearly doubling it from ~78 MB to ~130-150 MB. The download-on-first-use approach provides the same functionality with minimal size impact.

#### Alternative B: Use Node.js SEA (Single Executable Applications)

**Description**: Replace pkg with Node.js's built-in SEA feature for the compilation stage.

**Why rejected**: SEA has the same fundamental limitation—it requires access to the Node.js CLI (`node --build-sea`). Additionally, SEA is less capable than pkg (CommonJS only, no VFS, limited asset support). It doesn't solve the "compilation from compiled binary" problem.

#### Alternative C: Shell Out to System npx/pkg

**Description**: Detect compiled binary and fall back to `npx pkg` or globally installed `pkg`.

**Why rejected**: Violates the constraint that users shouldn't need any additional software installed. Users who download the binary distribution expect it to be fully self-contained.

#### Alternative D: Two-Phase Build Workflow

**Description**: Accept the limitation; compiled binary produces intermediate bundle, user runs `npx pkg` separately.

**Why rejected**: Poor user experience requiring two commands and external tooling. Acceptable as a temporary workaround but not as a permanent solution.

### Node.js Download Strategy

**Source**: Official Node.js distribution from nodejs.org

**URL Pattern**:
```
https://nodejs.org/dist/v{VERSION}/node-v{VERSION}-{PLATFORM}-{ARCH}.tar.gz
```

Examples:
- `https://nodejs.org/dist/v24.11.1/node-v24.11.1-darwin-arm64.tar.gz`
- `https://nodejs.org/dist/v24.11.1/node-v24.11.1-linux-x64.tar.gz`

**Platform/Architecture Mapping**:

| `process.platform` | `process.arch` | Node.js format |
|--------------------|----------------|----------------|
| `darwin` | `arm64` | `darwin-arm64` |
| `darwin` | `x64` | `darwin-x64` |
| `linux` | `x64` | `linux-x64` |
| `linux` | `arm64` | `linux-arm64` |

**Download sizes** (compressed .tar.gz):
- darwin-arm64: ~45-50 MB
- darwin-x64: ~50-55 MB
- linux-x64: ~50-55 MB
- linux-arm64: ~45-50 MB

**Integrity Verification**:
Node.js provides SHA-256 checksums at `https://nodejs.org/dist/v{VERSION}/SHASUMS256.txt`. The implementation must verify the downloaded archive against this checksum to prevent tampering.

### Cache Structure

```
~/.cache/thinkwell/
├── esbuild/
│   └── <thinkwell-version>/
│       └── esbuild                    # Extracted esbuild binary (existing)
├── node/
│   └── v<node-version>/
│       ├── node                       # Extracted Node.js binary
│       └── .checksum                  # SHA-256 of downloaded archive
└── pkg-cli/
    └── <thinkwell-version>/
        └── pkg-cli.cjs                # Extracted bundled pkg CLI
```

**Cache Invalidation**:
- Node.js cache: Keyed by Node.js version (e.g., `v24.11.1`). New thinkwell versions can update the pinned Node.js version.
- pkg CLI cache: Keyed by thinkwell version. Re-extracted when thinkwell is updated.
- esbuild cache: Already keyed by thinkwell version (existing implementation).

**Environment Variable Override**:
`THINKWELL_CACHE_DIR` overrides `~/.cache/thinkwell/` for custom cache locations (useful for CI or restricted environments).

### Bundling pkg CLI

The `@yao-pkg/pkg` package must be bundled into a single CJS file at thinkwell build time:

**Build script** (`scripts/bundle-pkg-cli.ts`):
```typescript
import { build } from 'esbuild';

await build({
  entryPoints: ['node_modules/@yao-pkg/pkg/lib-es5/bin.js'],
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  outfile: 'dist-pkg/pkg-cli.cjs',
  external: [], // Bundle all dependencies
  banner: {
    js: '#!/usr/bin/env node'
  }
});
```

**pkg Asset Configuration**:
```json
{
  "pkg": {
    "assets": [
      "dist-pkg/esbuild-bin/**/*",
      "dist-pkg/pkg-cli.cjs"
    ]
  }
}
```

**Expected bundle size**: ~1-2 MB (pkg + @babel/generator + @babel/parser + other deps)

### pkg-fetch Behavior

When pkg runs, it uses `@yao-pkg/pkg-fetch` internally to download pre-patched Node.js binaries for embedding in the output executable. This is **separate** from the portable Node.js we download to run pkg itself.

**pkg-fetch cache location**: `~/.pkg-cache/` (or `PKG_CACHE_PATH` env var)

**Important**: The pkg-fetch download happens during compilation, not during the download of portable Node.js. Users will see two potential download steps on first run:
1. Portable Node.js (~50 MB) - to run pkg
2. pkg-fetch Node.js (~50 MB) - to embed in the output binary

Both are cached for subsequent runs. The UX should make this clear with appropriate progress messages.

### Implementation Pseudocode

```typescript
async function compileWithPkg(
  ctx: BuildContext,
  wrapperPath: string,
  target: Target,
  outputPath: string
): Promise<void> {
  if (isRunningFromCompiledBinary()) {
    // Use subprocess approach with downloaded Node.js
    const nodePath = await ensurePortableNode(ctx);
    const pkgCliPath = await ensurePkgCli(ctx);

    const args = [
      pkgCliPath,
      wrapperPath,
      '--targets', pkgTargetString(target),
      '--output', outputPath,
      '--config', pkgConfigPath,
    ];

    ctx.spinner?.update('Compiling standalone executable...');

    const result = await spawnAsync(nodePath, args, {
      cwd: ctx.workDir,
      env: {
        ...process.env,
        // Ensure pkg-fetch can write to cache
        PKG_CACHE_PATH: join(ctx.cacheDir, 'pkg-cache'),
      },
    });

    if (result.exitCode !== 0) {
      throw new Error(`pkg compilation failed: ${result.stderr}`);
    }

    return;
  }

  // Normal path: use pkg programmatically (existing implementation)
  const { exec } = await import('@yao-pkg/pkg');
  await exec([...]);
}

async function ensurePortableNode(ctx: BuildContext): Promise<string> {
  const version = '24.11.1'; // Pinned Node.js version
  const cacheDir = join(ctx.cacheDir, 'node', `v${version}`);
  const nodePath = join(cacheDir, process.platform === 'win32' ? 'node.exe' : 'node');

  if (existsSync(nodePath)) {
    return nodePath;
  }

  ctx.spinner?.start('Downloading Node.js runtime (first time only)...');

  const platform = process.platform === 'darwin' ? 'darwin' : 'linux';
  const arch = process.arch;
  const filename = `node-v${version}-${platform}-${arch}.tar.gz`;
  const url = `https://nodejs.org/dist/v${version}/${filename}`;

  // Download with progress
  const archivePath = join(cacheDir, filename);
  await mkdirp(cacheDir);
  await downloadWithProgress(url, archivePath, ctx.spinner);

  // Verify checksum
  const checksumUrl = `https://nodejs.org/dist/v${version}/SHASUMS256.txt`;
  const expectedHash = await fetchExpectedChecksum(checksumUrl, filename);
  const actualHash = await hashFile(archivePath);

  if (actualHash !== expectedHash) {
    await rm(archivePath);
    throw new Error(
      `Node.js download verification failed.\n` +
      `Expected: ${expectedHash}\n` +
      `Actual: ${actualHash}`
    );
  }

  // Extract
  ctx.spinner?.update('Extracting Node.js...');
  await extractTarGz(archivePath, cacheDir);

  // The tarball extracts to node-v{version}-{platform}-{arch}/bin/node
  const extractedBin = join(cacheDir, `node-v${version}-${platform}-${arch}`, 'bin', 'node');
  await rename(extractedBin, nodePath);

  // Cleanup extracted directory (keep only the node binary)
  await rm(join(cacheDir, `node-v${version}-${platform}-${arch}`), { recursive: true });
  await rm(archivePath);

  // Make executable
  await chmod(nodePath, 0o755);

  ctx.spinner?.succeed(`Node.js v${version} cached`);
  return nodePath;
}

async function ensurePkgCli(ctx: BuildContext): Promise<string> {
  const version = ctx.thinkwellVersion;
  const cacheDir = join(ctx.cacheDir, 'pkg-cli', version);
  const pkgCliPath = join(cacheDir, 'pkg-cli.cjs');

  if (existsSync(pkgCliPath)) {
    return pkgCliPath;
  }

  // Extract from pkg snapshot assets
  const snapshotPath = join(__dirname, '..', 'dist-pkg', 'pkg-cli.cjs');
  await mkdirp(cacheDir);
  await copyFile(snapshotPath, pkgCliPath);

  return pkgCliPath;
}
```

### User Experience

**First run from compiled binary**:
```
$ thinkwell build src/agent.ts
✓ Bundling with esbuild...
⠋ Downloading Node.js runtime (first time only)...
  ↳ node-v24.11.1-darwin-arm64.tar.gz [████████░░░░░░░░] 45.2 MB / 48.1 MB
✓ Node.js v24.11.1 cached to ~/.cache/thinkwell/node/
⠋ Compiling standalone executable...
  ↳ Downloading node binary for darwin-arm64... (pkg-fetch, also first time)
✓ Created: agent-darwin-arm64
```

**Subsequent runs**:
```
$ thinkwell build src/agent.ts
✓ Bundling with esbuild...
✓ Compiling standalone executable...
✓ Created: agent-darwin-arm64
```

### Error Handling

**Network failures**:
```
Error: Failed to download Node.js runtime.

  URL: https://nodejs.org/dist/v24.11.1/node-v24.11.1-darwin-arm64.tar.gz
  Error: ETIMEDOUT

Retry with: thinkwell build src/agent.ts
Or use: THINKWELL_CACHE_DIR=/path/to/cache with pre-populated Node.js
```

**Checksum mismatch**:
```
Error: Node.js download verification failed.

  Expected: a1b2c3d4...
  Actual:   e5f6g7h8...

This may indicate a corrupted download or network interference.
Please retry or report this issue.
```

**Disk space**:
```
Error: Insufficient disk space to cache Node.js runtime.

  Required: ~200 MB
  Available: 50 MB
  Location: ~/.cache/thinkwell/node/

Free up space or set THINKWELL_CACHE_DIR to a location with more space.
```

### Security Considerations

1. **HTTPS only**: All downloads use HTTPS to prevent MITM attacks
2. **Checksum verification**: SHA-256 verification against nodejs.org checksums
3. **No code execution before verification**: Downloaded archives are verified before extraction
4. **Proxy support**: Respects `HTTPS_PROXY`/`HTTP_PROXY` environment variables for corporate environments

### Testing Strategy

1. **Unit tests**: Mock download/extraction functions; verify cache logic
2. **Integration tests**: Build a test script using mocked Node.js download
3. **E2E tests**: Full build from compiled binary with real downloads (CI only, behind flag)
4. **Cache invalidation tests**: Verify version-keyed caching works correctly

## Deferred

The following features are considered valuable but deferred for future implementation:

- **Disk space detection** — Check available disk space before downloading Node.js (~50-70 MB) and provide a helpful error message if insufficient. Currently, users will see a less informative error if the download fails due to disk space.

## References

- [RFD: Migrate Binary Distribution from Bun to pkg](./pkg-migration.md)
- [RFD: CLI Distribution](./cli-distribution.md)
- [@yao-pkg/pkg GitHub](https://github.com/yao-pkg/pkg)
- [@yao-pkg/pkg npm](https://www.npmjs.com/package/@yao-pkg/pkg)
- [Deno compile documentation](https://docs.deno.com/runtime/reference/cli/compile/)
- [CLI Guidelines](https://clig.dev/)
