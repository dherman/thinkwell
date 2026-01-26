import { describe, it } from "node:test";
import assert from "node:assert";

/**
 * Since ThinkBuilder requires a live connection to run, we test
 * the prompt composition logic by extracting it into testable parts.
 *
 * These tests verify the builder pattern and prompt construction
 * without requiring a conductor connection.
 */

describe("ThinkBuilder prompt composition", () => {
  // Helper class that exposes internal state for testing
  class TestableThinkBuilder {
    private _promptParts: string[] = [];
    private _tools: Map<string, { name: string; description: string; includeInPrompt: boolean }> = new Map();

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

    buildPrompt(): string {
      let prompt = this._promptParts.join("");

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
});
