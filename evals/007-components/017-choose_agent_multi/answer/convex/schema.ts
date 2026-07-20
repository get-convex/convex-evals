import { defineSchema } from "convex/server";

// The shared conversation history lives in the agent component; both
// assistants write into the same component-owned thread.
export default defineSchema({});
