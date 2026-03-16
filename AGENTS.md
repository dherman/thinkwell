This repository contains the TypeScript implementation of the Thinkwell library and the Agent Client Protocol (ACP) extensions.

## Runtime and Build Tooling

**This project uses Node.js 24+ and pkg for binary distribution.**

**Current toolchain:**
- **Runtime:** Node.js 24+ with `--experimental-transform-types` for native TypeScript
- **Package manager:** pnpm
- **Binary packaging:** [@yao-pkg/pkg](https://github.com/yao-pkg/pkg) (not the archived vercel/pkg)
- **Bundling:** esbuild for pre-bundling ESM to CJS before pkg compilation

**Historical note:** We previously attempted to use Bun for compiled binaries but encountered fundamental limitations with module resolution. See [doc/rfd/pkg-migration.md](doc/rfd/pkg-migration.md) for the full analysis.

## Conventional Commits

This repository uses **Conventional Commits** for clarity and, in the future, to support release automation. All commit messages should follow this format:

```
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
```

### Commit Types

- **feat:** A new feature (triggers minor version bump)
- **fix:** A bug fix (triggers patch version bump)
- **docs:** Documentation only changes
- **style:** Code style changes (formatting, missing semicolons, etc.)
- **refactor:** Code changes that neither fix bugs nor add features
- **perf:** Performance improvements
- **test:** Adding or updating tests
- **chore:** Maintenance tasks, dependency updates, etc.
- **ci:** CI/CD configuration changes
- **build:** Build system or external dependency changes

### Breaking Changes

Add `!` after the type to indicate breaking changes (triggers major version bump):
```
feat!: change API to use async traits
```

Or include `BREAKING CHANGE:` in the footer:
```
feat: redesign conductor protocol

BREAKING CHANGE: conductor now requires explicit capability registration
```

### Examples

```
feat(conductor): add support for dynamic proxy chains
fix(acp): resolve deadlock in message routing
docs: update README with installation instructions
chore: bump @agentclientprotocol/sdk to 0.12.0
```

### Scope Guidelines

Common scopes for this repository:
- `acp` - Core protocol changes
- `thinkwell` - High-level API changes
- `conductor` - Conductor-specific changes
- `deps` - Dependency updates

**Agents should help ensure commit messages follow this format.**

## Implementation Plans

Implementation plans are stored in doc/plan.md and are scoped to an individual pull request (by deleting from git before merge). This file should contain markdown checklists for tasks, and should contain high-level task descriptions, usually one line long. To avoid wasting time keeping the plan document in sync with the implementation, the plan should contain no code blocks of implementation details (high level signatures or usage examples are fine).

When implementing a plan, remember to check off the tasks in the plan document as you work.

## Build-Time Feature Flags

This project has a compile-time feature flag system. Features are defined in `features.json` at the monorepo root with boolean values indicating their release-mode state.

**Two build modes:**
- `pnpm build` (release) — flags use their `features.json` values; disabled features are stripped from output
- `pnpm build:debug` — all flags forced to `true`; nothing is stripped

**How flags work in code:**
- Each package gets an auto-generated `src/generated/features.ts` (gitignored) exporting a `features` object
- Import with `import { features } from "./generated/features.js"`
- Use `if (features.FLAG_NAME) { ... }` for conditional behavior — esbuild eliminates dead branches in release builds
- Use `/** @feature(FLAG_NAME) */` JSDoc annotations on declarations/methods to strip them entirely from release output (both `.js` and `.d.ts`)

**Adding a new flag:** Add it to `features.json`, then use it in code. The generation script propagates it to all packages.

**Never edit `src/generated/features.ts` directly** — it is overwritten on every build.
