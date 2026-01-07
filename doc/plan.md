# Implementation Plan: Unminify Demo

## Overview

Build a patchwork demo that unminifies JavaScript by using LLM calls for semantic analysis and renaming.

## Tasks

### Setup

- [x] Move `doc/.local/underscore-umd-min.js` to `examples/data/underscore-umd-min.js`
- [x] Add `prettier` as a dev dependency in examples package
- [x] Create `examples/src/unminify.ts` skeleton

### Step 1: Pretty-print

- [x] Implement `formatCode()` function using Prettier

### Step 2: UMD → ESM Conversion

- [x] Define `ModuleConversion` schema
- [x] Implement LLM call to strip UMD boilerplate and convert to ESM default export

### Step 3: Extract Function List

- [x] Define `FunctionInfo` and `FunctionList` schemas
- [x] Implement LLM call to extract all top-level function names and signatures

### Step 4: Analyze Functions

- [x] Define `FunctionAnalysis` schema
- [x] Implement loop over function list with LLM call for each
- [x] Build rename map from analysis results
- [x] Add progress logging

### Step 5: Apply Renames

- [x] Define `RenamedCode` schema
- [x] Implement LLM call to apply all renames in one pass

### Integration

- [x] Wire all steps together in `main()` function
- [x] Write output to `examples/data/underscore.js` (or configurable output path)
- [x] Add integration test in `examples/src/unminify.test.ts`

### Polish

- [x] Add helpful console output showing progress
- [ ] Test end-to-end with underscore.js
- [ ] Verify output is valid JavaScript (can be parsed/imported)
