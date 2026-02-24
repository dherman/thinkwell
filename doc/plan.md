# Meeting Scheduler Example

Implements issue #35: a Thinkwell example that uses an LLM to translate
natural-language availability into Z3 constraints, then solves for a
valid meeting time.

## Tasks

- [x] Create `examples/src/attendees.json` with sample attendee data
- [x] Add `z3-solver` dependency and `schedule` script to `examples/package.json`
- [x] Create `examples/src/schedule.ts` — main script
  - [x] Define `@JSONSchema` types: `TimeWindow`, `AttendeeConstraints`, `ParsedConstraints`, `ScheduleResult`
  - [x] LLM step 1: parse NL availability → `ParsedConstraints`
  - [x] Z3 encoding: map structured constraints to integer variables + assertions
  - [x] Z3 solve: `solver.check()` → extract day/hour or detect unsat
  - [x] LLM step 2: generate human-friendly summary
  - [x] Console output with result
- [x] Run `pnpm install` and verify dependencies resolve
- [ ] Run end-to-end with `thinkwell src/schedule.ts`
