# Help Animation Implementation Plan

RFD: [doc/rfd/help-animation.md](rfd/help-animation.md)

## Tasks

- [x] Add typewriter animation logic to `showMainHelp()` in `commands.ts`
  - Split tagline into anchor (`thinkwell`) + revealed text (` - agent scripting made easy`)
  - Use `✨✍️` emoji (replaces former `✨🖋️` everywhere)
  - Use `\r\x1b[K` line-overwrite technique, ~200ms total duration
  - Guard: only animate when `process.stdout.isTTY && !process.env.CI`
  - Non-TTY path prints static text immediately
- [x] Make `showMainHelp()` async (returns `Promise<void>`)
- [x] Add `await` to `showMainHelp()` call in `bin/thinkwell`
- [x] Add `await` to `showMainHelp()` call in `src/cli/main.cjs`
- [x] Add version-gated animation to `showMainHelp()` in `commands.ts`
  - Add `ShowMainHelpOptions` interface (`{ version: string; forceWelcome?: boolean }`)
  - Add marker file helpers (`getWelcomeMarkerPath`, `shouldAnimate`, `recordWelcomeVersion`)
  - Gate animation on marker file match (in addition to existing TTY/CI guard)
  - Write marker only after animation plays, not on static-text path
- [x] Add `hasWelcomeFlag()` helper to `commands.ts`
- [x] Update `bin/thinkwell`: import `hasWelcomeFlag`, parse `--welcome`, pass options to `showMainHelp()`
- [x] Update `src/cli/main.cjs`: require `hasWelcomeFlag`, parse `--welcome`, pass options to `showMainHelp()`
- [x] Manual smoke tests:
  - `thinkwell --help` first run (animates), second run (static)
  - `thinkwell --welcome` (always animates)
  - `thinkwell --help | cat` (static, no marker written)
  - Delete `~/.cache/thinkwell/welcome-version`, then `thinkwell --help` (animates again)
