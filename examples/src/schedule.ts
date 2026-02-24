#!/usr/bin/env thinkwell

/**
 * Example: Meeting Scheduler with Z3 Constraint Solving
 *
 * This example demonstrates blending LLM reasoning with formal constraint
 * solving. An LLM translates natural-language availability descriptions into
 * structured constraints, then the Z3 SMT solver finds a valid meeting time.
 *
 * Inspired by "Solving Zebra Puzzles Using Constraint-Guided Multi-Agent
 * Systems" (Berman et al., 2024) — the LLM acts as a "constraint compiler"
 * while Z3 handles the combinatorial search.
 *
 * Run with: thinkwell src/schedule.ts
 */

import { open } from "thinkwell";
import { init } from "z3-solver";
import * as fs from "fs/promises";

// =============================================================================
// Type Definitions
// =============================================================================

/**
 * A time window when an attendee is available.
 * @JSONSchema
 */
export interface TimeWindow {
  /** Day of the week */
  day: "monday" | "tuesday" | "wednesday" | "thursday" | "friday";
  /**
   * Earliest hour (inclusive, 24-hour format, e.g. 9 = 9am)
   * @minimum 0
   * @maximum 23
   */
  earliestHour: number;
  /**
   * Latest hour (exclusive, 24-hour format, e.g. 17 = 5pm)
   * @minimum 1
   * @maximum 24
   */
  latestHour: number;
}

/**
 * Parsed availability for one attendee.
 * @JSONSchema
 */
export interface AttendeeConstraints {
  /** The attendee's name */
  name: string;
  /** Time windows when this attendee is available to meet */
  available: TimeWindow[];
}

/**
 * All attendees' parsed availability constraints.
 * @JSONSchema
 */
export interface ParsedConstraints {
  /** Parsed constraints for each attendee */
  attendees: AttendeeConstraints[];
}

/**
 * The final scheduling result.
 * @JSONSchema
 */
export interface ScheduleResult {
  /** Whether a valid meeting time was found */
  scheduled: boolean;
  /** A friendly summary of the result */
  summary: string;
}

// =============================================================================
// Z3 Constraint Encoding
// =============================================================================

const DAY_NAMES = ["monday", "tuesday", "wednesday", "thursday", "friday"] as const;
const DAY_LABELS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];

async function solve(constraints: ParsedConstraints): Promise<{ day: number; hour: number } | null> {
  const { Context } = await init();
  const { Solver, Int, And, Or, isIntVal } = new Context("main");

  const day = Int.const("day");
  const hour = Int.const("hour");

  const solver = new Solver();
  solver.set("timeout", 10000);

  // Domain: weekdays (0-4) and business hours (9-17)
  solver.add(day.ge(0), day.le(4));
  solver.add(hour.ge(9), hour.le(17));

  // For each attendee, the meeting must fall in one of their available windows
  for (const attendee of constraints.attendees) {
    if (attendee.available.length === 0) continue;

    const windows = attendee.available.map((w) => {
      const dayIndex = DAY_NAMES.indexOf(w.day);
      return And(
        day.eq(dayIndex),
        hour.ge(w.earliestHour),
        hour.lt(w.latestHour),
      );
    });

    solver.add(windows.length === 1 ? windows[0] : Or(...windows));
  }

  const result = await solver.check();

  if (result === "sat") {
    const model = solver.model();
    const dayVal = model.eval(day);
    const hourVal = model.eval(hour);
    if (isIntVal(dayVal) && isIntVal(hourVal)) {
      return { day: Number(dayVal.value()), hour: Number(hourVal.value()) };
    }
  }

  return null;
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  const agent = await open("claude");

  try {
    console.log("=== Meeting Scheduler ===\n");

    // Step 1: Load attendee data
    const raw = await fs.readFile(
      new URL("attendees.json", import.meta.url),
      "utf-8",
    );
    const attendees: { name: string; availability: string }[] = JSON.parse(raw);

    console.log("Attendees:");
    for (const a of attendees) {
      console.log(`  - ${a.name}: "${a.availability}"`);
    }
    console.log();

    // Step 2: LLM translates natural language → structured constraints
    console.log("Parsing availability constraints...");

    const attendeeList = attendees
      .map((a) => `- ${a.name}: ${a.availability}`)
      .join("\n");

    const parsed = await agent
      .think(ParsedConstraints.Schema)
      .text(`
        Parse each attendee's natural-language availability into structured
        time windows. Each window specifies a day, earliest hour (inclusive),
        and latest hour (exclusive) in 24-hour format.

        Business hours are 9am (9) to 5pm (17). If someone says "mornings",
        interpret that as 9-12. If they say "afternoons", interpret as 12-17.
        If no time range is specified for a day, assume full business hours (9-17).

        Attendees:

      `)
      .text(attendeeList)
      .run();

    // Show what the LLM extracted
    for (const a of parsed.attendees) {
      const windows = a.available
        .map((w) => `${w.day} ${w.earliestHour}:00-${w.latestHour}:00`)
        .join(", ");
      console.log(`  ${a.name}: ${windows}`);
    }
    console.log();

    // Step 3: Solve with Z3
    console.log("Solving constraints with Z3...");
    const solution = await solve(parsed);

    // Step 4: LLM generates a friendly summary
    const solverOutput = solution
      ? `Found a valid time: ${DAY_LABELS[solution.day]} at ${solution.hour}:00`
      : "No valid meeting time exists that satisfies all constraints.";

    console.log(`  ${solverOutput}\n`);

    const result = await agent
      .think(ScheduleResult.Schema)
      .text(`
        Summarize this meeting scheduling result in a friendly, concise way.
        Mention the attendees by name and the chosen time (or explain the conflict).

        Attendees: ${attendees.map((a) => a.name).join(", ")}
        Solver result: ${solverOutput}
      `)
      .run();

    // Step 5: Display result
    console.log("--- Result ---\n");
    console.log(result.summary);
  } finally {
    await agent.close();
  }
}

main();
