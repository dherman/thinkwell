/**
 * Example: Build-time Schema Generation with ts-json-schema-generator
 *
 * This file contains hand-written TypeScript types. The companion file
 * (generator.schemas.ts) is auto-generated from these types.
 *
 * Workflow:
 * 1. Define your types here with JSDoc annotations
 * 2. Run: pnpm generate:schemas
 * 3. Import generated SchemaProviders from generator.schemas.ts
 *
 * The generator script (scripts/generate-schemas.ts) uses ts-json-schema-generator
 * to create a TypeScript module with SchemaProvider<T> exports for each type.
 *
 * Best for:
 * - Type-first development (TypeScript types are the source of truth)
 * - Large codebases with many types
 * - Teams that prefer to avoid runtime schema libraries
 * - CI/CD pipelines that validate schema freshness
 *
 * JSDoc annotations supported:
 * - @minimum, @maximum - numeric constraints
 * - @default - default values
 * - @format - string formats (email, uuid, uri, date-time, etc.)
 * - @pattern - regex patterns
 * - @minLength, @maxLength - string length constraints
 */

/**
 * A summary of content.
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

/**
 * Result of sentiment analysis.
 */
export interface AnalysisResult {
  /** Overall sentiment of the content */
  sentiment: "positive" | "negative" | "neutral";
  /**
   * Confidence score between 0 and 1
   * @minimum 0
   * @maximum 1
   */
  confidence: number;
  /** Topics identified in the content */
  topics: Topic[];
}

/**
 * A topic with its relevance score.
 */
export interface Topic {
  /** The topic name */
  name: string;
  /**
   * Relevance score between 0 and 1
   * @minimum 0
   * @maximum 1
   */
  relevance: number;
}

/**
 * Configuration for LLM interactions.
 */
export interface Config {
  /**
   * Temperature setting (0-2)
   * @minimum 0
   * @maximum 2
   * @default 0.7
   */
  temperature?: number;
  /** Maximum tokens to generate */
  maxTokens?: number;
  /** System prompt to use */
  systemPrompt?: string;
}

/**
 * A user profile with validated fields.
 */
export interface UserProfile {
  /**
   * Unique identifier
   * @format uuid
   */
  id: string;
  /**
   * Email address
   * @format email
   */
  email: string;
  /**
   * Website URL
   * @format uri
   */
  website?: string;
  /**
   * Account creation timestamp
   * @format date-time
   */
  createdAt: string;
}

/**
 * A section of a document with its sentiment analysis.
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
 */
export interface DocumentAnalysis {
  /** The overall emotional tone of the document */
  overallTone: "positive" | "negative" | "mixed" | "neutral";
  /** Analysis of each section */
  sections: DocumentSection[];
  /** A recommendation based on the analysis */
  recommendation: string;
}
