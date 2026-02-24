/**
 * Example: Classification with Discriminated Union
 *
 * This example demonstrates using a discriminated union type with @JSONSchema.
 * The LLM classifies a customer message and returns one of several structured
 * action types, each with different fields. The calling code then uses a
 * type-safe switch on the discriminant to handle each case.
 *
 * Run with: thinkwell src/classify.ts
 */

import { open } from "thinkwell";

// --- Variant interfaces ---

export interface Refund {
  type: 'refund';
  /** The order ID to refund */
  orderId: string;
  /** The reason for the refund */
  reason: string;
}

export interface Escalate {
  type: 'escalate';
  /** The department to escalate to */
  department: string;
  /** Priority level */
  priority: 'low' | 'medium' | 'high';
  /** Brief summary for the agent */
  summary: string;
}

export interface Respond {
  type: 'respond';
  /** The response message to send to the customer */
  message: string;
}

/**
 * The action to take for a customer support message.
 * @JSONSchema
 */
export type Action = Refund | Escalate | Respond;

const sampleMessages = [
  "I ordered a blender two weeks ago (order #BL-9921) and it arrived broken. I want my money back.",
  "How do I change my shipping address for future orders?",
  "This is the THIRD time my delivery has been late. I've been a customer for 10 years and I'm about to cancel everything. I need someone in charge to call me back NOW.",
];

async function main() {
  const agent = await open('claude');

  try {
    console.log("=== Customer Support Classifier ===\n");

    for (const message of sampleMessages) {
      console.log(`Customer: "${message}"\n`);

      const action = await agent
        .think(Action.Schema)
        .text(`
          Classify the following customer support message and decide the
          best action to take. Choose one of: refund (if they want money back),
          escalate (if they need a manager or specialist), or respond (if you
          can answer directly).
        `)
        .quote(message, "customer message")
        .run();

      switch (action.type) {
        case 'refund':
          console.log(`  → REFUND order ${action.orderId}`);
          console.log(`    Reason: ${action.reason}\n`);
          break;
        case 'escalate':
          console.log(`  → ESCALATE to ${action.department} (${action.priority})`);
          console.log(`    Summary: ${action.summary}\n`);
          break;
        case 'respond':
          console.log(`  → RESPOND: ${action.message}\n`);
          break;
      }
    }
  } finally {
    await agent.close();
  }
}

main();
