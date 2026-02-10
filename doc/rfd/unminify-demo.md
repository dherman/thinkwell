# RFD: JavaScript Unminifier Demo

**Implementation:** [PR #2](https://github.com/dherman/thinkwell/pull/2)

## Summary

A thinkwell demo that takes a minified JavaScript library and produces a more readable version by:
1. Pretty-printing
2. Converting UMD boilerplate to ESM
3. Renaming minified identifiers to descriptive names

This demo showcases thinkwell's core pattern: deterministic code handles orchestration and iteration, while the LLM handles semantic understanding.

## Motivation

Minified JavaScript is hard to read due to compressed formatting and single-letter variable names. While formatting can be fixed mechanically (Prettier), recovering meaningful names requires understanding what the code *does* - a task well-suited to LLMs.

This demo illustrates how thinkwell enables developers to:
- Use loops and control flow in TypeScript for predictable iteration
- Delegate semantic analysis to the LLM
- Combine multiple LLM calls into a coherent pipeline

## Design

### Input/Output

- **Input**: A minified JavaScript file (e.g., `underscore-umd-min.js`)
- **Output**: A readable JavaScript file with descriptive function names and ESM syntax

### Pipeline

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  Prettier   │────▶│  UMD→ESM    │────▶│  Extract    │
│  (format)   │     │  (LLM)      │     │  Functions  │
└─────────────┘     └─────────────┘     │  (LLM)      │
                                        └──────┬──────┘
                                               │
                    ┌──────────────────────────▼──────┐
                    │  For each function:             │
                    │    Analyze & suggest name (LLM) │
                    │    Add to rename map            │
                    └──────────────────────────┬──────┘
                                               │
                                        ┌──────▼──────┐
                                        │  Apply      │
                                        │  Renames    │
                                        │  (LLM)      │
                                        └─────────────┘
```

### Step 1: Pretty-print with Prettier

Mechanical transformation - no LLM needed.

```typescript
import * as prettier from "prettier";

const formatted = await prettier.format(minifiedCode, { parser: "babel" });
```

### Step 2: Convert UMD to ESM (LLM)

Ask the LLM to strip the UMD wrapper and convert to ESM exports.

```typescript
interface ModuleConversion {
  code: string;
}

const esm = await agent
  .think(schemaOf<ModuleConversion>({...}))
  .text("Convert this UMD module to ESM syntax.")
  .text("Remove the UMD boilerplate (the IIFE checking for exports/define/globalThis).")
  .text("Keep the module body intact. Export the main object as default.\n\n")
  .display(formatted)
  .run();
```

### Step 3: Extract Function List (LLM)

Ask the LLM to identify all top-level functions.

```typescript
interface FunctionInfo {
  name: string;        // Current minified name (e.g., "j", "w")
  signature: string;   // Parameters for context (e.g., "n, r")
}

interface FunctionList {
  functions: FunctionInfo[];
}

const functionList = await agent
  .think(schemaOf<FunctionList>({...}))
  .text("List all top-level function declarations and named function expressions.\n\n")
  .display(esm.code)
  .run();
```

### Step 4: Analyze Each Function (Loop + LLM)

Iterate over the function list in TypeScript. For each function, ask the LLM to suggest a descriptive name.

```typescript
interface FunctionAnalysis {
  suggestedName: string;
  purpose: string;  // Brief explanation (helps with debugging/verification)
}

const renameMap = new Map<string, string>();

for (const fn of functionList.functions) {
  const analysis = await agent
    .think(schemaOf<FunctionAnalysis>({...}))
    .text(`Analyze this function and suggest a descriptive name.\n`)
    .text(`Current name: ${fn.name}\n`)
    .text(`Signature: ${fn.signature}\n\n`)
    .text("Here is the full source for context:\n\n")
    .display(esm.code)
    .run();

  renameMap.set(fn.name, analysis.suggestedName);
  console.log(`${fn.name} → ${analysis.suggestedName}: ${analysis.purpose}`);
}
```

### Step 5: Apply Renames (LLM)

Ask the LLM to apply all renames in one pass.

```typescript
interface RenamedCode {
  code: string;
}

const result = await agent
  .think(schemaOf<RenamedCode>({...}))
  .text("Rename these identifiers throughout the code:\n\n")
  .display(Object.fromEntries(renameMap))
  .text("\n\nIMPORTANT: Only rename these exact identifiers. Do not change anything else.\n\n")
  .display(esm.code)
  .run();
```

## Design Decisions

### Why no AST libraries?

This demo optimizes for ease of understanding over performance. Every transformation that requires semantic understanding goes to the LLM. The only mechanical step (pretty-printing) uses Prettier.

This makes the code easy to read and demonstrates thinkwell's value proposition: you don't need complex tooling when you can describe what you want in natural language.

### Why send full source for each function analysis?

Minified code often has interdependencies - function `j` might call function `w`. Sending the full source lets the LLM see these relationships and suggest more appropriate names.

### Why a separate rename step?

Doing renames during analysis would require careful ordering (rename dependencies first). A final rename pass with all mappings is simpler and less error-prone.

### Limitations

- **Token limits**: Very large files may exceed context limits. Could be addressed by chunking.
- **Accuracy**: LLM renames aren't guaranteed correct. For production use, manual review or AST-based renaming would be preferable.
- **Performance**: Multiple LLM calls are slow. Acceptable for a demo; could be optimized with batching.

## File Structure

```
examples/
├── src/
│   ├── unminify.ts         # Main demo script
│   └── unminify.test.ts    # Integration test
├── data/
│   └── underscore-umd-min.js  # Sample input file
```

## Dependencies

- `prettier` - for initial formatting
- `thinkwell` - for LLM orchestration

## Future Enhancements (Out of Scope)

- Rename local variables within functions
- Add JSDoc comments based on analysis
- Support TypeScript output
- Batch function analysis for performance
