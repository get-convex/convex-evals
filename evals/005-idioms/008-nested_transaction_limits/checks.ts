import { inspectQuery } from "../../../grader/querySandbox";

export function inspectNestedWriteLimit(
  projectDir: string,
  job: { _id: string; _creationTime: number; name: string; status: string },
): Promise<{ calls: number }> {
  return inspectQuery(projectDir, new URL("./inspect.mjs", import.meta.url), {
    job,
  });
}
