# RFD: Build-Time Feature Flags

## Summary

Add a build-time feature flagging system so experimental features can ship in pre-releases with full API surface and be stripped from official releases. The system uses JSDoc-style annotations to mark feature-gated exports and methods, a JSON config file to control which features are enabled, and a post-`tsc` pipeline using ts-morph and esbuild to strip disabled features from build output.

## Background

As thinkwell's API grows, we need the ability to iterate on experimental features (in pre-releases, dogfooding, internal testing) without committing them to the stable public API. Today there is no mechanism to selectively include or exclude API surface at build time — everything that compiles is exported.

### Requirements

1. **Annotation-based API gating**: mark module exports and public methods as belonging to a named feature
2. **Config-driven release builds**: a single config file controls which features ship in the next release
3. **Debug builds**: all features enabled, for development and pre-releases
4. **Runtime feature checks**: internal code can conditionally execute feature-specific logic
5. **CI coverage**: tests run in both modes to catch breakage early

## Proposal

### Feature Config

A `features.json` file at the monorepo root serves as the single source of truth:

```json
{
  "features": {
    "skills": true,
    "someExperimentalApi": false
  }
}
```

Boolean flags. The outer `features` key leaves room for future metadata without a breaking format change.

### Annotations

The `/** @feature(name) */` JSDoc-style comment marks the immediately following declaration as feature-gated. TypeScript preserves `/** */` comments in both `.js` and `.d.ts` output, so one stripping pass handles both.

Supported positions — any declaration immediately following the annotation:

```typescript
// Re-exports (controlling barrel file API surface)
/** @feature(skills) */
export { parseSkillMd, validateSkillName } from "./skill.js";

/** @feature(skills) */
export type { Skill, VirtualSkill, StoredSkill, SkillTool } from "./skill.js";

// Export declarations (functions, classes, variables)
/** @feature(logging) */
export function log(s: string) { ... }

/** @feature(experimental) */
export class ExperimentalClient { ... }

/** @feature(experimental) */
export const EXPERIMENTAL_DEFAULT = 42;

// Class method declarations
class McpServerBuilder {
  /** @feature(skills) */
  addSkill(skill: Skill): void {
    // ...
  }
}
```

### Stripping: Post-tsc Pipeline

After `tsc` compiles to `dist/`, a stripping script processes the output in two passes:

#### Pass 1: Declaration stripping (ts-morph)

