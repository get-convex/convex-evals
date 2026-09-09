import { inspectQuery } from "../../../grader/querySandbox";

export function inspectTimeWindowQuery(
  projectDir: string,
  timeArgName: string,
  now: number,
): Promise<{ result: unknown }> {
  return inspectQuery(projectDir, new URL("./inspect.mjs", import.meta.url), {
    timeArgName,
    now,
  });
}
