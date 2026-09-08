import { v } from "convex/values";

export const profileValidator = v.object({
  name: v.string(),
  email: v.string(),
  internalNote: v.optional(v.string()),
});

export const partialProfileValidator = profileValidator.partial();
export const publicProfileValidator = profileValidator.pick("name");
export const profileInputValidator = profileValidator.omit("internalNote");
export const identifiedProfileValidator = profileValidator.extend({
  externalId: v.string(),
});
