/**
 * Example: Document Analysis with Custom Tool
 *
 * This example demonstrates using a custom tool with the LLM.
 * The sentiment analysis tool wraps the `sentiment` npm package,
 * allowing the LLM to analyze the emotional tone of text passages.
 *
 * Run with: thinkwell src/sentiment.ts
 */

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

// Initialize the sentiment analyzer (from the `sentiment` npm package)
const sentimentAnalyzer = new Sentiment();

async function main() {
  const agent = await open('claude');

  try {
    console.log("=== Document Analysis with Sentiment Tool ===\n");

    const feedback = await fs.readFile(
      new URL("feedback.txt", import.meta.url),
      "utf-8"
    );

    console.log("Analyzing customer feedback with sentiment tool...\n");

    const analysis = await agent
      .think(DocumentAnalysis.Schema)
      .text(`
        Analyze the following customer feedback document.
        Use the sentiment analysis tool to measure the emotional tone of each section,
        then provide an overall analysis with recommendations.

      `)
      .quote(feedback, "feedback")

      // Custom tool: wraps the `sentiment` npm package as an MCP tool
      .tool(
        "analyze_sentiment",
        "Analyze the sentiment of a text passage. Returns a score (positive = good, negative = bad) and comparative score normalized by length.",
        TextPassage.Schema,
        async (passage) => {
          const result = sentimentAnalyzer.analyze(passage.text);
          console.log(
            `  Sentiment: score=${result.score}, comparative=${result.comparative.toFixed(3)}`
          );
          return {
            score: result.score,
            comparative: result.comparative,
            positive: result.positive,
            negative: result.negative,
          };
        }
      )

      .run();

    console.log("\n--- Document Analysis ---\n");
    console.log(`Overall Tone: ${analysis.overallTone}\n`);
    console.log("Sections:");
    for (const section of analysis.sections) {
      const indicator =
        section.sentimentScore > 0
          ? "+"
          : section.sentimentScore < 0
            ? "-"
            : "o";
      console.log(
        `  ${indicator} ${section.title} (score: ${section.sentimentScore})`
      );
      console.log(`    ${section.summary}\n`);
    }
    console.log(`Recommendation: ${analysis.recommendation}`);
  } finally {
    await agent.close();
  }
}

main();
