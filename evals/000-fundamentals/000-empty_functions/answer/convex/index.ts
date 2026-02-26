import {
  query,
  mutation,
  action,
  internalQuery,
  internalMutation,
  internalAction,
} from "./_generated/server";
import { v } from "convex/values";

// Public functions
export const emptyPublicQuery = query({
  args: {},
  handler: async (ctx) => {
    return null;
  },
});

export const emptyPublicMutation = mutation({
  args: {},
  handler: async (ctx) => {
    return null;
  },
});

export const emptyPublicAction = action({
  args: {},
  handler: async (ctx) => {
    return null;
  },
});

// Private functions
export const emptyPrivateQuery = internalQuery({
  args: {},
  handler: async (ctx) => {
    return null;
  },
});

export const emptyPrivateMutation = internalMutation({
  args: {},
  handler: async (ctx) => {
    return null;
  },
});

export const emptyPrivateAction = internalAction({
  args: {},
  handler: async (ctx) => {
    return null;
  },
});