[ts-morph](https://ts-morph.com/) wraps the TypeScript compiler API with a high-level interface for AST manipulation. The stripping script loads `dist/` files (both `.js` and `.d.ts`), finds nodes preceded by `/** @feature(name) */` comments, and removes them with AST-level operations like `exportDeclaration.remove()` and `method.remove()`.

This handles:
- Export declarations and re-exports in barrel files
- Export function/class/variable declarations
- Class method declarations
- The corresponding signatures in `.d.ts` files

Using ts-morph gives us proper AST operations instead of fragile text-based parsing. It is one of the few tools that can process `.d.ts` files — most bundler tools (esbuild, SWC, Rollup) cannot.

#### Pass 2: Dead branch elimination (esbuild)

esbuild's `transform` API processes individual files (no bundling) with `define` and `minifySyntax`:

```typescript
import { transform } from "esbuild";

const result = await transform(source, {
  define: { "features.someExperimentalApi": "false" },
  minifySyntax: true,  // enables dead branch elimination
  // minifySyntax without minifyWhitespace/minifyIdentifiers
  // preserves readable formatting
});
```

This replaces `features.x` references with literal booleans and eliminates dead branches:

```typescript
// Before:
if (features.someExperimentalApi) {
  this.registerExperimentalHandlers();
}

// After (feature disabled):
// (entire block removed)
```

Note: esbuild cannot process `.d.ts` files, but dead branch elimination is only relevant for runtime code (`.js`), so this is not a limitation.

#### Why this combination?

Several approaches were evaluated:

| Approach | Export/method stripping | Dead branches | `.d.ts` support |
|----------|----------------------|---------------|-----------------|
| **Custom text parser** | Fragile (brace-balancing) | No | Yes (same parser) |
| **ts-patch transformer** | Yes (AST) | Yes | Yes (`afterDeclarations`) |
| **esbuild only** | No (no AST access) | Yes (`define` + `minifySyntax`) | No |
| **ts-morph + esbuild** | Yes (AST) | Yes (`define` + `minifySyntax`) | Yes (ts-morph) |

- **Custom text parser**: works but requires maintaining a hand-rolled parser with brace-balancing for multi-line constructs.
- **ts-patch**: elegant single-tool solution but requires patching `tsc` and writing a TypeScript compiler API transformer — verbose and tightly coupled to TS internals.
- **esbuild alone**: excellent for dead branches but cannot strip exports/methods (no AST access) and cannot process `.d.ts` files.
- **ts-morph + esbuild**: each tool does what it's best at. ts-morph handles AST manipulation (including `.d.ts`); esbuild handles constant propagation and dead branch elimination. No compiler patching, no custom parser.

### Runtime Feature Checks

For conditional logic within implementation code (not API surface), each package that needs it gets a generated module:

```typescript
// src/generated/features.ts (AUTO-GENERATED — do not edit)
export const features = {
  skills: true,
  someExperimentalApi: false,
} as const;
```

This file is:
- Generated by `scripts/generate-features.ts` which reads `features.json`
- `.gitignore`d (build artifact)
- Internal only — never exported from any barrel file

Usage:
```typescript
import { features } from "./generated/features.js";

if (features.someExperimentalApi) {
  this.registerExperimentalHandlers();
}
```

In debug mode, all values are `true`. In release mode, values come from `features.json`.

The esbuild pass (above) then replaces these references with literal booleans and eliminates the dead branches, so disabled feature code is completely absent from the release build output.

#### Why generated code over symlinks?

Git symlinks are fragile across platforms (especially Windows, even if not a current target). A codegen step is explicit, conventional, and requires no special git configuration. A shared `@thinkwell/features` workspace package was also considered but is over-engineered for a single constant.

### Build Pipeline

**Release** (the default `pnpm build`):
```
generate-features --mode=release
  → writes src/generated/features.ts per package (values from features.json)
tsc (per package)
  → compiles to dist/ with all exports present and @feature comments preserved
strip-features --mode=release (per package)
  → ts-morph: removes disabled @feature declarations from dist/*.js and dist/*.d.ts
  → esbuild transform: replaces features.x with literals, eliminates dead branches in dist/*.js
```

**Debug** (`pnpm build:debug`):
```
generate-features --mode=debug
  → writes src/generated/features.ts per package (all values true)
tsc (per package)
  → compiles to dist/ — no stripping, all exports present
```

### Script Changes

Root `package.json`:
```json
{
  "scripts": {
    "build": "tsx scripts/generate-features.ts --mode=release && pnpm -r build",
    "build:debug": "tsx scripts/generate-features.ts --mode=debug && pnpm -r build:debug",
    "generate-features": "tsx scripts/generate-features.ts"
  }
}
```

Per-package `package.json` (packages with feature-gated exports):
```json
{
  "scripts": {
    "build": "tsc && tsx ../../scripts/strip-features.ts --mode=release",
    "build:debug": "tsc"
  }
}
```

### CI Changes

The CI workflow adds a features dimension. To avoid doubling CI time, debug-mode tests run on a single OS while release-mode tests run on all platforms:

- **Release mode**: 4 jobs (macos-14, macos-15-intel, ubuntu-latest, ubuntu-24.04-arm) — includes binary builds
- **Debug mode**: 1 job (ubuntu-latest) — validates that all-features-on compiles and passes tests
- **Total**: 5 jobs (up from 4)

## Trade-offs

**Advantages:**
- Leverages existing tools (ts-morph, esbuild) instead of a custom parser
- AST-level stripping via ts-morph is robust across all declaration forms
- esbuild ensures dead branches are fully eliminated, not just hidden behind runtime checks
- Non-invasive — `tsc` compilation is unchanged; stripping is post-processing
- Single annotation syntax works for both runtime code (`.js`) and type declarations (`.d.ts`)
- Debug builds are just `tsc` with no extra steps — fast for development
- Release builds are the default, so the safe path is the easy path

**Disadvantages:**
- Adds ts-morph as a dev dependency (it depends on the TypeScript compiler API, which is already a dev dependency)
- Two-pass stripping is slightly more complex than a single-tool approach
- Dead implementation modules remain in `dist/` when their exports are stripped (harmless — unreferenced files don't affect consumers)
- Tests that directly import feature-gated exports need to handle the disabled case (skip or import from source modules instead of barrel)

## Scope

**In scope:**
- `features.json` config file format
- `scripts/strip-features.ts` post-tsc stripping script (ts-morph + esbuild)
- `scripts/generate-features.ts` runtime module generator
- Build script changes (root and per-package)
- CI workflow update for dual-mode testing

**Not in scope:**
- Feature flags for non-TypeScript artifacts (documentation, CLI help text)
- Feature deprecation workflow or automatic feature promotion
