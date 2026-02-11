# RFD: Explicit Configuration Experience

**Depends on:** [node-ux](node-ux.md), [check-command](check-command.md)

## Summary

This document proposes a design for how `thinkwell build` and `thinkwell check` resolve dependencies (`thinkwell` and `typescript`) when operating on Node.js projects with explicit `package.json` configuration. The key insight is that a `package.json` signals user intent to manage dependencies explicitly — at which point implicit bundled versions become surprising rather than helpful.

The design uses a hybrid dependency detection strategy: fast `package.json` inspection for the common case, with fallback to package manager CLI (`pnpm why`, `npm why`, `yarn why`) for workspace-hoisted dependencies.

## Problem Statement

The current implementation of `thinkwell build` and `thinkwell check` uses TypeScript bundled with the thinkwell distribution. This creates a mismatch between user expectations and actual behavior:

1. **Version mismatch** — A user with `"typescript": "^5.4.0"` in their `package.json` expects that version to be used, not whatever version is bundled with their thinkwell binary.

2. **Library version mismatch** — A user depending on `"thinkwell": "^0.5.0"` expects that version's types and runtime, not a potentially different version bundled in the CLI.

3. **Surprising behavior** — The zero-config experience (no `package.json`) should use bundled versions for convenience. But once a user has explicit configuration, implicit behavior violates the principle of least surprise.

### The Zero-Config vs Explicit-Config Spectrum

| Project State | Expected Behavior |
|---------------|-------------------|
| No `package.json` | Use bundled thinkwell + TypeScript (zero-config convenience) |
| `package.json` with explicit deps | Use project's declared versions |
| `package.json` without thinkwell/TS deps | **Ambiguous** — this RFD addresses this case |

The ambiguous middle case — a `package.json` exists but doesn't declare thinkwell or TypeScript dependencies — is the focus of this proposal.

## Design Goals

1. **Respect explicit configuration** — When a project declares a dependency, use that version.

2. **Fail fast with clear guidance** — When configuration is incomplete, fail with an actionable error message rather than silently using bundled versions.

3. **Package manager awareness** — Detect the project's package manager and provide context-appropriate remediation commands.

4. **Monorepo support** — Handle workspace-hoisted dependencies correctly (e.g., thinkwell declared at root, not in leaf package).

5. **Performance** — The common case (deps declared in `package.json`) should be fast; only fall back to slower CLI inspection when needed.

## Proposal

### Decision Tree

When `thinkwell build` or `thinkwell check` runs in a directory with a `package.json`:

```
┌─────────────────────────────────────────────────────────────────────────┐
│ 1. Check package.json for "thinkwell" in dependencies/devDependencies   │
│    └── Found? ──► Use project's thinkwell                               │
│    └── Not found? ──► Continue to step 2                                │
│                                                                         │
│ 2. Check via package manager: `<pm> why thinkwell --json`               │
│    └── Found (workspace-hoisted)? ──► Use resolved thinkwell            │
│    └── Not found? ──► Error: missing thinkwell dependency               │
│                                                                         │
│ 3. Repeat steps 1-2 for "typescript"                                    │
│                                                                         │
│ 4. If any dependency is missing, exit with error + remediation guidance │
└─────────────────────────────────────────────────────────────────────────┘
```

### Package Manager Detection

Detect the package manager by checking for lockfiles and configuration, in order:

| Check | Package Manager |
|-------|-----------------|
| `pnpm-lock.yaml` exists | pnpm |
| `yarn.lock` exists | yarn |
| `package-lock.json` exists | npm |
| `package.json` has `"packageManager"` field | Parse field (e.g., `"pnpm@9.0.0"`) |
| None of the above | Default to npm |

