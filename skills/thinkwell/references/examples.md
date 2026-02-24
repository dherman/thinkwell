# Thinkwell Examples

Complete working examples demonstrating common Thinkwell patterns.

## Example 1: Simple Summarization (Prompt-Only)

No tools needed — just structured output from a prompt.

```typescript
#!/usr/bin/env thinkwell

import { open } from "thinkwell";
import * as fs from "fs/promises";

/**
 * A summary of content.
 * @JSONSchema
 */
export interface Summary {
  /** A brief title for the summary */
  title: string;
  /** Key points from the content */
  points: string[];
  /**
   * Approximate word count of the original content
   * @minimum 0
   */
  wordCount: number;
}

async function main() {
  const agent = await open('claude');

  try {
    const content = await fs.readFile("sample.txt", "utf-8");

    const summary = await agent
      .think(Summary.Schema)
      .text("Please summarize the following content:\n\n")
      .quote(content)
      .run();

    console.log(`Title: ${summary.title}`);
    console.log(`Word Count: ${summary.wordCount}`);
    console.log("Points:");
    for (const point of summary.points) {
      console.log(`  - ${point}`);
    }
  } finally {
    await agent.close();
  }
}

main();
```

**Key patterns:**
- `@JSONSchema` on an interface with JSDoc property descriptions
- `.text()` + `.quote()` to compose the prompt
- `.run()` returns a typed `Summary` object
- `try/finally` to ensure `agent.close()` is called

## Example 2: Greeting with Tool and Streaming

A tool provides runtime data; streaming shows the agent's thought process.

```typescript
#!/usr/bin/env thinkwell

import { open } from "thinkwell";

/**
 * A friendly greeting.
 * @JSONSchema
 */
export interface Greeting {
  /** The greeting message */
  message: string;
}

async function main() {
  const agent = await open('claude');

  try {
    const thoughts = agent
      .think(Greeting.Schema)
      .text(`
        Use the current_time tool to get the current time, and create a
        friendly greeting message appropriate for that time of day.
      `)
      .tool(
        "current_time",
        "Produces the current date, time, and time zone.",
        async () => {
          const now = new Date();
          return {
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            time: now.toLocaleTimeString(),
            date: now.toLocaleDateString(),
            dayOfWeek: now.toLocaleDateString('en-US', { weekday: 'long' }),
          };
        }
      )
      .stream();

    for await (const thought of thoughts) {
      if (thought.type === 'message') {
        process.stdout.write(thought.text);
      }
    }

    const greeting = await thoughts.result;
    console.log(`\n✨ ${greeting.message}`);
  } finally {
    await agent.close();
  }
}

main();
```

**Key patterns:**
- `.tool(name, description, handler)` — simple form with no input schema
- `.stream()` returns a `ThoughtStream` — iterate events, then await `.result`
- Tool handler returns a plain object (serialized to JSON automatically)

## Example 3: Sentiment Analysis with Typed Tool Input

A tool with a typed input schema, powered by an npm package.

```typescript
#!/usr/bin/env thinkwell

import { open } from "thinkwell";
import * as fs from "fs/promises";
import Sentiment from "sentiment";

/**
 * A section of a document with its sentiment analysis.
 * @JSONSchema
 */
export interface DocumentSection {
  /** The section title */
  title: string;
  /** The sentiment score from the analysis tool */
  sentimentScore: number;
  /** A brief summary of the section */
  summary: string;
}

/**
 * Analysis of a document's sentiment and content.
 * @JSONSchema
 */
export interface DocumentAnalysis {
  /** The overall emotional tone of the document */
  overallTone: "positive" | "negative" | "mixed" | "neutral";
  /** Analysis of each section */
  sections: DocumentSection[];
  /** A recommendation based on the analysis */
  recommendation: string;
}

/**
 * A text passage to analyze.
 * @JSONSchema
 */
export interface TextPassage {
  /** The text passage to analyze */
  text: string;
}

const sentimentAnalyzer = new Sentiment();

async function main() {
  const agent = await open('claude');

  try {
    const feedback = await fs.readFile("feedback.txt", "utf-8");

    const analysis = await agent
      .think(DocumentAnalysis.Schema)
      .text(`
        Analyze the following customer feedback document.
        Use the sentiment analysis tool to measure the emotional tone
        of each section, then provide an overall analysis with
        recommendations.

      `)
      .quote(feedback, "feedback")

      .tool(
        "analyze_sentiment",
        "Analyze the sentiment of a text passage. Returns a score "
          + "(positive = good, negative = bad) and comparative score "
          + "normalized by length.",
        TextPassage.Schema,
        async (passage) => {
          const result = sentimentAnalyzer.analyze(passage.text);
          return {
            score: result.score,
            comparative: result.comparative,
            positive: result.positive,
            negative: result.negative,
          };
        }
      )

      .run();

    console.log(`Overall Tone: ${analysis.overallTone}`);
    for (const section of analysis.sections) {
      console.log(`  ${section.title} (score: ${section.sentimentScore})`);
      console.log(`    ${section.summary}`);
    }
    console.log(`Recommendation: ${analysis.recommendation}`);
  } finally {
    await agent.close();
  }
}

main();
```

**Key patterns:**
- Multiple `@JSONSchema` types in one file (output schema + tool input schema)
- `.tool(name, description, InputSchema.Schema, handler)` — typed input form
- `.quote(content, "feedback")` — tagged quote for clarity
- The `TextPassage.Schema` tells the agent how to format tool calls

