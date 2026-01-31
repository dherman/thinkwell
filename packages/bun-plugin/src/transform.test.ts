import { describe, test, expect } from "bun:test";
import { findMarkedTypes } from "./transform.js";

describe("findMarkedTypes", () => {
  test("finds interface with @JSONSchema", () => {
    const source = `
      /** @JSONSchema */
      interface Greeting {
        message: string;
      }
    `;
    const types = findMarkedTypes("test.ts", source);
    expect(types).toHaveLength(1);
    expect(types[0].name).toBe("Greeting");
  });

  test("finds type alias with @JSONSchema", () => {
    const source = `
      /** @JSONSchema */
      type Status = "active" | "inactive";
    `;
    const types = findMarkedTypes("test.ts", source);
    expect(types).toHaveLength(1);
    expect(types[0].name).toBe("Status");
  });

  test("finds enum with @JSONSchema", () => {
    const source = `
      /** @JSONSchema */
      enum Color {
        Red = "red",
        Blue = "blue",
      }
    `;
    const types = findMarkedTypes("test.ts", source);
    expect(types).toHaveLength(1);
    expect(types[0].name).toBe("Color");
  });

  test("finds multiple marked types", () => {
    const source = `
      /** @JSONSchema */
      interface Greeting {
        message: string;
      }

      /** @JSONSchema */
      interface Farewell {
        message: string;
      }

      // Not marked
      interface Other {
        value: number;
      }
    `;
    const types = findMarkedTypes("test.ts", source);
    expect(types).toHaveLength(2);
    expect(types.map((t) => t.name)).toEqual(["Greeting", "Farewell"]);
  });

  test("ignores types without @JSONSchema", () => {
    const source = `
      interface Greeting {
        message: string;
      }

      /** Some other doc */
      interface Other {
        value: number;
      }
    `;
    const types = findMarkedTypes("test.ts", source);
    expect(types).toHaveLength(0);
  });

  test("returns empty for files without @JSONSchema string", () => {
    const source = `
      interface Greeting {
        message: string;
      }
    `;
    const types = findMarkedTypes("test.ts", source);
    expect(types).toHaveLength(0);
  });

  test("handles JSDoc with description before tag", () => {
    const source = `
      /**
       * A friendly greeting.
       * @JSONSchema
       */
      interface Greeting {
        message: string;
      }
    `;
    const types = findMarkedTypes("test.ts", source);
    expect(types).toHaveLength(1);
    expect(types[0].name).toBe("Greeting");
  });
});
