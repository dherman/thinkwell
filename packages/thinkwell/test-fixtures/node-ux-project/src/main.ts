import { Greeting, Person, Choice } from "./types.js";

// Verify that @JSONSchema namespace merging makes .Schema available
const greetingSchema = Greeting.Schema.toJsonSchema();
const personSchema = Person.Schema.toJsonSchema();
const choiceSchema = Choice.Schema.toJsonSchema();

console.log("Greeting schema type:", greetingSchema.type);
console.log("Person schema type:", personSchema.type);
console.log("Choice schema has oneOf:", "oneOf" in choiceSchema || "anyOf" in choiceSchema);