## Example 4: Multi-Step Pipeline

A complex pipeline with sequential LLM calls and parallel batch processing.

```typescript
#!/usr/bin/env thinkwell

import { open } from "thinkwell";
import * as fs from "fs/promises";
import pLimit from "p-limit";
import _ from "lodash";

/** @JSONSchema */
export interface FunctionInfo {
  name: string;
  signature: string;
  lineNumber: number;
}

/** @JSONSchema */
export interface FunctionList {
  functions: FunctionInfo[];
}

/** @JSONSchema */
export interface FunctionAnalysis {
  originalName: string;
  suggestedName: string;
  purpose: string;
  confidence: "high" | "medium" | "low";
}

/** @JSONSchema */
export interface FunctionAnalysisBatch {
  analyses: FunctionAnalysis[];
}

/** @JSONSchema */
export interface RenamedCode {
  code: string;
  renameCount: number;
}

async function main() {
  const agent = await open('claude');

  try {
    const code = await fs.readFile("input.js", "utf-8");

    // Step 1: Extract function list
    const functionList = await agent
      .think(FunctionList.Schema)
      .text("Extract all function declarations from this code:")
      .code(code, "javascript")
      .run();

    // Step 2: Analyze functions in parallel batches
    const limit = pLimit(5);
    const batches = _.chunk(functionList.functions, 30);

    const results = await Promise.all(
      batches.map((batch) =>
        limit(async () => {
          const functionListText = batch
            .map((f) => `  - "${f.name}" (${f.signature})`)
            .join("\n");

          return agent
            .think(FunctionAnalysisBatch.Schema)
            .text(`Suggest better names for these minified functions:\n\n${functionListText}\n\nFull code:\n`)
            .code(code, "javascript")
            .run();
        })
      )
    );

    // Step 3: Apply renames
    const renames = results.flatMap(r => r.analyses)
      .filter(a => a.suggestedName !== a.originalName)
      .map(a => `  ${a.originalName} -> ${a.suggestedName}`)
      .join("\n");

    const renamed = await agent
      .think(RenamedCode.Schema)
      .text(`Apply these renames:\n\n${renames}\n\nCode:\n`)
      .code(code, "javascript")
      .run();

    await fs.writeFile("output.js", renamed.code);
    console.log(`Renamed ${renamed.renameCount} functions`);
  } finally {
    await agent.close();
  }
}

main();
```

**Key patterns:**
- Multiple `@JSONSchema` types for different pipeline stages
- Sequential LLM calls (each uses the result of the previous)
- Parallel batch processing with `p-limit` for concurrency control
- Connection reuse — same `agent` across all calls
- `.code(content, language)` for source code in prompts

## Example 5: Multi-Turn Session

Using sessions for conversations where context carries over.

```typescript
#!/usr/bin/env thinkwell

import { open } from "thinkwell";

/** @JSONSchema */
export interface Analysis {
  issues: Array<{
    file: string;
    line: number;
    description: string;
    severity: "low" | "medium" | "high";
  }>;
  summary: string;
}

/** @JSONSchema */
export interface FixSuggestions {
  fixes: Array<{
    file: string;
    description: string;
    code: string;
  }>;
}

async function main() {
  const agent = await open('claude');

  try {
    const session = await agent.createSession({ cwd: "/my/project" });

    // First turn: analyze
    const analysis = await session
      .think(Analysis.Schema)
      .text("Analyze the TypeScript files in this project for potential issues.")
      .tool(
        "read_file",
        "Read a file from the project.",
        async (input: any) => {
          const fs = await import("fs/promises");
          return { content: await fs.readFile(input.path, "utf-8") };
        }
      )
      .run();

    console.log(`Found ${analysis.issues.length} issues`);

    // Second turn: the agent remembers the analysis
    const fixes = await session
      .think(FixSuggestions.Schema)
      .text("Suggest fixes for the highest-severity issues you found.")
      .run();

    for (const fix of fixes.fixes) {
      console.log(`Fix for ${fix.file}: ${fix.description}`);
    }

    session.close();
  } finally {
    await agent.close();
  }
}

main();
```

**Key patterns:**
- `agent.createSession()` creates a persistent context
- `session.think()` instead of `agent.think()`
- Second call has no tools — the agent uses context from the first turn
- `session.close()` before `agent.close()`

## Example 6: Using schemaOf() for Inline Schemas

When you don't want to define a named type:

```typescript
import { open, schemaOf } from "thinkwell";

async function main() {
  const agent = await open('claude');

  try {
    const result = await agent
      .think(schemaOf<{ answer: number; explanation: string }>({
        type: "object",
        properties: {
          answer: { type: "number", description: "The numeric answer" },
          explanation: { type: "string", description: "Step-by-step reasoning" }
        },
        required: ["answer", "explanation"]
      }))
      .text("What is the sum of the first 100 prime numbers?")
      .run();

    console.log(`Answer: ${result.answer}`);
    console.log(`Explanation: ${result.explanation}`);
  } finally {
    await agent.close();
  }
}

main();
```

**Key patterns:**
- `schemaOf<T>(jsonSchema)` wraps a raw JSON Schema object
- The type parameter `T` provides TypeScript typing for the result
- Useful for one-off schemas or dynamically constructed schemas
