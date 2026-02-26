# Help Animation Implementation Plan

RFD: [doc/rfd/help-animation.md](rfd/help-animation.md)

## Tasks

- [ ] Add typewriter animation logic to `showMainHelp()` in `commands.ts`
  - Split tagline into anchor (`thinkwell`) + revealed text (` - agent scripting made easy`)
  - Use `✨✍️` emoji (replaces former `✨🖋️` everywhere)
  - Use `\r\x1b[K` line-overwrite technique, ~200ms total duration
  - Guard: only animate when `process.stdout.isTTY && !process.env.CI`
  - Non-TTY path prints static text immediately
- [ ] Make `showMainHelp()` async (returns `Promise<void>`)
- [ ] Add `await` to `showMainHelp()` call in `bin/thinkwell`
- [ ] Add `await` to `showMainHelp()` call in `src/cli/main.cjs`
- [ ] Manual smoke test: `thinkwell --help` (TTY), `thinkwell --help | cat` (non-TTY), `thinkwell` (no args)
