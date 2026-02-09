import { describe, it } from "node:test";
import assert from "node:assert";
import { parseSkillMd, validateSkillName, validateSkillDescription } from "./skill.js";

describe("validateSkillName", () => {
  it("should accept valid names", () => {
    assert.doesNotThrow(() => validateSkillName("code-review"));
    assert.doesNotThrow(() => validateSkillName("a"));
    assert.doesNotThrow(() => validateSkillName("test123"));
    assert.doesNotThrow(() => validateSkillName("my-cool-skill"));
    assert.doesNotThrow(() => validateSkillName("a1b2c3"));
  });

  it("should reject empty name", () => {
    assert.throws(() => validateSkillName(""), /Skill name is required/);
  });

  it("should reject non-string name", () => {
    assert.throws(() => validateSkillName(undefined), /Skill name is required/);
    assert.throws(() => validateSkillName(null), /Skill name is required/);
    assert.throws(() => validateSkillName(42), /Skill name is required/);
  });

  it("should reject names longer than 64 characters", () => {
    const longName = "a".repeat(65);
    assert.throws(() => validateSkillName(longName), /at most 64 characters/);
  });

  it("should accept names exactly 64 characters", () => {
    const maxName = "a".repeat(64);
    assert.doesNotThrow(() => validateSkillName(maxName));
  });

  it("should reject names with uppercase letters", () => {
    assert.throws(() => validateSkillName("Code-Review"), /Invalid skill name/);
  });

  it("should reject names with leading hyphens", () => {
    assert.throws(() => validateSkillName("-review"), /Invalid skill name/);
  });

  it("should reject names with trailing hyphens", () => {
    assert.throws(() => validateSkillName("review-"), /Invalid skill name/);
  });

  it("should reject names with consecutive hyphens", () => {
    assert.throws(() => validateSkillName("code--review"), /Invalid skill name/);
  });

  it("should reject names with special characters", () => {
    assert.throws(() => validateSkillName("code_review"), /Invalid skill name/);
    assert.throws(() => validateSkillName("code.review"), /Invalid skill name/);
    assert.throws(() => validateSkillName("code review"), /Invalid skill name/);
  });
});

describe("validateSkillDescription", () => {
  it("should accept valid descriptions", () => {
    assert.doesNotThrow(() => validateSkillDescription("Reviews code."));
    assert.doesNotThrow(() => validateSkillDescription("A"));
  });

  it("should reject empty description", () => {
    assert.throws(() => validateSkillDescription(""), /Skill description is required/);
  });

  it("should reject whitespace-only description", () => {
    assert.throws(() => validateSkillDescription("   "), /Skill description is required/);
  });

  it("should reject non-string description", () => {
    assert.throws(() => validateSkillDescription(undefined), /Skill description is required/);
    assert.throws(() => validateSkillDescription(null), /Skill description is required/);
  });

  it("should reject descriptions longer than 1024 characters", () => {
    const longDesc = "a".repeat(1025);
    assert.throws(() => validateSkillDescription(longDesc), /at most 1024 characters/);
  });

  it("should accept descriptions exactly 1024 characters", () => {
    const maxDesc = "a".repeat(1024);
    assert.doesNotThrow(() => validateSkillDescription(maxDesc));
  });
});

describe("parseSkillMd", () => {
  it("should parse a valid SKILL.md", () => {
    const content = `---
name: code-review
description: Reviews code for bugs, style issues, and best practices.
---

# Code Review

## Steps
1. Read the files
2. Analyze for issues
`;

    const skill = parseSkillMd(content);

    assert.strictEqual(skill.name, "code-review");
    assert.strictEqual(skill.description, "Reviews code for bugs, style issues, and best practices.");
    assert.ok(skill.body.includes("# Code Review"));
    assert.ok(skill.body.includes("1. Read the files"));
  });

  it("should preserve optional fields", () => {
    const content = `---
name: my-skill
description: A test skill.
license: MIT
compatibility: claude
---

Body content.
`;

    const skill = parseSkillMd(content);

    assert.strictEqual(skill.name, "my-skill");
    assert.strictEqual(skill.description, "A test skill.");
    assert.strictEqual(skill.license, "MIT");
    assert.strictEqual(skill.compatibility, "claude");
    assert.strictEqual(skill.body, "Body content.\n");
  });

  it("should handle quoted values in frontmatter", () => {
    const content = `---
name: "my-skill"
description: 'A skill with quotes.'
---

Body.
`;

    const skill = parseSkillMd(content);

    assert.strictEqual(skill.name, "my-skill");
    assert.strictEqual(skill.description, "A skill with quotes.");
  });

  it("should handle descriptions with colons", () => {
    const content = `---
name: my-skill
description: "A skill: with colons in description"
---

Body.
`;

    const skill = parseSkillMd(content);

    assert.strictEqual(skill.description, "A skill: with colons in description");
  });

  it("should throw on missing frontmatter", () => {
    const content = `# Just Markdown

No frontmatter here.
`;

    assert.throws(() => parseSkillMd(content), /must begin with YAML frontmatter/);
  });

  it("should throw on unclosed frontmatter", () => {
    const content = `---
name: broken
description: No closing delimiter
`;

    assert.throws(() => parseSkillMd(content), /missing closing ---/);
  });

  it("should throw on missing name", () => {
    const content = `---
description: Has description but no name.
---

Body.
`;

    assert.throws(() => parseSkillMd(content), /Skill name is required/);
  });

  it("should throw on missing description", () => {
    const content = `---
name: has-name
---

Body.
`;

    assert.throws(() => parseSkillMd(content), /Skill description is required/);
  });

  it("should throw on invalid name format", () => {
    const content = `---
name: Invalid-Name
description: Has an uppercase letter.
---

Body.
`;

    assert.throws(() => parseSkillMd(content), /Invalid skill name/);
  });

  it("should handle empty body", () => {
    const content = `---
name: minimal
description: A minimal skill.
---
`;

    const skill = parseSkillMd(content);

    assert.strictEqual(skill.name, "minimal");
    assert.strictEqual(skill.body, "");
  });

  it("should handle leading whitespace before frontmatter", () => {
    const content = `
---
name: indented
description: Starts with whitespace.
---

Body.
`;

    const skill = parseSkillMd(content);

    assert.strictEqual(skill.name, "indented");
  });

  it("should skip comment lines in frontmatter", () => {
    const content = `---
# This is a comment
name: my-skill
description: A skill with comments.
---

Body.
`;

    const skill = parseSkillMd(content);

    assert.strictEqual(skill.name, "my-skill");
  });
});
