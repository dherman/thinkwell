# Plan: Bundled Type Declarations for Standalone Scripts

RFD: [bundled-type-declarations.md](rfd/bundled-type-declarations.md)

## Tasks

- [x] Generate `.d.ts` files for `thinkwell`, `@thinkwell/acp`, and `@thinkwell/protocol` (ensure build produces them)
- [x] Add build step to embed `.d.ts` content as string constants in the TS plugin bundle
- [x] Create virtual file paths for bundled declarations (e.g., `__thinkwell_types__/thinkwell/index.d.ts`)
- [x] Extend `getScriptSnapshot` patch to serve bundled declarations for virtual type paths
- [x] Rewrite `resolveModuleNameLiterals` patch to resolve to virtual paths instead of on-disk paths
- [x] Remove `locateInstallation()` and related `which thinkwell` / symlink-chasing code
- [x] Remove `ThinkwellInstallation` type, `resolveModulePath()`, and `InstallationLocator`
- [x] Update standalone-resolver tests to cover bundled declaration resolution
- [x] Manually test standalone script in VSCode with Homebrew-installed thinkwell
