# Skill API Implementation Plan

## 1. Types and SKILL.md parser (`@thinkwell/acp`)

- [x] Add `packages/acp/src/skill.ts` with `Skill`, `VirtualSkill`, `StoredSkill`, `SkillTool` types
- [x] Implement `parseSkillMd(content: string): Skill` — extract YAML frontmatter, validate name/description, return body
- [x] Validate name: 1-64 chars, lowercase alphanumeric + hyphens, no leading/trailing/consecutive hyphens
- [x] Validate description: 1-1024 chars, non-empty
- [x] Preserve optional fields (`license`, `compatibility`, `metadata`) without acting on them
- [x] Export types and parser from `packages/acp/src/index.ts`
- [x] Tests for parser: valid SKILL.md, missing name, missing description, invalid name format, optional fields

## 2. Skill MCP server (`@thinkwell/acp`)

- [x] Add `packages/acp/src/skill-server.ts` with a function that builds an `McpServer` for skills
- [x] Implement `activate_skill` handler: look up skill by name, return body as text content
- [x] Implement `call_skill_tool` handler: look up skill, look up tool by name, call handler, return result
- [x] Implement `read_skill_file` handler: validate skill has `basePath`, resolve path, validate no traversal, read text file
- [x] All three tools use the `defineTool` pattern (hidden from prompt)
- [x] Tests for each handler: happy path, unknown skill, unknown tool, path traversal rejection

## 3. ThinkBuilder `.skill()` method (`thinkwell`)

- [x] Add internal `_skills` state to ThinkBuilder (list preserving attachment order)
- [x] Add `.skill(pathOrDef)` overloaded method: string → deferred stored skill, object → virtual skill
- [x] Validate virtual skill definitions eagerly (name, description format)
- [x] Stored skill paths are recorded but SKILL.md is parsed at `run()` time

## 4. Prompt assembly (`thinkwell`)

- [x] At `run()` time, resolve stored skills: parse SKILL.md, record basePath, throw on invalid
- [x] Build `<available_skills>` XML block from all resolved skill metadata (name + description)
- [x] Prepend skills block + infrastructure instructions before user prompt parts
- [x] Skills listed in attachment order

## 5. MCP server registration (`thinkwell`)

- [x] At `run()` time, if skills are present, build and register the skill MCP server
- [x] Pass resolved skills (with handlers and basePaths) to the server builder
- [x] Register on the same `mcpHandler` used for the existing thinkwell server

## 6. Exports

- [ ] Export `Skill`, `VirtualSkill`, `StoredSkill`, `SkillTool` types from `thinkwell` package
- [ ] Export `parseSkillMd` from `@thinkwell/acp` (useful for advanced users)
