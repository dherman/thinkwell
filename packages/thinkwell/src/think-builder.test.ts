import { describe, it } from "node:test";
import assert from "node:assert";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { validateSkillName, validateSkillDescription, parseSkillMd } from "../../acp/src/skill.js";
import { createSkillServer } from "../../acp/src/skill-server.js";
import type { SkillTool, VirtualSkill, StoredSkill } from "../../acp/src/skill.js";
import type { ResolvedSkill } from "../../acp/src/skill-server.js";

/**
 * Since Plan requires a live connection to run, we test
 * the prompt composition logic by extracting it into testable parts.
 *
 * These tests verify the builder pattern and prompt construction
 * without requiring a conductor connection.
 */

interface VirtualSkillDefinition {
  name: string;
  description: string;
  body: string;
  tools?: SkillTool[];
}

describe("Plan prompt composition", () => {
  type DeferredSkill =
    | { type: "stored"; path: string }
    | { type: "virtual"; skill: { name: string; description: string; body: string; tools?: SkillTool[] } };

  // Helper class that exposes internal state for testing
  class TestableThinkBuilder {
    private _promptParts: string[] = [];
    private _tools: Map<string, { name: string; description: string; includeInPrompt: boolean }> = new Map();
    private _skills: DeferredSkill[] = [];

    text(content: string): this {
      this._promptParts.push(content);
      return this;
    }

    textln(content: string): this {
      this._promptParts.push(content + "\n");
      return this;
    }

    tool(name: string, description: string): this {
      this._tools.set(name, { name, description, includeInPrompt: true });
      return this;
    }

    defineTool(name: string, description: string): this {
      this._tools.set(name, { name, description, includeInPrompt: false });
      return this;
    }

    skill(pathOrDef: string | VirtualSkillDefinition): this {
      if (typeof pathOrDef === "string") {
        this._skills.push({ type: "stored", path: pathOrDef });
      } else {
        validateSkillName(pathOrDef.name);
        validateSkillDescription(pathOrDef.description);
        this._skills.push({
          type: "virtual",
          skill: {
            name: pathOrDef.name,
            description: pathOrDef.description,
            body: pathOrDef.body,
            tools: pathOrDef.tools,
          },
        });
      }
      return this;
    }

    async resolveSkills(): Promise<ResolvedSkill[]> {
      const resolved: ResolvedSkill[] = [];

      for (const deferred of this._skills) {
        if (deferred.type === "virtual") {
          resolved.push(deferred.skill);
        } else {
          const content = await readFile(deferred.path, "utf-8");
          const parsed = parseSkillMd(content);
          const stored: StoredSkill = {
            name: parsed.name,
            description: parsed.description,
            body: parsed.body,
            basePath: dirname(deferred.path),
          };
          resolved.push(stored);
        }
      }

      return resolved;
    }

    buildSkillsPrompt(skills: ResolvedSkill[]): string {
      if (skills.length === 0) return "";

      let xml = "<available_skills>\n";
      for (const skill of skills) {
        xml += `  <skill>\n`;
        xml += `    <name>${skill.name}</name>\n`;
        xml += `    <description>${skill.description}</description>\n`;
        xml += `  </skill>\n`;
      }
      xml += "</available_skills>\n";

      xml += "\n";
      xml += "The above skills are available to you. When a task matches a skill's description,\n";
      xml += "call the `activate_skill` tool with the skill name to load its full instructions.\n";
      xml += "If the skill provides tools, use `call_skill_tool` to invoke them.\n";
      xml += "If the skill references files, use `read_skill_file` to access them.\n";

      return xml + "\n";
    }

    buildPrompt(resolvedSkills: ResolvedSkill[] = []): string {
      let prompt = this.buildSkillsPrompt(resolvedSkills) + this._promptParts.join("");

      const toolsWithPrompt = Array.from(this._tools.values()).filter(
        (t) => t.includeInPrompt
      );
      if (toolsWithPrompt.length > 0) {
        prompt += "\n\nAvailable tools:\n";
        for (const tool of toolsWithPrompt) {
          prompt += `- ${tool.name}: ${tool.description}\n`;
        }
      }

      prompt += "\n\nWhen you have the final answer, call the return_result tool with your result.";
      return prompt;
    }

    getToolNames(): string[] {
      return Array.from(this._tools.keys());
    }

    getToolsForPrompt(): string[] {
      return Array.from(this._tools.values())
        .filter((t) => t.includeInPrompt)
        .map((t) => t.name);
    }

    getSkills(): DeferredSkill[] {
      return this._skills;
    }
  }

  describe("text()", () => {
    it("should add literal text to the prompt", () => {
      const builder = new TestableThinkBuilder()
        .text("Hello, ");

      const prompt = builder.buildPrompt();
      assert.ok(prompt.startsWith("Hello, "));
    });

    it("should chain multiple text calls", () => {
      const builder = new TestableThinkBuilder()
        .text("Hello, ")
        .text("world")
        .text("!");

      const prompt = builder.buildPrompt();
      assert.ok(prompt.startsWith("Hello, world!"));
    });
  });

  describe("textln()", () => {
    it("should add text with a newline", () => {
      const builder = new TestableThinkBuilder()
        .textln("Line 1")
        .textln("Line 2");

      const prompt = builder.buildPrompt();
      assert.ok(prompt.startsWith("Line 1\nLine 2\n"));
    });
  });

  describe("tool()", () => {
    it("should register a tool", () => {
      const builder = new TestableThinkBuilder()
        .tool("search", "Search for information");

      assert.deepStrictEqual(builder.getToolNames(), ["search"]);
    });

    it("should include tool in prompt", () => {
      const builder = new TestableThinkBuilder()
        .text("Please help me.")
        .tool("search", "Search for information");

      const prompt = builder.buildPrompt();
      assert.ok(prompt.includes("Available tools:"));
      assert.ok(prompt.includes("- search: Search for information"));
    });

    it("should register multiple tools", () => {
      const builder = new TestableThinkBuilder()
        .tool("search", "Search")
        .tool("write", "Write file")
        .tool("read", "Read file");

      assert.deepStrictEqual(builder.getToolNames(), ["search", "write", "read"]);
    });

    it("should list all tools in prompt", () => {
      const builder = new TestableThinkBuilder()
        .tool("tool1", "Description 1")
        .tool("tool2", "Description 2");

      const prompt = builder.buildPrompt();
      assert.ok(prompt.includes("- tool1: Description 1"));
      assert.ok(prompt.includes("- tool2: Description 2"));
    });
  });

  describe("defineTool()", () => {
    it("should register a tool without prompt reference", () => {
      const builder = new TestableThinkBuilder()
        .defineTool("hidden", "Hidden tool");

      assert.deepStrictEqual(builder.getToolNames(), ["hidden"]);
      assert.deepStrictEqual(builder.getToolsForPrompt(), []);
    });

    it("should not include defineTool tools in prompt", () => {
      const builder = new TestableThinkBuilder()
        .text("Do something.")
        .defineTool("background", "Background operation");

      const prompt = builder.buildPrompt();
      assert.ok(!prompt.includes("Available tools:"));
      assert.ok(!prompt.includes("background"));
    });

    it("should mix tool() and defineTool() correctly", () => {
      const builder = new TestableThinkBuilder()
        .tool("visible", "Visible tool")
        .defineTool("hidden", "Hidden tool")
        .tool("also_visible", "Also visible");

      assert.deepStrictEqual(builder.getToolNames(), ["visible", "hidden", "also_visible"]);
      assert.deepStrictEqual(builder.getToolsForPrompt(), ["visible", "also_visible"]);

      const prompt = builder.buildPrompt();
      assert.ok(prompt.includes("- visible: Visible tool"));
      assert.ok(prompt.includes("- also_visible: Also visible"));
      assert.ok(!prompt.includes("hidden"));
    });
  });

  describe("prompt structure", () => {
    it("should always include return_result instruction", () => {
      const builder = new TestableThinkBuilder()
        .text("Simple prompt");

      const prompt = builder.buildPrompt();
      assert.ok(prompt.includes("call the return_result tool"));
    });

    it("should build a complete prompt with all parts", () => {
      const builder = new TestableThinkBuilder()
        .textln("# Task")
        .text("Process this data: [1, 2, 3]")
        .tool("process", "Process the items")
        .tool("validate", "Validate results");

      const prompt = builder.buildPrompt();

      // Check structure
      assert.ok(prompt.startsWith("# Task\n"));
      assert.ok(prompt.includes("Process this data:"));
      assert.ok(prompt.includes("Available tools:"));
      assert.ok(prompt.includes("- process: Process the items"));
      assert.ok(prompt.includes("- validate: Validate results"));
      assert.ok(prompt.includes("return_result"));
    });
  });

  describe("chaining", () => {
    it("should support method chaining", () => {
      const builder = new TestableThinkBuilder()
        .text("A")
        .textln("B")
        .text("C")
        .tool("d", "D")
        .defineTool("e", "E")
        .text("F");

      // Just verify it doesn't throw and has expected tools
      assert.deepStrictEqual(builder.getToolNames(), ["d", "e"]);
    });
  });

  describe("skill()", () => {
    it("should accept a string path as a deferred stored skill", () => {
      const builder = new TestableThinkBuilder()
        .skill("/path/to/SKILL.md");

      const skills = builder.getSkills();
      assert.strictEqual(skills.length, 1);
      assert.deepStrictEqual(skills[0], { type: "stored", path: "/path/to/SKILL.md" });
    });

    it("should accept a virtual skill definition object", () => {
      const builder = new TestableThinkBuilder()
        .skill({
          name: "my-skill",
          description: "A test skill",
          body: "# Instructions\nDo the thing.",
        });

      const skills = builder.getSkills();
      assert.strictEqual(skills.length, 1);
      assert.strictEqual(skills[0].type, "virtual");
      const vs = skills[0] as { type: "virtual"; skill: { name: string; description: string; body: string } };
      assert.strictEqual(vs.skill.name, "my-skill");
      assert.strictEqual(vs.skill.description, "A test skill");
      assert.strictEqual(vs.skill.body, "# Instructions\nDo the thing.");
    });

    it("should validate virtual skill name eagerly", () => {
      const builder = new TestableThinkBuilder();
      assert.throws(
        () => builder.skill({ name: "INVALID", description: "A skill", body: "body" }),
        /Invalid skill name/
      );
    });

    it("should validate virtual skill description eagerly", () => {
      const builder = new TestableThinkBuilder();
      assert.throws(
        () => builder.skill({ name: "valid-name", description: "", body: "body" }),
        /Skill description is required/
      );
    });

    it("should not validate stored skill paths eagerly", () => {
      // Even a nonsensical path is accepted -- parsing is deferred to run()
      const builder = new TestableThinkBuilder()
        .skill("nonexistent/path/SKILL.md");

      assert.strictEqual(builder.getSkills().length, 1);
    });

    it("should preserve attachment order", () => {
      const builder = new TestableThinkBuilder()
        .skill("/path/to/first/SKILL.md")
        .skill({ name: "second", description: "Second skill", body: "body2" })
        .skill("/path/to/third/SKILL.md");

      const skills = builder.getSkills();
      assert.strictEqual(skills.length, 3);
      assert.strictEqual(skills[0].type, "stored");
      assert.strictEqual(skills[1].type, "virtual");
      assert.strictEqual(skills[2].type, "stored");
    });

    it("should accept virtual skills with tools", () => {
      const builder = new TestableThinkBuilder()
        .skill({
          name: "with-tools",
          description: "Skill with tools",
          body: "Use the greet tool",
          tools: [{ name: "greet", description: "Say hello", handler: async () => "hi" }],
        });

      const skills = builder.getSkills();
      assert.strictEqual(skills.length, 1);
      const vs = skills[0] as { type: "virtual"; skill: { tools?: unknown[] } };
      assert.strictEqual(vs.skill.tools?.length, 1);
    });

    it("should chain with other builder methods", () => {
      const builder = new TestableThinkBuilder()
        .text("Prompt text")
        .skill({ name: "my-skill", description: "A skill", body: "body" })
        .tool("my-tool", "A tool");

      assert.strictEqual(builder.getSkills().length, 1);
      assert.deepStrictEqual(builder.getToolNames(), ["my-tool"]);
    });
  });

  describe("skill prompt assembly", () => {
    it("should produce empty string when no skills are present", () => {
      const builder = new TestableThinkBuilder();
      const skillsPrompt = builder.buildSkillsPrompt([]);
      assert.strictEqual(skillsPrompt, "");
    });

    it("should build available_skills XML block for a single skill", () => {
      const builder = new TestableThinkBuilder();
      const skills: ResolvedSkill[] = [
        { name: "code-review", description: "Reviews code for bugs.", body: "# Instructions" },
      ];
      const skillsPrompt = builder.buildSkillsPrompt(skills);

      assert.ok(skillsPrompt.includes("<available_skills>"));
      assert.ok(skillsPrompt.includes("</available_skills>"));
      assert.ok(skillsPrompt.includes("<name>code-review</name>"));
      assert.ok(skillsPrompt.includes("<description>Reviews code for bugs.</description>"));
      assert.ok(skillsPrompt.includes("activate_skill"));
    });

    it("should list multiple skills in attachment order", () => {
      const builder = new TestableThinkBuilder();
      const skills: ResolvedSkill[] = [
        { name: "first-skill", description: "First.", body: "body1" },
        { name: "second-skill", description: "Second.", body: "body2" },
        { name: "third-skill", description: "Third.", body: "body3" },
      ];
      const skillsPrompt = builder.buildSkillsPrompt(skills);

      const firstIdx = skillsPrompt.indexOf("<name>first-skill</name>");
      const secondIdx = skillsPrompt.indexOf("<name>second-skill</name>");
      const thirdIdx = skillsPrompt.indexOf("<name>third-skill</name>");

      assert.ok(firstIdx < secondIdx, "first-skill should appear before second-skill");
      assert.ok(secondIdx < thirdIdx, "second-skill should appear before third-skill");
    });

    it("should include infrastructure instructions", () => {
      const builder = new TestableThinkBuilder();
      const skills: ResolvedSkill[] = [
        { name: "test-skill", description: "A test.", body: "body" },
      ];
      const skillsPrompt = builder.buildSkillsPrompt(skills);

      assert.ok(skillsPrompt.includes("call the `activate_skill` tool"));
      assert.ok(skillsPrompt.includes("`call_skill_tool`"));
      assert.ok(skillsPrompt.includes("`read_skill_file`"));
    });

    it("should prepend skills block before user prompt parts", () => {
      const builder = new TestableThinkBuilder()
        .text("User prompt here.");

      const skills: ResolvedSkill[] = [
        { name: "my-skill", description: "My skill.", body: "body" },
      ];
      const prompt = builder.buildPrompt(skills);

      const skillsEnd = prompt.indexOf("User prompt here.");
      const xmlStart = prompt.indexOf("<available_skills>");
      assert.ok(xmlStart >= 0, "should contain <available_skills>");
      assert.ok(xmlStart < skillsEnd, "skills block should come before user prompt");
    });

    it("should not include skill body in prompt (progressive disclosure)", () => {
      const builder = new TestableThinkBuilder();
      const skills: ResolvedSkill[] = [
        { name: "my-skill", description: "A skill.", body: "SECRET INSTRUCTIONS HERE" },
      ];
      const skillsPrompt = builder.buildSkillsPrompt(skills);

      assert.ok(!skillsPrompt.includes("SECRET INSTRUCTIONS HERE"));
    });

    it("should produce no skills block when buildPrompt called without skills", () => {
      const builder = new TestableThinkBuilder()
        .text("Just a prompt.");

      const prompt = builder.buildPrompt();
      assert.ok(!prompt.includes("<available_skills>"));
      assert.ok(prompt.startsWith("Just a prompt."));
    });
  });

  describe("stored skill resolution", () => {
    let tmpDir: string;

    async function createTmpDir(): Promise<string> {
      const dir = join(tmpdir(), `thinkwell-test-${randomUUID()}`);
      await mkdir(dir, { recursive: true });
      return dir;
    }

    it("should resolve a stored skill from a SKILL.md file", async () => {
      tmpDir = await createTmpDir();
      const skillPath = join(tmpDir, "SKILL.md");
      await writeFile(skillPath, [
        "---",
        "name: file-skill",
        "description: A skill loaded from disk.",
        "---",
        "",
        "# Instructions",
        "Do the thing from disk.",
      ].join("\n"));

      const builder = new TestableThinkBuilder().skill(skillPath);
      const resolved = await builder.resolveSkills();

      assert.strictEqual(resolved.length, 1);
      assert.strictEqual(resolved[0].name, "file-skill");
      assert.strictEqual(resolved[0].description, "A skill loaded from disk.");
      assert.ok(resolved[0].body.includes("Do the thing from disk."));
      assert.strictEqual((resolved[0] as StoredSkill).basePath, tmpDir);

      await rm(tmpDir, { recursive: true });
    });

    it("should resolve virtual skills without filesystem access", async () => {
      const builder = new TestableThinkBuilder()
        .skill({ name: "virtual-one", description: "Virtual.", body: "Virtual body" });

      const resolved = await builder.resolveSkills();

      assert.strictEqual(resolved.length, 1);
      assert.strictEqual(resolved[0].name, "virtual-one");
      assert.strictEqual(resolved[0].body, "Virtual body");
      assert.ok(!("basePath" in resolved[0]));
    });

    it("should preserve attachment order across mixed skill types", async () => {
      tmpDir = await createTmpDir();
      const skillPath = join(tmpDir, "SKILL.md");
      await writeFile(skillPath, [
        "---",
        "name: stored-skill",
        "description: From disk.",
        "---",
        "",
        "Stored body.",
      ].join("\n"));

      const builder = new TestableThinkBuilder()
        .skill({ name: "first-virtual", description: "First.", body: "body1" })
        .skill(skillPath)
        .skill({ name: "last-virtual", description: "Last.", body: "body3" });

      const resolved = await builder.resolveSkills();

      assert.strictEqual(resolved.length, 3);
      assert.strictEqual(resolved[0].name, "first-virtual");
      assert.strictEqual(resolved[1].name, "stored-skill");
      assert.strictEqual(resolved[2].name, "last-virtual");

      await rm(tmpDir, { recursive: true });
    });

    it("should throw when stored skill path does not exist", async () => {
      const builder = new TestableThinkBuilder()
        .skill("/nonexistent/path/SKILL.md");

      await assert.rejects(
        () => builder.resolveSkills(),
        /ENOENT/
      );
    });

    it("should throw when stored SKILL.md has invalid frontmatter", async () => {
      tmpDir = await createTmpDir();
      const skillPath = join(tmpDir, "SKILL.md");
      await writeFile(skillPath, "No frontmatter here, just plain text.");

      const builder = new TestableThinkBuilder().skill(skillPath);

      await assert.rejects(
        () => builder.resolveSkills(),
        /SKILL\.md must begin with YAML frontmatter/
      );

      await rm(tmpDir, { recursive: true });
    });
  });

  describe("skill MCP server registration", () => {
    it("should create a skill server with correct name and acpUrl when skills are present", () => {
      const skills: ResolvedSkill[] = [
        { name: "my-skill", description: "A skill.", body: "Instructions." },
      ];
      const skillServer = createSkillServer(skills);

      assert.strictEqual(skillServer.name, "skills");
      assert.ok(skillServer.acpUrl.startsWith("acp:"), "acpUrl should start with acp:");
    });

    it("should create a skill server that exposes all three tools", () => {
      const skills: ResolvedSkill[] = [
        { name: "test-skill", description: "Test.", body: "body" },
      ];
      const skillServer = createSkillServer(skills);
      const tools = skillServer.getToolDefinitions();

      const names = tools.map((t) => t.name);
      assert.ok(names.includes("activate_skill"));
      assert.ok(names.includes("call_skill_tool"));
      assert.ok(names.includes("read_skill_file"));
    });

    it("should produce a server that can be formatted for session mcpServers array", () => {
      const skills: ResolvedSkill[] = [
        { name: "my-skill", description: "A skill.", body: "body" },
      ];
      const skillServer = createSkillServer(skills);

      // Verify the server has the properties needed for the AcpMcpServer entry
      const entry = {
        type: "http" as const,
        name: skillServer.name,
        url: skillServer.acpUrl,
        headers: [],
      };
      assert.strictEqual(entry.type, "http");
      assert.strictEqual(entry.name, "skills");
      assert.ok(entry.url.startsWith("acp:"));
    });

    it("should not create a skill server when no skills are present", () => {
      // Mirrors the conditional logic in _executeRun:
      // const skillServer = resolvedSkills.length > 0 ? createSkillServer(resolvedSkills) : undefined;
      const resolvedSkills: ResolvedSkill[] = [];
      const skillServer = resolvedSkills.length > 0
        ? createSkillServer(resolvedSkills)
        : undefined;

      assert.strictEqual(skillServer, undefined);
    });

    it("should include both virtual and stored skills in a single server", async () => {
      const tmpDir = join(tmpdir(), `thinkwell-test-${randomUUID()}`);
      await mkdir(tmpDir, { recursive: true });
      const skillPath = join(tmpDir, "SKILL.md");
      await writeFile(skillPath, [
        "---",
        "name: stored-skill",
        "description: From disk.",
        "---",
        "",
        "Stored body.",
      ].join("\n"));

      // Resolve skills manually (same logic as TestableThinkBuilder.resolveSkills)
      const content = await readFile(skillPath, "utf-8");
      const parsed = parseSkillMd(content);
      const storedSkill: StoredSkill = {
        name: parsed.name,
        description: parsed.description,
        body: parsed.body,
        basePath: dirname(skillPath),
      };

      const virtualSkill: VirtualSkill = {
        name: "virtual-skill",
        description: "Virtual.",
        body: "Virtual body.",
        tools: [{ name: "greet", description: "Say hi", handler: async () => "hi" }],
      };

      const skillServer = createSkillServer([virtualSkill, storedSkill]);

      // Both skills should be accessible via activate_skill
      const ctx = { connectionId: "c1", sessionId: "s1" };
      const result1 = await skillServer.handleMethod("tools/call", {
        name: "activate_skill",
        arguments: { skill_name: "virtual-skill" },
      }, ctx) as { content: { text: string }[] };
      assert.strictEqual(result1.content[0].text, "Virtual body.");

      const result2 = await skillServer.handleMethod("tools/call", {
        name: "activate_skill",
        arguments: { skill_name: "stored-skill" },
      }, ctx) as { content: { text: string }[] };
      assert.ok(result2.content[0].text.includes("Stored body."));

      await rm(tmpDir, { recursive: true });
    });
  });
});
