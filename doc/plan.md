# Plan: Bundled Type Declarations for Standalone Scripts

RFD: [bundled-type-declarations.md](rfd/bundled-type-declarations.md)

## Tasks

- [ ] Generate `.d.ts` files for `thinkwell`, `@thinkwell/acp`, and `@thinkwell/protocol` (ensure build produces them)
- [ ] Add build step to embed `.d.ts` content as string constants in the TS plugin bundle
- [ ] Create virtual file paths for bundled declarations (e.g., `__thinkwell_types__/thinkwell/index.d.ts`)
- [ ] Extend `getScriptSnapshot` patch to serve bundled declarations for virtual type paths
- [ ] Rewrite `resolveModuleNameLiterals` patch to resolve to virtual paths instead of on-disk paths
- [ ] Remove `locateInstallation()` and related `which thinkwell` / symlink-chasing code
- [ ] Remove `ThinkwellInstallation` type, `resolveModulePath()`, and `InstallationLocator`
- [ ] Update standalone-resolver tests to cover bundled declaration resolution
- [ ] Manually test standalone script in VSCode with Homebrew-installed thinkwell
