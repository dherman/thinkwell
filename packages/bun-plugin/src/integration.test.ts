import { describe, test, expect } from "bun:test";
import { findMarkedTypes } from "./transform.js";
import { generateSchemas, clearProgramCache } from "./schema-generator.js";
import { generateInjections } from "./codegen.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";

describe("integration", () => {
  test("full pipeline: parse, generate schema, inject code", () => {
    // Create a temp file for schema generation
    const tempDir = mkdtempSync(join(tmpdir(), "bun-plugin-test-"));
    const testFile = join(tempDir, "test.ts");

    try {
      const source = `
/** @JSONSchema */
export interface Greeting {
  /** The greeting message */
  message: string;
  /** Optional sender name */
  from?: string;
}
`;
      writeFileSync(testFile, source);

      // Step 1: Find marked types
      const types = findMarkedTypes(testFile, source);
      expect(types).toHaveLength(1);
      expect(types[0].name).toBe("Greeting");

      // Step 2: Generate schemas
      const schemas = generateSchemas(testFile, types);
      expect(schemas.size).toBe(1);

      const schema = schemas.get("Greeting") as Record<string, unknown>;
      expect(schema.type).toBe("object");
      expect(schema.properties).toBeDefined();

      const props = schema.properties as Record<string, unknown>;
      expect(props.message).toEqual({
        type: "string",
        description: "The greeting message",
      });
      expect(props.from).toEqual({
        type: "string",
        description: "Optional sender name",
      });

      expect(schema.required).toEqual(["message"]);

      // Step 3: Generate injections
      const injected = generateInjections(types, schemas);
      expect(injected).toContain("namespace Greeting");
      expect(injected).toContain("SchemaProvider<Greeting>");
      expect(injected).toContain('"The greeting message"');
    } finally {
      // Cleanup
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("handles type alias", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "bun-plugin-test-"));
    const testFile = join(tempDir, "test.ts");

    try {
      const source = `
/** @JSONSchema */
export type Status = "active" | "inactive" | "pending";
`;
      writeFileSync(testFile, source);

      const types = findMarkedTypes(testFile, source);
      expect(types).toHaveLength(1);

      const schemas = generateSchemas(testFile, types);
      const schema = schemas.get("Status") as Record<string, unknown>;

      expect(schema.type).toBe("string");
      expect(schema.enum).toEqual(["active", "inactive", "pending"]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("handles complex nested types", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "bun-plugin-test-"));
    const testFile = join(tempDir, "test.ts");

    try {
      const source = `
/** @JSONSchema */
export interface User {
  name: string;
  address: {
    street: string;
    city: string;
  };
  tags: string[];
}
`;
      writeFileSync(testFile, source);

      const types = findMarkedTypes(testFile, source);
      expect(types).toHaveLength(1);

      const schemas = generateSchemas(testFile, types);
      const schema = schemas.get("User") as Record<string, unknown>;

      expect(schema.type).toBe("object");

      const props = schema.properties as Record<string, unknown>;
      expect(props.name).toEqual({ type: "string" });

      const address = props.address as Record<string, unknown>;
      expect(address.type).toBe("object");
      expect(address.properties).toBeDefined();

      const tags = props.tags as Record<string, unknown>;
      expect(tags.type).toBe("array");
      expect((tags.items as Record<string, unknown>).type).toBe("string");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("cross-file types", () => {
  test("resolves imported type used as property", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "bun-plugin-test-"));

    try {
      // Create a tsconfig.json for proper cross-file resolution
      writeFileSync(
        join(tempDir, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            target: "ES2022",
            module: "ESNext",
            moduleResolution: "bundler",
            strict: true,
          },
          include: ["*.ts"],
        })
      );

      // Create base type file
      writeFileSync(
        join(tempDir, "address.ts"),
        `
/** Address type */
export interface Address {
  /** Street address */
  street: string;
  /** City name */
  city: string;
}
`
      );

      // Create main file that imports from base
      const mainFile = join(tempDir, "user.ts");
      const mainSource = `
import { Address } from "./address.js";

/** @JSONSchema */
export interface User {
  /** User name */
  name: string;
  /** User address */
  address: Address;
}
`;
      writeFileSync(mainFile, mainSource);

      // Clear cache to ensure fresh generation
      clearProgramCache();

      const types = findMarkedTypes(mainFile, mainSource);
      expect(types).toHaveLength(1);
      expect(types[0].name).toBe("User");

      const schemas = generateSchemas(mainFile, types);
      const schema = schemas.get("User") as Record<string, unknown>;

      expect(schema.type).toBe("object");

      const props = schema.properties as Record<string, unknown>;
      expect(props.name).toEqual({
        type: "string",
        description: "User name",
      });

      // Address should be inlined, not a $ref
      const address = props.address as Record<string, unknown>;
      expect(address.type).toBe("object");
      expect(address.description).toBe("Address type");

      const addressProps = address.properties as Record<string, unknown>;
      expect(addressProps.street).toEqual({
        type: "string",
        description: "Street address",
      });
      expect(addressProps.city).toEqual({
        type: "string",
        description: "City name",
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("resolves interface that extends imported type", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "bun-plugin-test-"));

    try {
      writeFileSync(
        join(tempDir, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            target: "ES2022",
            module: "ESNext",
            moduleResolution: "bundler",
            strict: true,
          },
          include: ["*.ts"],
        })
      );

      // Create base entity type
      writeFileSync(
        join(tempDir, "base.ts"),
        `
/** Base entity with ID */
export interface BaseEntity {
  /** Unique identifier */
  id: string;
  /** Creation timestamp */
  createdAt: string;
}
`
      );

      // Create type that extends base
      const mainFile = join(tempDir, "user.ts");
      const mainSource = `
import { BaseEntity } from "./base.js";

/** @JSONSchema */
export interface User extends BaseEntity {
  /** User name */
  name: string;
}
`;
      writeFileSync(mainFile, mainSource);

      clearProgramCache();

      const types = findMarkedTypes(mainFile, mainSource);
      const schemas = generateSchemas(mainFile, types);
      const schema = schemas.get("User") as Record<string, unknown>;

      expect(schema.type).toBe("object");

      const props = schema.properties as Record<string, unknown>;
      // Should include inherited properties
      expect(props.id).toEqual({
        type: "string",
        description: "Unique identifier",
      });
      expect(props.createdAt).toEqual({
        type: "string",
        description: "Creation timestamp",
      });
      expect(props.name).toEqual({
        type: "string",
        description: "User name",
      });

      // All properties should be required
      expect(schema.required).toContain("id");
      expect(schema.required).toContain("createdAt");
      expect(schema.required).toContain("name");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("resolves imported type alias", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "bun-plugin-test-"));

    try {
      writeFileSync(
        join(tempDir, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            target: "ES2022",
            module: "ESNext",
            moduleResolution: "bundler",
            strict: true,
          },
          include: ["*.ts"],
        })
      );

      // Create type alias file
      writeFileSync(
        join(tempDir, "types.ts"),
        `
/** Status values */
export type Status = "active" | "inactive" | "pending";
`
      );

      // Use the type alias in main file
      const mainFile = join(tempDir, "user.ts");
      const mainSource = `
import { Status } from "./types.js";

/** @JSONSchema */
export interface User {
  name: string;
  status: Status;
}
`;
      writeFileSync(mainFile, mainSource);

      clearProgramCache();

      const types = findMarkedTypes(mainFile, mainSource);
      const schemas = generateSchemas(mainFile, types);
      const schema = schemas.get("User") as Record<string, unknown>;

      const props = schema.properties as Record<string, unknown>;
      const status = props.status as Record<string, unknown>;

      // Status should be inlined as an enum
      expect(status.type).toBe("string");
      expect(status.enum).toEqual(["active", "inactive", "pending"]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("resolves deeply nested cross-file types", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "bun-plugin-test-"));

    try {
      writeFileSync(
        join(tempDir, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            target: "ES2022",
            module: "ESNext",
            moduleResolution: "bundler",
            strict: true,
          },
          include: ["*.ts"],
        })
      );

      // Create a chain of imports: user.ts -> address.ts -> country.ts
      writeFileSync(
        join(tempDir, "country.ts"),
        `
export interface Country {
  code: string;
  name: string;
}
`
      );

      writeFileSync(
        join(tempDir, "address.ts"),
        `
import { Country } from "./country.js";

export interface Address {
  street: string;
  country: Country;
}
`
      );

      const mainFile = join(tempDir, "user.ts");
      const mainSource = `
import { Address } from "./address.js";

/** @JSONSchema */
export interface User {
  name: string;
  address: Address;
}
`;
      writeFileSync(mainFile, mainSource);

      clearProgramCache();

      const types = findMarkedTypes(mainFile, mainSource);
      const schemas = generateSchemas(mainFile, types);
      const schema = schemas.get("User") as Record<string, unknown>;

      const props = schema.properties as Record<string, unknown>;
      const address = props.address as Record<string, unknown>;
      const addressProps = address.properties as Record<string, unknown>;
      const country = addressProps.country as Record<string, unknown>;

      // Country should be fully inlined (3 levels deep)
      expect(country.type).toBe("object");
      const countryProps = country.properties as Record<string, unknown>;
      expect(countryProps.code).toEqual({ type: "string" });
      expect(countryProps.name).toEqual({ type: "string" });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
