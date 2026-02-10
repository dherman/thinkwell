# RFD: In-Memory Agent Skills API for ThinkBuilder

**Implementation:** [PR #26](https://github.com/dherman/thinkwell/pull/26)

## Summary

Add a `.skill()` API to ThinkBuilder that implements the [Agent Skills standard](https://agentskills.io/) without leaving visible artifacts in the filesystem. The `.skill()` method is overloaded: pass a string path to load a stored skill from a `SKILL.md` file on disk, or pass an object to define a virtual skill programmatically. Skills are parsed in memory and injected into the agent session as system prompt content and MCP-based activation/dispatch tools -- all on the client side of the ACP connection.

## Background

### The Agent Skills Standard

The [Agent Skills standard](https://agentskills.io/) is an open specification (originally by Anthropic, now community-maintained) for giving AI agents new capabilities through portable, file-based instruction packages. A skill is a directory containing a `SKILL.md` file with YAML frontmatter and Markdown body:

```
my-skill/
├── SKILL.md          # Required: metadata + instructions
├── scripts/          # Optional: executable code
├── references/       # Optional: documentation
└── assets/           # Optional: templates, resources
```

The SKILL.md format:
```yaml
---
name: code-review
description: Reviews code for bugs, style issues, and best practices.
---

# Code Review

## When to use
Use when the user asks for a code review...

## Steps
1. Read the file
2. Analyze for issues
...
```

Skills are designed around **progressive disclosure**:
1. **Discovery** -- Only `name` and `description` are loaded at startup (~100 tokens each)
2. **Activation** -- Full SKILL.md body is loaded when a task matches (<5000 tokens recommended)
3. **Execution** -- Referenced files (scripts, references, assets) loaded on demand

The standard is supported by 25+ agent products (Claude Code, Cursor, Gemini CLI, VS Code, etc.).

### Claude Code's Skill Implementation

Claude Code implements skills via the filesystem: skills live in `.claude/skills/` directories, are discovered by scanning the filesystem, and are activated when the agent reads the SKILL.md file via shell commands. Claude Code also extends the standard with features like `context: fork` (subagent execution), `disable-model-invocation`, dynamic context injection via `` !`command` `` syntax, and hooks.

### The Thinkwell Constraint

Thinkwell is a programmatic library, not a CLI. Its users are application developers who want to compose agent capabilities from code. This creates a key constraint: **we should not leave visible files in the user's project directory**. Unlike Claude Code users who check `.claude/skills/` into their repos, Thinkwell users want skills to exist purely at runtime.

Additionally, Thinkwell controls the client side of the ACP connection, not the agent side. We can't assume the underlying agent has built-in skills support, so our implementation must work with any ACP-compatible agent by operating entirely within the client-side protocol layer.

## Goals

1. **Standard-compatible**: Skills follow the Agent Skills spec (SKILL.md format, progressive disclosure, naming rules)
2. **No filesystem footprint**: No visible files left in the user's project (ephemeral temp files are acceptable)
3. **Works with any ACP agent**: Implemented on the client side, not dependent on agent-side skills support
4. **Fits ThinkBuilder's API style**: Fluent, chainable, composable with existing `.tool()`, `.text()`, etc.
5. **Progressive disclosure**: Agent sees only skill metadata until it decides to activate a skill

## Non-Goals

1. **Full Claude Code parity**: We don't need `context: fork`, hooks, plugins, or enterprise skill directories
2. **Filesystem skill directories**: Users won't drop SKILL.md files into `.claude/skills/` -- they load skills programmatically
3. **Dynamic context injection**: The `` !`command` `` preprocessing syntax is a Claude Code feature, not in the core spec
4. **Skill authoring/validation CLI**: We're building a runtime API, not tooling for creating skills
5. **`allowed-tools` enforcement**: This experimental field in the spec is complex to implement and low priority

## Design

### Architecture: Client-Side Skill Proxy

The key insight is that skills are fundamentally a system prompt augmentation pattern combined with an activation mechanism. We can implement the entire skills lifecycle on the client side of the ACP connection:

```
┌───────────────────────────────────────────────────────────────┐
│ ThinkBuilder                                                  │
│                                                               │
│  .skill(codeReview)                                           │
│  .skill(pdfProcessing)      ┌──────────────────────┐          │
│  .text("Review this code")  │ SkillManager         │          │
│  .run()                     │                      │          │
│          │                  │ 1. Inject metadata   │          │
│          │                  │    into prompt       │          │
│          ▼                  │ 2. Register skill    │          │
│  ┌────────────────┐         │    infra tools       │          │
│  │ Prompt Assembly │───────▶│ 3. Handle activation │          │
│  └────────────────┘         │    (return body)     │          │
│                             │ 4. Dispatch tool     │          │
│                             │    calls to handlers │          │
│                             └──────────┬───────────┘          │
│                                        │                      │
│                             ┌──────────▼───────────┐          │
│                             │ MCP Server           │          │
│                             │ "thinkwell-skills"   │          │
│                             │                      │          │
│                             │ activate_skill(name) │          │
│                             │ read_skill_file(     │          │
│                             │   name, path)        │          │
│                             │ call_skill_tool(     │          │
│                             │   skill, tool,       │          │
│                             │   input) ──▶ handler │          │
│                             └──────────────────────┘          │
└──────────────────────────────────┬────────────────────────────┘
                                   │ ACP
                              ┌────▼────┐
                              │  Agent  │
                              └─────────┘
```

The flow:
1. User attaches skills via `.skill()` on ThinkBuilder
2. At `run()` time, skill metadata is injected into the prompt as `<available_skills>` XML (per the spec's recommendation for Claude models)
3. A dedicated MCP server exposes three infrastructure tools: `activate_skill`, `read_skill_file`, and `call_skill_tool`
4. When the agent decides a skill is relevant, it calls `activate_skill` -- which returns the full SKILL.md body, including documentation of any tools the skill provides
5. For virtual skills, the agent invokes bundled tools via `call_skill_tool`, which dispatches to handler functions in the client process (same trust model as `.tool()`)
6. For stored skills, scripts remain on disk -- the agent executes them via its own tools (e.g., Bash) with its own permission model
7. Reference docs and assets from stored skills are served via `read_skill_file`

This approach requires **zero filesystem writes** -- virtual skills exist entirely in memory, and stored skills are read-only from their source location.

### Skill Definition Type

```typescript
/**
 * A tool bundled with a virtual skill.
 * Same trust model as ThinkBuilder's .tool() -- user-authored handler functions.
 *
 * Unlike top-level .tool() registrations, skill tools are not registered as
 * individual MCP tools with formal schemas. Instead, the skill body documents
 * available tools and their expected inputs as Markdown. The agent invokes them
 * via the generic `call_skill_tool` dispatcher, which routes to the handler.
 */
interface SkillTool<I = unknown, O = unknown> {
  name: string;
  description: string;
  handler: (input: I) => Promise<O>;
}

/**
 * Base skill definition: metadata + instructions.
 */
interface Skill {
  /** Skill name (lowercase, hyphens, matches directory name in the spec) */
  name: string;
  /** When to use this skill (max 1024 chars) */
  description: string;
  /** Full instruction content (Markdown body from SKILL.md) */
  body: string;
}

/**
 * A virtual skill defined programmatically, with optional handler functions
 * dispatched via `call_skill_tool`.
 */
interface VirtualSkill extends Skill {
  tools?: SkillTool[];
}

/**
 * A stored skill loaded from a SKILL.md file on the filesystem.
 * The basePath is used to serve reference docs and assets via `read_skill_file`.
 */
interface StoredSkill extends Skill {
  basePath: string;
}
```

### Two Trust Models for Scripts

A key design decision is how skills expose executable behavior. The Agent Skills spec bundles scripts as files in `scripts/`, but Thinkwell supports two distinct trust models depending on whether the skill is virtual or stored:

**Virtual skills** use handler functions -- the same trust model as `.tool()`. The user wrote the code, it runs in their process, no sandboxing questions arise:

```typescript
const codeReview = skill({
  name: "code-review",
  description: "Reviews code for bugs, style issues, and best practices.",
  body: `
# Code Review

## Steps
1. Read the files to review
2. Identify bugs, style issues, and improvement opportunities
3. Use the \`count-lines\` tool to get line counts

## Available Tools

### count-lines
Count lines in a file.
Input: \`{ "path": "string" }\`
  `,
  tools: [{
    name: "count-lines",
    description: "Count lines in a file",
    handler: async ({ path }) => {
      const content = await fs.readFile(path, "utf-8");
      return { lines: content.split("\n").length };
    },
  }],
});
```

Unlike top-level `.tool()` registrations, skill tools are **not** registered as individual MCP tools with heavyweight schemas. Instead, the skill body documents available tools and their expected inputs as Markdown (the "Available Tools" section above). The agent invokes them via the generic `call_skill_tool` dispatcher, which routes to the handler by name. This preserves progressive disclosure: the tool schemas only enter the context window when the agent activates the skill, not at startup.

**Stored skills** keep scripts on disk at their original paths. The user explicitly pointed at a directory they trust, and scripts within it are already accessible to the agent via its own tools (e.g., Bash) with its own permission model:

```typescript
agent
  .skill("./skills/pdf-processing")
  // basePath === "/abs/path/to/skills/pdf-processing"
  // Scripts stay at /abs/path/to/skills/pdf-processing/scripts/extract.py
  // The agent invokes them via Bash, subject to its own sandboxing
```

At `run()` time, the SKILL.md is parsed into memory (metadata + body) but scripts, references, and assets are **not** eagerly read. Instead, the absolute `basePath` is recorded so that:
- The `read_skill_file` MCP tool can serve reference docs and assets on demand
- Script paths in the skill instructions resolve naturally against the filesystem, and the agent executes them via its own tools

This decomposition means:
- **Virtual skills** can't do anything the user didn't explicitly code as a handler function
- **Stored skills** delegate execution to the agent's own security model (which already handles untrusted filesystem operations)
- No new sandboxing mechanism is needed in either case

### ThinkBuilder Integration

The `.skill()` method is overloaded to accept both skill sources in a single, unified API:

```typescript
const result = await agent
  .think(ReviewSchema)
  // Stored skill: pass a path string, SKILL.md is parsed at run() time
  .skill("./skills/code-review")
  // Virtual skill: pass an object with name, description, body, and optional tools
  .skill({
    name: "test-writer",
    description: "Generates unit tests for TypeScript functions.",
    body: `...`,
  })
  .text("Review the authentication module and suggest improvements")
  .run();
```

When `.skill()` receives a **string**, it treats it as a path to a skill directory containing a `SKILL.md` file. The file is parsed at `run()` time (not at `.skill()` call time), and the directory's absolute path is recorded as `basePath` for `read_skill_file` access.

When `.skill()` receives an **object**, it's used directly as a virtual skill definition -- no filesystem involved.

Multiple skills can be attached. The `.skill()` method is chainable and can be mixed freely with `.tool()`, `.text()`, etc.

### Prompt Assembly

When `.run()` is called with attached skills, the prompt is assembled as:

```xml
<available_skills>
  <skill>
    <name>code-review</name>
    <description>Reviews code for bugs, style issues, and best practices.</description>
  </skill>
  <skill>
    <name>test-writer</name>
    <description>Generates unit tests for TypeScript functions.</description>
  </skill>
</available_skills>

The above skills are available to you. When a task matches a skill's description,
call the `activate_skill` tool with the skill name to load its full instructions.
If the skill provides tools, use `call_skill_tool` to invoke them.
If the skill references files, use `read_skill_file` to access them.

[... rest of user's prompt ...]
```

Only the name and description appear in the initial prompt (progressive disclosure). The full instructions are loaded via the `activate_skill` tool. Skills are listed in the order they were attached via `.skill()`, and the agent resolves any conflicts between skill instructions.

### MCP Tools

The `thinkwell-skills` MCP server registers exactly three infrastructure tools (always present when skills are attached). Notably, **skill-bundled tools are not registered as individual MCP tools** -- they are dispatched through the generic `call_skill_tool` tool, preserving progressive disclosure.

**`activate_skill`**: Returns the full Markdown body of a skill. For virtual skills with bundled tools, the body includes documentation of available tools and their expected inputs.
```json
{
  "name": "activate_skill",
  "description": "Load the full instructions for an available skill",
  "inputSchema": {
    "type": "object",
    "properties": {
      "name": { "type": "string", "description": "The skill name to activate" }
    },
    "required": ["name"]
  }
}
```

**`call_skill_tool`**: Dispatches a tool call to a virtual skill's handler function. The `input` parameter uses an open schema (`{}`) that accepts any JSON value -- the skill body documents the expected shape for each tool, and the handler validates at runtime.
```json
{
  "name": "call_skill_tool",
  "description": "Call a tool provided by a skill",
  "inputSchema": {
    "type": "object",
    "properties": {
      "skill": { "type": "string", "description": "The skill name" },
      "tool": { "type": "string", "description": "The tool name within the skill" },
      "input": { "description": "The tool input (shape varies per tool, documented in skill body)" }
    },
    "required": ["skill", "tool", "input"]
  }
}
```

This design means skill tools impose **zero context cost at startup**. The agent only learns about a skill's tools after calling `activate_skill`, when the skill body enters the context window with tool documentation as Markdown. This is the same progressive disclosure pattern used for the skill instructions themselves. As a bonus, tool names are naturally scoped to their skill via the `skill` parameter, so two skills can define tools with the same name without conflict, and skill tools can't collide with top-level `.tool()` registrations. The only constraint is that tool names must be unique within a single skill.

**`read_skill_file`**: Reads a text file from a stored skill's directory (references, assets). Only available for skills loaded via `.skill("path")` that have a `basePath`. For security, paths are validated to prevent traversal outside the skill directory. Only text files are supported; users who need binary asset support can implement it with custom skill tools via `call_skill_tool`.
```json
{
  "name": "read_skill_file",
  "description": "Read a reference or asset file bundled with a skill",
  "inputSchema": {
    "type": "object",
    "properties": {
      "skill": { "type": "string", "description": "The skill name" },
      "path": { "type": "string", "description": "Relative path within the skill directory" }
    },
    "required": ["skill", "path"]
  }
}
```

All three infrastructure tools are registered as hidden tools (using the same pattern as `defineTool` -- they don't get mentioned in the "Available tools:" section of the prompt, since they're already described in the `<available_skills>` XML block).

### Where This Lives in the Codebase

The implementation spans two packages:

**`@thinkwell/acp`** -- Low-level skill parsing and MCP server:
- `src/skill.ts` -- `Skill` type, `SkillTool` type, `parseSkillMd()` parser
- `src/skill-server.ts` -- MCP server that serves `activate_skill`, `call_skill_tool`, and `read_skill_file`

**`thinkwell`** -- High-level API:
- Modifications to `src/think-builder.ts` -- `.skill()` overloaded method (string path for stored skills, object for virtual skills), prompt assembly with `<available_skills>` XML

### SKILL.md Parsing

The parser is minimal: extract YAML frontmatter, validate `name` and `description`, keep the body as a string. We do **not** need to support the full set of Claude Code extensions (context, agent, hooks, disable-model-invocation, etc.) since those are agent-side features.

Required validation per spec:
- `name`: 1-64 chars, lowercase alphanumeric + hyphens, no leading/trailing/consecutive hyphens
- `description`: 1-1024 chars, non-empty

Optional fields we preserve but don't act on: `license`, `compatibility`, `metadata`.

`.skill("path")` throws eagerly on invalid SKILL.md -- silent failures are harder to debug than loud ones in a programmatic API.

### Stored Skills: What Gets Loaded

When loading from the filesystem via `.skill("path/to/dir")`, the loader does **not** eagerly read the entire directory into memory. Instead:
- `SKILL.md` is parsed: frontmatter becomes metadata, body is kept as a string
- `basePath` is recorded as the absolute path to the skill directory
- Scripts, references, and assets stay on disk

At runtime:
- `read_skill_file` serves reference docs and assets by reading from `basePath` on demand (with path traversal validation)
- Scripts are referenced by their filesystem paths in the skill body; the agent executes them via its own tools (Bash, etc.)

This means stored skill loading is fast (only parses one file) and the skill directory must remain accessible for the duration of the session. If the source is truly ephemeral (e.g., extracted from an archive), the caller is responsible for keeping it alive.

## Alternatives Considered

### 1. Writing Temp SKILL.md Files to Disk

We could write skills to a temp directory and point the agent at them via filesystem paths. This would let agents that natively support skills (like Claude Code) use their built-in skill loading.

**Rejected because:**
- Creates a dependency on the agent having filesystem-based skill support
- Temp files could leak if the process crashes
- Doesn't work with agents that don't have filesystem access
- Adds complexity (temp dir management, cleanup) for no real benefit

### 2. Injecting Full Skill Content into the System Prompt

We could skip progressive disclosure entirely and dump all skill content into the initial prompt.

**Rejected because:**
- Violates the progressive disclosure principle (wastes context on unused skills)
- Doesn't scale to many skills
- Misaligned with the standard's design philosophy

### 3. Using the Agent's Built-In Skill Support

If the agent (e.g., Claude Code) has native skill support, we could delegate to it.

**Rejected because:**
- Not all ACP agents support skills natively
- Would require filesystem writes (`.claude/skills/`)
- Would bypass Thinkwell's control over the session
- Would leave artifacts in the user's project

### 4. Registering Skill Tools as Individual MCP Tools

We could register each virtual skill's bundled tools as separate MCP tools with full JSON Schema definitions (e.g., `count-lines`, `validate-pr`), eagerly available at connection time.

**Rejected because:**
- Defeats progressive disclosure: every skill tool's schema is front-loaded into the agent's context window at startup, even for skills the agent never activates
- Doesn't scale: a session with many skills, each with several tools, creates a large MCP tool list that wastes context
- Creates tool name collision problems (two skills could define tools with the same name)
- The `call_skill_tool` dispatch approach achieves the same functionality while keeping tool documentation lazy -- schemas only enter the context window when the agent reads the skill body after activation

### 5. Separate SkillBuilder Instead of `.skill()` on ThinkBuilder

We could create a separate builder class for skill-aware sessions.

**Rejected because:**
- Skills are compositional with tools and prompts -- they belong on the same builder
- A separate builder creates friction and breaks the fluent API pattern
- `.skill()` is analogous to `.tool()` -- same level of abstraction
