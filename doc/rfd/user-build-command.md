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

## Open Questions

### Configuration File Support

Should `thinkwell build` support a configuration file (e.g., `thinkwell.build.json` or a `"thinkwell"` key in `package.json`)? This would allow users to specify default targets, assets, and other options without command-line flags.

**Proposed answer:** Defer to Phase 3. Start with CLI-only and add configuration file support based on user feedback.

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

## References

- [RFD: Migrate Binary Distribution from Bun to pkg](./pkg-migration.md)
- [RFD: CLI Distribution](./cli-distribution.md)
- [@yao-pkg/pkg GitHub](https://github.com/yao-pkg/pkg)
- [@yao-pkg/pkg npm](https://www.npmjs.com/package/@yao-pkg/pkg)
- [Deno compile documentation](https://docs.deno.com/runtime/reference/cli/compile/)
- [CLI Guidelines](https://clig.dev/)
