import { describe, test, expect } from "bun:test";
import { THINKWELL_MODULES } from "./modules.js";

describe("thinkwell:* module resolution", () => {
  test("maps thinkwell:agent to @thinkwell/thinkwell", () => {
    expect(THINKWELL_MODULES["agent"]).toBe("@thinkwell/thinkwell");
  });

  test("maps thinkwell:acp to @thinkwell/acp", () => {
    expect(THINKWELL_MODULES["acp"]).toBe("@thinkwell/acp");
  });

  test("maps thinkwell:protocol to @thinkwell/protocol", () => {
    expect(THINKWELL_MODULES["protocol"]).toBe("@thinkwell/protocol");
  });

  test("maps thinkwell:connectors to @thinkwell/thinkwell/connectors", () => {
    expect(THINKWELL_MODULES["connectors"]).toBe("@thinkwell/thinkwell/connectors");
  });

  test("has exactly 4 modules defined", () => {
    expect(Object.keys(THINKWELL_MODULES)).toHaveLength(4);
  });
});
