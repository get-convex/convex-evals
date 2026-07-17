import { defineSchema } from "convex/server";

// All conversation state (threads and messages) lives in the agent
// component; the app itself owns no tables.
export default defineSchema({});
