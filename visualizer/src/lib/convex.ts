import { ConvexReactClient } from "convex/react";

// The Convex deployment URL - must match the evalScores deployment
const CONVEX_URL = process.env.CONVEX_URL || "https://brazen-pelican-414.convex.cloud";

export const convex = new ConvexReactClient(CONVEX_URL);
