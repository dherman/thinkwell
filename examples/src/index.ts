/**
 * SchemaProvider Integration Examples
 *
 * This package contains end-to-end examples demonstrating each schema provider
 * pattern supported by patchwork. Each example shows two use cases:
 *   1. Simple prompt without tools (summarization)
 *   2. Prompt with a custom tool (sentiment analysis using the `sentiment` npm package)
 *
 * Examples:
 *
 * 1. Inline Schema (inline.ts)
 *    - Uses schemaOf<T>() helper for raw JSON schemas
 *    - Best for quick prototyping and simple schemas
 *
 * 2. Zod Adapter (zod.ts)
 *    - Schema-first pattern using Zod
 *    - Includes zodSchema() adapter function
 *    - Best when you need runtime validation
 *
 * 3. TypeBox Adapter (typebox.ts)
 *    - Schema-first pattern using TypeBox
 *    - Includes typeboxSchema() adapter function
 *    - Best for performance-critical applications
 *
 * 4. Build-time Generated (generator.ts + generator.schemas.ts)
 *    - Type-first pattern with auto-generated schemas
 *    - Run: pnpm generate:schemas to regenerate
 *    - Best for large codebases
 */

// Example 1: Inline schema with schemaOf<T>()
export {
  SummarySchema as InlineSummarySchema,
  AnalysisResultSchema as InlineAnalysisResultSchema,
} from "./inline.js";

// Example 2: Zod adapter
export {
  zodSchema,
  SummarySchema as ZodSummarySchema,
  SummaryZod,
  AnalysisResultSchema as ZodAnalysisResultSchema,
  AnalysisResultZod,
  ConfigSchema as ZodConfigSchema,
  ConfigZod,
} from "./zod.js";
export type {
  Summary as ZodSummary,
  AnalysisResult as ZodAnalysisResult,
  Config as ZodConfig,
} from "./zod.js";

// Example 3: TypeBox adapter
export {
  typeboxSchema,
  SummarySchema as TypeBoxSummarySchema,
  SummaryTypeBox,
  AnalysisResultSchema as TypeBoxAnalysisResultSchema,
  AnalysisResultTypeBox,
  ConfigSchema as TypeBoxConfigSchema,
  ConfigTypeBox,
  UserProfileSchema as TypeBoxUserProfileSchema,
  UserProfileTypeBox,
} from "./typebox.js";
export type {
  Summary as TypeBoxSummary,
  AnalysisResult as TypeBoxAnalysisResult,
  Config as TypeBoxConfig,
  UserProfile as TypeBoxUserProfile,
} from "./typebox.js";

// Example 4: Build-time generated schemas
export type {
  Summary as GeneratedSummary,
  AnalysisResult as GeneratedAnalysisResult,
  Config as GeneratedConfig,
  UserProfile as GeneratedUserProfile,
} from "./generator.types.js";
export {
  SummarySchema as GeneratedSummarySchema,
  AnalysisResultSchema as GeneratedAnalysisResultSchema,
  ConfigSchema as GeneratedConfigSchema,
  UserProfileSchema as GeneratedUserProfileSchema,
} from "./generator.schemas.js";
