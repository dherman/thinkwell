/**
 * SchemaProvider Integration Examples
 *
 * This package contains end-to-end examples demonstrating each schema provider
 * pattern supported by patchwork.
 *
 * Examples:
 *
 * 1. Inline Schema (01-inline-schema.ts)
 *    - Uses schemaOf<T>() helper for raw JSON schemas
 *    - Best for quick prototyping and simple schemas
 *
 * 2. Zod Adapter (02-zod-adapter.ts)
 *    - Schema-first pattern using Zod
 *    - Includes zodSchema() adapter function
 *    - Best when you need runtime validation
 *
 * 3. TypeBox Adapter (03-typebox-adapter.ts)
 *    - Schema-first pattern using TypeBox
 *    - Includes typeboxSchema() adapter function
 *    - Best for performance-critical applications
 *
 * 4. Build-time Generated (04-types.ts + 04-types.schemas.generated.ts)
 *    - Type-first pattern with auto-generated schemas
 *    - Run: pnpm generate:schemas to regenerate
 *    - Best for large codebases
 */

// Example 1: Inline schema with schemaOf<T>()
export {
  SummarySchema as InlineSummarySchema,
  AnalysisResultSchema as InlineAnalysisResultSchema,
} from "./01-inline-schema.js";

// Example 2: Zod adapter
export {
  zodSchema,
  SummarySchema as ZodSummarySchema,
  SummaryZod,
  AnalysisResultSchema as ZodAnalysisResultSchema,
  AnalysisResultZod,
  ConfigSchema as ZodConfigSchema,
  ConfigZod,
} from "./02-zod-adapter.js";
export type {
  Summary as ZodSummary,
  AnalysisResult as ZodAnalysisResult,
  Config as ZodConfig,
} from "./02-zod-adapter.js";

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
} from "./03-typebox-adapter.js";
export type {
  Summary as TypeBoxSummary,
  AnalysisResult as TypeBoxAnalysisResult,
  Config as TypeBoxConfig,
  UserProfile as TypeBoxUserProfile,
} from "./03-typebox-adapter.js";

// Example 4: Build-time generated schemas
export type {
  Summary as GeneratedSummary,
  AnalysisResult as GeneratedAnalysisResult,
  Config as GeneratedConfig,
  UserProfile as GeneratedUserProfile,
} from "./04-types.js";
export {
  SummarySchema as GeneratedSummarySchema,
  AnalysisResultSchema as GeneratedAnalysisResultSchema,
  ConfigSchema as GeneratedConfigSchema,
  UserProfileSchema as GeneratedUserProfileSchema,
} from "./04-types.schemas.generated.js";
