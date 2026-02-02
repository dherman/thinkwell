# Installation Guide

Thinkwell offers multiple installation methods to fit your workflow. Choose the approach that works best for you.

## Quick Start

Try thinkwell without installing anything:

```bash
npx thinkwell init my-project
cd my-project
```

## Installation Methods

### Homebrew (Recommended for macOS/Linux)

The simplest way to install thinkwell system-wide:

```bash
brew install dherman/thinkwell/thinkwell
```

This installs a self-contained binary with everything included—no additional dependencies required.

### Manual Installation (Linux)

Download and install the binary directly:

**x64 Linux:**
```bash
mkdir -p ~/.local/bin && curl -L https://github.com/dherman/thinkwell/releases/latest/download/thinkwell-linux-x64.tar.gz | tar -xz -C ~/.local/bin && mv ~/.local/bin/thinkwell* ~/.local/bin/thinkwell
```

**ARM Linux:**
```bash
mkdir -p ~/.local/bin && curl -L https://github.com/dherman/thinkwell/releases/latest/download/thinkwell-linux-arm64.tar.gz | tar -xz -C ~/.local/bin && mv ~/.local/bin/thinkwell* ~/.local/bin/thinkwell
```

Then add `~/.local/bin` to your PATH.

### Project Installation

For development, install thinkwell as a dev dependency in your project:

<!-- tabs:start -->
#### **npm**
```bash
npm install -D thinkwell
```

#### **pnpm**
```bash
pnpm add -D thinkwell
```

#### **yarn**
```bash
yarn add -D thinkwell
```

#### **bun**
```bash
bun add -D thinkwell
```
<!-- tabs:end -->

> **Note:** When installed via npm/pnpm/yarn, thinkwell requires [Bun](https://bun.sh) to run scripts. See [Runtime Requirements](#runtime-requirements) below.

### Global npm Installation

```bash
npm install -g thinkwell
```

## Runtime Requirements

Thinkwell uses a two-tier distribution model:

| Installation Method | Runtime Required | Notes |
|---------------------|------------------|-------|
| **Homebrew** | None | Self-contained binary with embedded runtime |
| **npm/pnpm/yarn/bun** | Bun | Lightweight package, requires external Bun |

### Why Bun?

Thinkwell uses Bun as its runtime to provide:

- **Native TypeScript execution** — No transpilation step, just write and run
- **Automatic schema generation** — `@JSONSchema` types become runtime validators
- **Fast startup** — Scripts start instantly
- **Compiled executables** — Build standalone binaries from your agents

### Installing Bun

If you installed thinkwell via npm and need Bun:

```bash
# macOS/Linux
curl -fsSL https://bun.sh/install | bash

# Or via Homebrew
brew install oven-sh/bun/bun

# Windows
powershell -c "irm bun.sh/install.ps1 | iex"
```

### Commands That Work Without Bun

Even without Bun installed, these commands work with the npm distribution:

| Command | Bun Required? |
|---------|---------------|
| `thinkwell --help` | No |
| `thinkwell --version` | No |
| `thinkwell init` | No |
| `thinkwell run <script>` | **Yes** |
| `thinkwell types` | **Yes** |

## CI/CD Installation

### Option 1: Direct Binary Download (Recommended)

The simplest approach—download a self-contained binary with no dependencies:

```yaml
# GitHub Actions
- name: Install thinkwell
  run: |
    curl -fsSL https://github.com/dherman/thinkwell/releases/latest/download/thinkwell-linux-x64.tar.gz | tar xz
    sudo mv thinkwell /usr/local/bin/

- name: Run agent
  run: thinkwell run src/agent.ts
```

Available binaries:
- `thinkwell-darwin-arm64.tar.gz` — macOS Apple Silicon
- `thinkwell-darwin-x64.tar.gz` — macOS Intel
- `thinkwell-linux-arm64.tar.gz` — Linux ARM64
- `thinkwell-linux-x64.tar.gz` — Linux x64

### Option 2: npm + Bun Setup

Smaller download, but requires Bun setup:

```yaml
# GitHub Actions
- name: Setup Bun
  uses: oven-sh/setup-bun@v1

- name: Install thinkwell
  run: npm install -g thinkwell

- name: Run agent
  run: thinkwell run src/agent.ts
```

### Docker

For containerized workflows:

```dockerfile
# Using the binary (no runtime dependencies)
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y curl && \
    curl -fsSL https://github.com/dherman/thinkwell/releases/latest/download/thinkwell-linux-x64.tar.gz | tar xz -C /usr/local/bin && \
    apt-get remove -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

COPY src/ /app/src/
WORKDIR /app
CMD ["thinkwell", "run", "src/agent.ts"]
```

## Troubleshooting

### "Bun is required to run thinkwell scripts"

This error appears when using the npm distribution without Bun installed. Solutions:

1. **Install Bun:** `curl -fsSL https://bun.sh/install | bash`
2. **Use Homebrew instead:** `brew install dherman/thinkwell/thinkwell` (includes everything)

### "command not found: thinkwell"

After installing via npm, ensure your npm bin directory is in your PATH:

```bash
# Check where npm installs binaries
npm bin -g

# Add to PATH (add to your shell profile)
export PATH="$(npm bin -g):$PATH"
```

### Homebrew Formula Not Found

If `brew install dherman/thinkwell/thinkwell` fails:

```bash
# Tap the repository first
brew tap dherman/thinkwell

# Then install
brew install thinkwell
```

### Permission Denied on Linux

If the binary doesn't execute:

```bash
chmod +x thinkwell
```

### TypeScript Errors in IDE

If your IDE shows errors for `.Schema` properties:

1. Generate declaration files:
   ```bash
   thinkwell types
   ```

2. Ensure your `tsconfig.json` includes them:
   ```json
   {
     "include": ["src/**/*.ts", "src/**/*.thinkwell.d.ts"]
   }
   ```

3. Restart your TypeScript language server

### Schema Generation Not Working

The `@JSONSchema` decorator requires the thinkwell runtime. Ensure you're running your script with:

```bash
thinkwell run script.ts
```

Not with `bun run` or `node` directly.

## Version Management

### Checking Installed Version

```bash
thinkwell --version
```

### Upgrading

**Homebrew:**
```bash
brew upgrade thinkwell
```

**npm:**
```bash
npm update -g thinkwell
```

**Project dependency:**
```bash
npm update thinkwell
```

## Next Steps

- [Quick Start Guide](../README.md#quick-start) — Write your first agent
- [IDE Support](../README.md#ide-support) — Set up autocomplete for schemas
- [CLI Reference](cli-reference.md) — Full command documentation
