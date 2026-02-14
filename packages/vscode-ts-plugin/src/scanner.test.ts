import { describe, it } from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";
import { hasJsonSchemaMarkers, findMarkedTypes } from "./scanner";

describe("hasJsonSchemaMarkers", () => {
  it("returns true when source contains @JSONSchema", () => {
    assert.ok(hasJsonSchemaMarkers("/** @JSONSchema */\ninterface Greeting {}"));
  });

  it("returns false when source has no markers", () => {
    assert.ok(!hasJsonSchemaMarkers("interface Greeting { message: string }"));
  });

  it("returns false for empty source", () => {
    assert.ok(!hasJsonSchemaMarkers(""));
  });
});

describe("findMarkedTypes", () => {
  it("finds a single marked interface", () => {
    const source = `
/** @JSONSchema */
interface Greeting {
  message: string;
}`;
    const types = findMarkedTypes(ts, "test.ts", source);
    assert.equal(types.length, 1);
    assert.equal(types[0].name, "Greeting");
    assert.equal(types[0].isExported, false);
  });

  it("finds an exported marked interface", () => {
    const source = `
/** @JSONSchema */
export interface Greeting {
  message: string;
}`;
    const types = findMarkedTypes(ts, "test.ts", source);
    assert.equal(types.length, 1);
    assert.equal(types[0].name, "Greeting");
    assert.equal(types[0].isExported, true);
  });

  it("finds multiple marked types", () => {
    const source = `
/** @JSONSchema */
export interface Greeting {
  message: string;
}

/** @JSONSchema */
interface Sentiment {
  score: number;
}

interface Unrelated {
  foo: string;
}`;
    const types = findMarkedTypes(ts, "test.ts", source);
    assert.equal(types.length, 2);
    assert.equal(types[0].name, "Greeting");
    assert.equal(types[0].isExported, true);
    assert.equal(types[1].name, "Sentiment");
    assert.equal(types[1].isExported, false);
  });

  it("finds marked type aliases", () => {
    const source = `
/** @JSONSchema */
export type Config = {
  host: string;
  port: number;
};`;
    const types = findMarkedTypes(ts, "test.ts", source);
    assert.equal(types.length, 1);
    assert.equal(types[0].name, "Config");
    assert.equal(types[0].isExported, true);
  });

  it("finds marked enums", () => {
    const source = `
/** @JSONSchema */
export enum Color {
  Red = "red",
  Blue = "blue",
}`;
    const types = findMarkedTypes(ts, "test.ts", source);
    assert.equal(types.length, 1);
    assert.equal(types[0].name, "Color");
  });

  it("finds marked classes", () => {
    const source = `
/** @JSONSchema */
export class Person {
  name: string = "";
}`;
    const types = findMarkedTypes(ts, "test.ts", source);
    assert.equal(types.length, 1);
    assert.equal(types[0].name, "Person");
  });

  it("ignores types without the marker", () => {
    const source = `
/** Some other doc comment */
export interface Greeting {
  message: string;
}`;
    const types = findMarkedTypes(ts, "test.ts", source);
    assert.equal(types.length, 0);
  });

  it("returns empty array for files with no type declarations", () => {
    const source = `const x = 42;\nfunction foo() { return x; }`;
    const types = findMarkedTypes(ts, "test.ts", source);
    assert.equal(types.length, 0);
  });
});
