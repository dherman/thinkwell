import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSkillServer } from "./skill-server.js";
import type { ResolvedSkill } from "./skill-server.js";
import type { VirtualSkill, StoredSkill } from "./skill.js";
import type { McpContext } from "./types.js";

const ctx: McpContext = { connectionId: "conn-1", sessionId: "session-1" };

function callTool(server: ReturnType<typeof createSkillServer>, toolName: string, args: unknown) {
  return server.handleMethod("tools/call", { name: toolName, arguments: args }, ctx) as Promise<{
    content: { type: string; text: string }[];
    isError?: boolean;
  }>;
}

describe("createSkillServer", () => {
  describe("activate_skill", () => {
    it("should return skill body for a known skill", async () => {
      const skills: ResolvedSkill[] = [
        { name: "code-review", description: "Reviews code.", body: "# Code Review\n\nReview the code." },
      ];
      const server = createSkillServer(skills);

      const result = await callTool(server, "activate_skill", { skill_name: "code-review" });

      assert.strictEqual(result.isError, undefined);
      assert.strictEqual(result.content[0].text, "# Code Review\n\nReview the code.");
    });

    it("should return error for unknown skill", async () => {
      const server = createSkillServer([]);

      const result = await callTool(server, "activate_skill", { skill_name: "nonexistent" });

      assert.strictEqual(result.isError, true);
      assert.ok(result.content[0].text.includes('Unknown skill: "nonexistent"'));
    });

    it("should handle multiple skills and return the correct one", async () => {
      const skills: ResolvedSkill[] = [
        { name: "skill-a", description: "First.", body: "Body A" },
        { name: "skill-b", description: "Second.", body: "Body B" },
      ];
      const server = createSkillServer(skills);

      const resultA = await callTool(server, "activate_skill", { skill_name: "skill-a" });
      const resultB = await callTool(server, "activate_skill", { skill_name: "skill-b" });

      assert.strictEqual(resultA.content[0].text, "Body A");
      assert.strictEqual(resultB.content[0].text, "Body B");
    });
  });

  describe("call_skill_tool", () => {
    it("should call a virtual skill tool and return the result", async () => {
      const skill: VirtualSkill = {
        name: "math",
        description: "Math tools.",
        body: "Provides math operations.",
        tools: [
          {
            name: "add",
            description: "Add two numbers",
            handler: async (input: unknown) => {
              const { a, b } = input as { a: number; b: number };
              return { sum: a + b };
            },
          },
        ],
      };
      const server = createSkillServer([skill]);

      const result = await callTool(server, "call_skill_tool", {
        skill_name: "math",
        tool_name: "add",
        input: { a: 3, b: 4 },
      });

      assert.strictEqual(result.isError, undefined);
      assert.strictEqual(result.content[0].text, JSON.stringify({ sum: 7 }));
    });

    it("should return error for unknown skill", async () => {
      const server = createSkillServer([]);

      const result = await callTool(server, "call_skill_tool", {
        skill_name: "nonexistent",
        tool_name: "anything",
      });

      assert.strictEqual(result.isError, true);
      assert.ok(result.content[0].text.includes('Unknown skill: "nonexistent"'));
    });

    it("should return error for unknown tool on a known skill", async () => {
      const skill: VirtualSkill = {
        name: "math",
        description: "Math tools.",
        body: "Provides math operations.",
        tools: [
          { name: "add", description: "Add", handler: async () => 0 },
        ],
      };
      const server = createSkillServer([skill]);

      const result = await callTool(server, "call_skill_tool", {
        skill_name: "math",
        tool_name: "subtract",
      });

      assert.strictEqual(result.isError, true);
      assert.ok(result.content[0].text.includes('Unknown tool "subtract"'));
    });

    it("should return error when skill has no tools", async () => {
      const skill: ResolvedSkill = {
        name: "no-tools",
        description: "No tools.",
        body: "Instructions only.",
      };
      const server = createSkillServer([skill]);

      const result = await callTool(server, "call_skill_tool", {
        skill_name: "no-tools",
        tool_name: "anything",
      });

      assert.strictEqual(result.isError, true);
      assert.ok(result.content[0].text.includes("has no tools"));
    });

    it("should pass undefined input when input is omitted", async () => {
      let receivedInput: unknown = "sentinel";
      const skill: VirtualSkill = {
        name: "capture",
        description: "Captures input.",
        body: "Test skill.",
        tools: [
          {
            name: "check",
            description: "Check input",
            handler: async (input: unknown) => {
              receivedInput = input;
              return "ok";
            },
          },
        ],
      };
      const server = createSkillServer([skill]);

      await callTool(server, "call_skill_tool", {
        skill_name: "capture",
        tool_name: "check",
      });

      assert.strictEqual(receivedInput, undefined);
    });
  });

  describe("read_skill_file", () => {
    let tmpDir: string;

    before(async () => {
      tmpDir = join(tmpdir(), `skill-server-test-${Date.now()}`);
      await mkdir(tmpDir, { recursive: true });
      await mkdir(join(tmpDir, "docs"), { recursive: true });
      await writeFile(join(tmpDir, "readme.txt"), "Hello from readme");
      await writeFile(join(tmpDir, "docs", "guide.md"), "# Guide\n\nA guide.");
    });

    after(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    it("should read a file from a stored skill's basePath", async () => {
      const skill: StoredSkill = {
        name: "my-skill",
        description: "A skill.",
        body: "Instructions.",
        basePath: tmpDir,
      };
      const server = createSkillServer([skill]);

      const result = await callTool(server, "read_skill_file", {
        skill_name: "my-skill",
        path: "readme.txt",
      });

      assert.strictEqual(result.isError, undefined);
      assert.strictEqual(result.content[0].text, "Hello from readme");
    });

    it("should read a file in a subdirectory", async () => {
      const skill: StoredSkill = {
        name: "my-skill",
        description: "A skill.",
        body: "Instructions.",
        basePath: tmpDir,
      };
      const server = createSkillServer([skill]);

      const result = await callTool(server, "read_skill_file", {
        skill_name: "my-skill",
        path: "docs/guide.md",
      });

      assert.strictEqual(result.isError, undefined);
      assert.strictEqual(result.content[0].text, "# Guide\n\nA guide.");
    });

    it("should return error for unknown skill", async () => {
      const server = createSkillServer([]);

      const result = await callTool(server, "read_skill_file", {
        skill_name: "nonexistent",
        path: "readme.txt",
      });

      assert.strictEqual(result.isError, true);
      assert.ok(result.content[0].text.includes('Unknown skill: "nonexistent"'));
    });

    it("should return error for non-stored skill", async () => {
      const skill: ResolvedSkill = {
        name: "virtual",
        description: "Virtual skill.",
        body: "No basePath.",
      };
      const server = createSkillServer([skill]);

      const result = await callTool(server, "read_skill_file", {
        skill_name: "virtual",
        path: "readme.txt",
      });

      assert.strictEqual(result.isError, true);
      assert.ok(result.content[0].text.includes("not a stored skill"));
    });

    it("should reject path traversal with ..", async () => {
      const skill: StoredSkill = {
        name: "my-skill",
        description: "A skill.",
        body: "Instructions.",
        basePath: tmpDir,
      };
      const server = createSkillServer([skill]);

      const result = await callTool(server, "read_skill_file", {
        skill_name: "my-skill",
        path: "../../../etc/passwd",
      });

      assert.strictEqual(result.isError, true);
      assert.ok(result.content[0].text.includes("Path traversal is not allowed"));
    });

    it("should reject absolute paths", async () => {
      const skill: StoredSkill = {
        name: "my-skill",
        description: "A skill.",
        body: "Instructions.",
        basePath: tmpDir,
      };
      const server = createSkillServer([skill]);

      const result = await callTool(server, "read_skill_file", {
        skill_name: "my-skill",
        path: "/etc/passwd",
      });

      assert.strictEqual(result.isError, true);
      assert.ok(result.content[0].text.includes("Path must be relative"));
    });

    it("should return error for nonexistent file", async () => {
      const skill: StoredSkill = {
        name: "my-skill",
        description: "A skill.",
        body: "Instructions.",
        basePath: tmpDir,
      };
      const server = createSkillServer([skill]);

      const result = await callTool(server, "read_skill_file", {
        skill_name: "my-skill",
        path: "does-not-exist.txt",
      });

      assert.strictEqual(result.isError, true);
      assert.ok(result.content[0].text.includes("Tool error"));
    });
  });

  describe("tool registration", () => {
    it("should register all three tools", () => {
      const server = createSkillServer([]);
      const tools = server.getToolDefinitions();

      assert.strictEqual(tools.length, 3);
      const names = tools.map((t) => t.name);
      assert.ok(names.includes("activate_skill"));
      assert.ok(names.includes("call_skill_tool"));
      assert.ok(names.includes("read_skill_file"));
    });
  });
});
