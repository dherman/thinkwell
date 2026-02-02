# Fix compiled binary module resolution

Based on [RFD: Binary Distribution Module Resolution](rfd/binary-module-resolution.md)

## Tasks

- [ ] Add `packages/bun-plugin/src/registry.ts` with `registerModule`, `getRegisteredModule`, `isVirtualModeEnabled`
- [ ] Export registry functions from `packages/bun-plugin/src/index.ts`
- [ ] Modify `onResolve` to check virtual mode and return `thinkwell-virtual` namespace for registered modules
- [ ] Add `onLoad` handler for `thinkwell-virtual` namespace that returns registered exports with `loader: "object"`
- [ ] Update `packages/thinkwell/src/cli/main.ts` to import and register thinkwell packages before running user scripts
- [ ] Build binary and test with `examples/src/greeting.ts`