This order prioritizes lockfiles (concrete evidence of what's been used) over the `packageManager` field (which may be aspirational).

### Hybrid Dependency Detection

**Fast path:** Check `package.json` directly for the dependency in `dependencies` or `devDependencies`. This is a synchronous file read with no subprocess overhead.

**Slow path (fallback):** If not found in `package.json`, invoke the package manager's `why` command to check for workspace-hoisted or transitive dependencies:

| Package Manager | Command | Success Indicator |
|-----------------|---------|-------------------|
| pnpm | `pnpm why <pkg> --json` | Package appears in `dependencies` or `devDependencies` of result object |
| npm | `npm why <pkg> --json` | Result is an array (not an error object) |
| yarn | `yarn why <pkg> --json` | Exit code 0 and non-empty output |

The slow path handles monorepo scenarios where a dependency is declared at the workspace root but not in leaf packages.

### Error Messages

When a required dependency is missing, provide a clear error with package-manager-specific remediation:

**pnpm:**
```
Error: This project has a package.json but no dependency on 'thinkwell'.

When a project has explicit configuration, thinkwell expects explicit dependencies.
This ensures you get the versions you expect, not versions bundled with the CLI.

Run 'thinkwell init' to add the required dependencies, or add them manually:
  pnpm add thinkwell
  pnpm add -D typescript
```

**npm:**
```
Error: This project has a package.json but no dependency on 'thinkwell'.

When a project has explicit configuration, thinkwell expects explicit dependencies.
This ensures you get the versions you expect, not versions bundled with the CLI.

Run 'thinkwell init' to add the required dependencies, or add them manually:
  npm install thinkwell
  npm install -D typescript
```

**yarn:**
```
Error: This project has a package.json but no dependency on 'thinkwell'.

When a project has explicit configuration, thinkwell expects explicit dependencies.
This ensures you get the versions you expect, not versions bundled with the CLI.

Run 'thinkwell init' to add the required dependencies, or add them manually:
  yarn add thinkwell
  yarn add -D typescript
```

### The `thinkwell init` Command

A new `thinkwell init` command automates dependency setup:

```bash
thinkwell init
```

**Behavior:**

1. Detect the package manager (using the detection logic above)
2. Determine which dependencies are missing (thinkwell, typescript, or both)
3. Add missing dependencies using the detected package manager:
   - `thinkwell` as a regular dependency
   - `typescript` as a dev dependency
4. Use versions matching the current thinkwell CLI binary as defaults
5. If `tsconfig.json` doesn't exist, offer to create one with sensible defaults

**Interactive mode (default when TTY):**
```
$ thinkwell init

Detected package manager: pnpm

Missing dependencies:
  • thinkwell (will add ^0.5.0)
  • typescript (will add ^5.7.0 as devDependency)

Proceed? [Y/n] y

Running: pnpm add thinkwell@^0.5.0
Running: pnpm add -D typescript@^5.7.0

✓ Dependencies added successfully.
```

**Non-interactive mode (CI or `--yes` flag):**
```
$ thinkwell init --yes
Adding thinkwell@^0.5.0...
Adding typescript@^5.7.0 as devDependency...
✓ Dependencies added successfully.
```

### Why Option C?

We considered three approaches for handling missing dependencies:

| Option | Description | Trade-offs |
|--------|-------------|------------|
| A | Fail fast with error only | Unfriendly; user must figure out remediation |
| B | Silently add dependencies | Violates least surprise; side effects user didn't ask for |
| **C** | Fail fast + suggest `thinkwell init` | Respects user agency; easy remediation path |

Option C was chosen because:

1. **Principle of least surprise** — Modifying `package.json` without explicit consent is surprising
2. **Minimal friction** — A single command (`thinkwell init`) handles remediation
3. **User agency** — Users can choose to wire things up manually if they prefer
4. **CI-friendly** — Clear error messages make CI failures actionable

### Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Type errors found (for `thinkwell check`) |
| 2 | Configuration error (missing tsconfig.json, missing dependencies, etc.) |

Missing dependencies should exit with code 2 (configuration error), not code 1 (which is reserved for type errors).

## Architecture

### Module Structure

```
src/cli/
├── package-manager.ts    # Package manager detection and command generation
├── dependency-check.ts   # Hybrid dependency resolution logic
├── init.ts               # `thinkwell init` command implementation
├── check.ts              # Updated to use dependency-check
└── build.ts              # Updated to use dependency-check
```

### Package Manager Interface

```typescript
type PackageManager = "pnpm" | "npm" | "yarn";

interface PackageManagerInfo {
  name: PackageManager;
  lockfile: string | null;
  addCommand: (pkg: string, dev?: boolean) => string;
  whyCommand: (pkg: string) => string[];
}

function detectPackageManager(projectDir: string): PackageManagerInfo;
```

### Dependency Check Interface

```typescript
interface DependencyStatus {
  found: boolean;
  version?: string;
  source: "package.json" | "workspace" | "transitive";
}

interface DependencyCheckResult {
  thinkwell: DependencyStatus;
  typescript: DependencyStatus;
  packageManager: PackageManagerInfo;
}

async function checkDependencies(projectDir: string): Promise<DependencyCheckResult>;
```

## Trade-offs

### Advantages

| Aspect | Benefit |
|--------|---------|
| Predictable behavior | Users get the versions they declare |
| Clear error messages | Actionable guidance when configuration is incomplete |
| Package manager awareness | Remediation commands match user's toolchain |
| Monorepo support | Handles workspace-hoisted dependencies correctly |
| Performance | Fast path avoids subprocess overhead in common case |

### Disadvantages

| Aspect | Impact |
|--------|--------|
| Breaking change | Existing projects without explicit deps will see new errors |
| Subprocess overhead | Slow path requires spawning package manager CLI |
| Yarn complexity | Yarn classic vs Yarn Berry have different `why` output formats |

### Migration Path

For existing projects that relied on bundled versions:

1. Run `thinkwell build` or `thinkwell check`
2. See clear error message with remediation guidance
3. Run `thinkwell init` (or add dependencies manually)
4. Continue as before

This is a one-time migration cost that results in more predictable behavior going forward.

## Future Evolution

### Version Compatibility Warnings

Once we're using the project's declared TypeScript version, we can add compatibility checks:

```
Warning: This project uses TypeScript 5.2.0, but thinkwell 0.5.0 was tested with TypeScript ^5.4.0.
Some features may not work correctly. Consider upgrading TypeScript.
```

### `thinkwell doctor` Command

A diagnostic command that checks project health:

```bash
$ thinkwell doctor

✓ Package manager: pnpm 9.0.0
✓ thinkwell: 0.5.0 (from package.json)
✓ typescript: 5.7.0 (from package.json)
✓ tsconfig.json: found
✓ @JSONSchema types: working

All checks passed.
```

## References

- [RFD: Node-Native Developer Experience](./node-ux.md)
- [RFD: `thinkwell check` Command](./check-command.md)
- [pnpm why documentation](https://pnpm.io/cli/why)
- [npm why documentation](https://docs.npmjs.com/cli/commands/npm-explain)
- [yarn why documentation](https://yarnpkg.com/cli/why)
