import { useQuery } from "convex/react";
import { api } from "../convex/api";
import type { Id } from "../convex/types";
import { isModelSlug, resolveModelId } from "./modelIdentifier";

export function useResolvedModelId(
  model: string,
): Id<"models"> | null | undefined {
  const isSlug = isModelSlug(model);
  const modelBySlug = useQuery(
    api.models.getBySlug,
    isSlug ? { slug: model } : "skip",
  );

  return resolveModelId(model, modelBySlug);
}
