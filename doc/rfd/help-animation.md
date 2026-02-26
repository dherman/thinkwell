# RFD: Animated Help Screen

- **Issue:** [#56](https://github.com/dherman/thinkwell/issues/56)

## Summary

Add a brief typewriter-style animation to the `thinkwell --help` screen that "writes out" the tagline, reinforcing the brand identity of "agent scripting." The animation should only play for the generic main help screen — not for subcommand help, error messages, or non-TTY output.

## Background

The current main help screen displays:

```
thinkwell - agent scripting made easy ✨🖋️
```

The `✨🖋️` emoji conveys the idea of scripting/writing. Issue #56 proposes a brief (~200ms) animation that makes the tagline appear to be actively "written out," swapping in `✨✍️` during the animation to suggest active writing, then settling on the final `✨🖋️` once the animation completes.

## Design Goals

1. **Subtle, not annoying** — The animation should be brief and only appear in contexts where the user explicitly asked for the help screen.
2. **Graceful degradation** — Non-TTY output (piped, redirected, CI) should skip the animation entirely and print the static help text.
3. **Zero dependencies** — Use Node.js built-in APIs (`process.stdout`, `setTimeout`/`setInterval`) for terminal manipulation, consistent with the project's no-external-CLI-deps approach.
4. **Self-contained** — The `commands.ts` module must remain free of local imports (required by the `main.cjs` entry point for pkg compatibility).

## Proposal

### When to Animate

The animation plays **only** when all of these conditions are met:

1. The user invoked `thinkwell --help` or `thinkwell -h` (or `thinkwell` with no arguments) — i.e., `showMainHelp()` is called.
2. stdout is a TTY (`process.stdout.isTTY === true`).

The animation does **not** play for:

- **Subcommand help** — `thinkwell init --help`, `thinkwell check --help`, etc. These have their own `showInitHelp()` / `showCheckHelp()` functions.
- **Error screens** — `showNoScriptError()` and other error paths.
- **Piped output** — `thinkwell --help | less`, `thinkwell --help > help.txt`, etc.

This keeps the animation as a fun brand moment that appears exactly when someone is casually browsing the CLI, and stays out of the way everywhere else.

### Animation Behavior

The animation targets the first line of help output — the tagline:

```
thinkwell - agent scripting made easy ✨🖋️
```

The effect is a typewriter reveal of the tagline text, character by character (or in small chunks), with the `✍️` emoji displayed during writing and `🖋️` shown at the end. A rough sketch of the sequence:

1. Print `thinkwell` (the command name, styled cyan+bold) immediately — this anchors the line.
2. Reveal ` - agent scripting made easy` progressively over ~200ms, with `✨✍️` at the end of whatever has been revealed so far.
3. On the final frame, replace `✍️` with `🖋️` to show the "finished" state.
4. Print the rest of the help text (usage, examples, URL) all at once.

The exact timing and chunking (per-character, per-word, or some hybrid) should be tuned during implementation to feel natural. The total animation duration should be short — roughly 150–250ms — so it reads as a quick flourish, not a loading screen.

### Terminal Mechanics

The animation overwrites the current line during the reveal using standard ANSI escape sequences:

- `\r` — carriage return (move cursor to start of line)
- `\x1b[K` — clear from cursor to end of line

Each frame writes `\r\x1b[K` followed by the current state of the tagline. This is the same technique used in [examples/src/util/status.ts](../../examples/src/util/status.ts) for the spinner animation.

After the tagline animation completes, the cursor advances to the next line and the remaining help text is printed normally via `console.log`.

### API Change

`showMainHelp()` currently returns `void` synchronously. It will need to become async to accommodate the animation delay:

```typescript
export async function showMainHelp(): Promise<void>
```

Callers in both `bin/thinkwell` and `main.cjs` already sit in async contexts, so this is a straightforward change — just add `await` at the call sites.

When stdout is not a TTY, `showMainHelp()` prints the static text immediately and resolves, so the async signature has no practical cost in non-interactive contexts.

### Skipping the Animation

Beyond the TTY check, we may also want to respect:

- **`NO_COLOR` environment variable** — If set, the animation should still play (it's not about color), but this is worth noting since the styling helpers already check this.
- **`CI` environment variable** — Many CI environments set `CI=true`. If stdout happens to be a TTY in CI (unusual but possible), we should skip the animation. Animations in CI logs are just noise.

So the full condition becomes:

```
animate = process.stdout.isTTY && !process.env.CI
```

## Alternatives Considered

### Alternative 1: Animate All Help Screens

We could apply the animation to subcommand help too (`thinkwell init --help`, etc.). But subcommand help is typically consulted by someone trying to get something done — they're looking for a specific flag or usage pattern. An animation there would feel like it's wasting their time. The main `--help` screen is different: it's a "what is this tool?" moment where a brief flourish adds personality.

### Alternative 2: Full-Screen Animation

A more elaborate animation could reveal the entire help text line by line. This would be more visually striking but would take longer and feel more like a gimmick than a polish detail. The tagline-only approach keeps it contained and fast.

### Alternative 3: Do Nothing

The static help screen works fine. But small touches like this contribute to the overall feel of a polished, thoughtfully designed tool. The implementation is low-risk and low-effort.

## Trade-offs

| Aspect | Benefit |
|--------|---------|
| Brand personality | Reinforces the "scripting/writing" metaphor in a memorable way |
| Low risk | Scoped to one function, TTY-only, graceful fallback |
| Minimal code | ~30-50 lines of animation logic in an existing module |

| Aspect | Cost |
|--------|------|
| Async change | `showMainHelp()` becomes async; callers need `await` |
| Subjectivity | Animation aesthetics are subjective; may need tuning |
| Testing | Animation behavior is hard to unit test (timing-dependent, TTY-dependent) |
