import { randomUUID } from "node:crypto";
import { inspectQuery } from "../../../grader/querySandbox";

export function inspectBoundedQuery(
  projectDir: string,
): Promise<{ bounds: number[] }> {
  return inspectQuery(
    projectDir,
    new URL("./inspect.mjs", import.meta.url),
    `workspace-${randomUUID()}`,
  );
}
