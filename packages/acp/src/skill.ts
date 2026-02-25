/**
 * Skill types and SKILL.md parser for the Agent Skills standard.
 *
 * This module defines the core skill types and provides a parser for
 * SKILL.md files (YAML frontmatter + Markdown body).
 */

/**
 * A tool bundled with a virtual skill.
 * Same trust model as Plan's .tool() -- user-authored handler functions.
 *
 * Unlike top-level .tool() registrations, skill tools are not registered as
 * individual MCP tools with formal schemas. Instead, the skill body documents
 * available tools and their expected inputs as Markdown. The agent invokes them
 * via the generic `call_skill_tool` dispatcher, which routes to the handler.
 */
export interface SkillTool<I = unknown, O = unknown> {
  name: string;
  description: string;
  handler: (input: I) => Promise<O>;
}

/**
 * Base skill definition: metadata + instructions.
 */
export interface Skill {
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
export interface VirtualSkill extends Skill {
  tools?: SkillTool[];
}

/**
 * A stored skill loaded from a SKILL.md file on the filesystem.
 * The basePath is used to serve reference docs and assets via `read_skill_file`.
 */
export interface StoredSkill extends Skill {
  basePath: string;
}

/** Validation pattern for skill names: lowercase alphanumeric + hyphens, no leading/trailing/consecutive hyphens. */
const SKILL_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9]))*$/;

/** Maximum length for skill names. */
const MAX_NAME_LENGTH = 64;

/** Maximum length for skill descriptions. */
const MAX_DESCRIPTION_LENGTH = 1024;

/**
 * Validate a skill name per the Agent Skills spec.
 * - 1-64 characters
 * - Lowercase alphanumeric + hyphens
 * - No leading, trailing, or consecutive hyphens
 */
export function validateSkillName(name: unknown): asserts name is string {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error("Skill name is required");
  }
  if (name.length > MAX_NAME_LENGTH) {
    throw new Error(`Skill name must be at most ${MAX_NAME_LENGTH} characters, got ${name.length}`);
  }
  if (!SKILL_NAME_PATTERN.test(name)) {
    throw new Error(
      `Invalid skill name "${name}": must be lowercase alphanumeric with hyphens, no leading/trailing/consecutive hyphens`
    );
  }
}

/**
 * Validate a skill description per the Agent Skills spec.
 * - 1-1024 characters
 * - Non-empty (after trimming)
 */
export function validateSkillDescription(description: unknown): asserts description is string {
  if (typeof description !== "string" || description.trim().length === 0) {
    throw new Error("Skill description is required");
  }
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    throw new Error(
      `Skill description must be at most ${MAX_DESCRIPTION_LENGTH} characters, got ${description.length}`
    );
  }
}

/**
 * Parse a SKILL.md file content into a Skill.
 *
 * Extracts YAML frontmatter (delimited by `---`), validates required fields
 * (name, description), and returns the parsed skill with the Markdown body.
 *
 * Optional frontmatter fields (license, compatibility, metadata) are preserved
 * in the returned object but not acted upon.
 *
 * @throws Error if frontmatter is missing, malformed, or required fields are invalid
 */
export function parseSkillMd(content: string): Skill & Record<string, unknown> {
  const { frontmatter, body } = extractFrontmatter(content);
  const fields = parseYamlFrontmatter(frontmatter);

  validateSkillName(fields.name);
  validateSkillDescription(fields.description);

  return {
    ...fields,
    name: fields.name as string,
    description: fields.description as string,
    body,
  };
}

/**
 * Extract YAML frontmatter and body from a SKILL.md string.
 * Frontmatter is delimited by opening and closing `---` lines.
 */
function extractFrontmatter(content: string): { frontmatter: string; body: string } {
  const trimmed = content.trimStart();

  if (!trimmed.startsWith("---")) {
    throw new Error("SKILL.md must begin with YAML frontmatter (---)")
  }

  // Find the closing `---` after the opening one
  const endIndex = trimmed.indexOf("\n---", 3);
  if (endIndex === -1) {
    throw new Error("SKILL.md frontmatter is missing closing ---");
  }

  const frontmatter = trimmed.slice(3, endIndex).trim();
  // Body starts after the closing `---` and its newline
  const afterClosing = endIndex + 4; // "\n---".length
  // Strip the line ending after the closing --- and any single blank line
  const body = trimmed.slice(afterClosing).replace(/^(\r?\n){1,2}/, "");

  return { frontmatter, body };
}

/**
 * Minimal YAML parser for SKILL.md frontmatter.
 *
 * Supports only the flat key-value structure needed for skill metadata:
 * simple string values (quoted or unquoted). This is intentionally limited --
 * we don't need nested objects, arrays, or other YAML features.
 */
function parseYamlFrontmatter(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const line of yaml.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const colonIndex = trimmed.indexOf(":");
    if (colonIndex === -1) {
      throw new Error(`Invalid frontmatter line: ${trimmed}`);
    }

    const key = trimmed.slice(0, colonIndex).trim();
    let value: unknown = trimmed.slice(colonIndex + 1).trim();

    // Strip surrounding quotes (single or double)
    if (typeof value === "string") {
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
    }

    result[key] = value;
  }

  return result;
}
