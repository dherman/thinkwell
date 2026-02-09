/**
 * Skill MCP server builder.
 *
 * Creates an MCP server that exposes three tools for skill interaction:
 * - activate_skill: returns a skill's instruction body
 * - call_skill_tool: dispatches to a virtual skill's tool handler
 * - read_skill_file: reads a file from a stored skill's basePath
 *
 * These tools are registered as standard MCP tools but are intended to be
 * hidden from the prompt (via ThinkBuilder's defineTool pattern).
 */

import { readFile } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import { mcpServer } from "./mcp-server.js";
import type { McpServer } from "./mcp-server.js";
import type { VirtualSkill, StoredSkill } from "./skill.js";

/** A resolved skill is either a VirtualSkill or a StoredSkill. */
export type ResolvedSkill = VirtualSkill | StoredSkill;

/** Type guard for StoredSkill (has basePath). */
function isStoredSkill(skill: ResolvedSkill): skill is StoredSkill {
  return "basePath" in skill && typeof (skill as StoredSkill).basePath === "string";
}

/**
 * Build an MCP server that provides skill tools.
 *
 * @param skills - resolved skills (virtual or stored) to make available
 * @returns an McpServer with activate_skill, call_skill_tool, and read_skill_file tools
 */
export function createSkillServer(skills: ResolvedSkill[]): McpServer {
  const skillsByName = new Map<string, ResolvedSkill>();
  for (const skill of skills) {
    skillsByName.set(skill.name, skill);
  }

  return mcpServer("skills")
    .tool<{ skill_name: string }, string>(
      "activate_skill",
      "Activate a skill by name, returning its full instructions.",
      {
        type: "object",
        properties: {
          skill_name: { type: "string", description: "The name of the skill to activate" },
        },
        required: ["skill_name"],
      },
      { type: "string" },
      async (input) => {
        const skill = skillsByName.get(input.skill_name);
        if (!skill) {
          throw new Error(`Unknown skill: "${input.skill_name}"`);
        }
        return skill.body;
      }
    )
    .tool<{ skill_name: string; tool_name: string; input?: unknown }, unknown>(
      "call_skill_tool",
      "Call a tool provided by a skill.",
      {
        type: "object",
        properties: {
          skill_name: { type: "string", description: "The name of the skill that provides the tool" },
          tool_name: { type: "string", description: "The name of the tool to call" },
          input: { description: "Input to pass to the tool handler" },
        },
        required: ["skill_name", "tool_name"],
      },
      {},
      async (input) => {
        const skill = skillsByName.get(input.skill_name);
        if (!skill) {
          throw new Error(`Unknown skill: "${input.skill_name}"`);
        }

        const tools = (skill as VirtualSkill).tools;
        if (!tools || tools.length === 0) {
          throw new Error(`Skill "${input.skill_name}" has no tools`);
        }

        const tool = tools.find((t) => t.name === input.tool_name);
        if (!tool) {
          throw new Error(
            `Unknown tool "${input.tool_name}" for skill "${input.skill_name}"`
          );
        }

        return tool.handler(input.input);
      }
    )
    .tool<{ skill_name: string; path: string }, string>(
      "read_skill_file",
      "Read a file from a stored skill's directory.",
      {
        type: "object",
        properties: {
          skill_name: { type: "string", description: "The name of the skill" },
          path: { type: "string", description: "Relative path to the file within the skill directory" },
        },
        required: ["skill_name", "path"],
      },
      { type: "string" },
      async (input) => {
        const skill = skillsByName.get(input.skill_name);
        if (!skill) {
          throw new Error(`Unknown skill: "${input.skill_name}"`);
        }

        if (!isStoredSkill(skill)) {
          throw new Error(`Skill "${input.skill_name}" is not a stored skill (no basePath)`);
        }

        // Reject absolute paths outright
        if (isAbsolute(input.path)) {
          throw new Error("Path must be relative");
        }

        const resolved = resolve(skill.basePath, input.path);

        // Path traversal check: resolved path must be within basePath
        const rel = relative(skill.basePath, resolved);
        if (rel.startsWith("..") || isAbsolute(rel)) {
          throw new Error("Path traversal is not allowed");
        }

        return readFile(resolved, "utf-8");
      }
    )
    .build();
}
