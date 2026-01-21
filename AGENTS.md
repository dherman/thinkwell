This repository contains the TypeScript implementation of the Thinkwell library and the Agent Client Protocol (ACP) extensions.

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
