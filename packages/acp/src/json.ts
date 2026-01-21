/**
 * JSON value types
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * JSON object type
 */
export type JsonObject = { [key: string]: JsonValue };
