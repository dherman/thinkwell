<p align="center">
  <img src="assets/logo.jpg" alt="Thinkwell Logo" width="200">
</p>

# Thinkwell

A TypeScript library for easy scripting of AI agents. Thinkwell provides a fluent API for blending deterministic code with LLM-powered reasoning.

## Quick Start

```typescript
import { Agent, schemaOf } from "thinkwell";

const agent = await Agent.connect("npx -y @zed-industries/claude-code-acp");

const result = await agent
  .think(schemaOf<{ greeting: string }>({
    type: "object",
    properties: { greeting: { type: "string" } },
    required: ["greeting"]
  }))
  .text("Say hello!")
  .run();

console.log(result.greeting);

agent.close();
```

# License

MIT
