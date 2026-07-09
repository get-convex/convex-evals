import type { Id } from "../convex/types";

type ModelLookupResult = { _id: Id<"models"> } | null | undefined;

export function isModelSlug(model: string): boolean {
  return model.includes("/");
}

export function resolveModelId(
  model: string,
  modelBySlug: ModelLookupResult,
): Id<"models"> | null | undefined {
  if (!isModelSlug(model)) return model as Id<"models">;
  if (modelBySlug == null) return modelBySlug;
  return modelBySlug._id;
}
