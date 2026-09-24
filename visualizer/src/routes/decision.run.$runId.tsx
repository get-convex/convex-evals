import { createFileRoute } from "@tanstack/react-router";
import {
  DecisionRunView,
  parseDecisionSearch,
} from "../lib/decisions/DecisionRunView";

export const Route = createFileRoute("/decision/run/$runId")({
  validateSearch: parseDecisionSearch,
  component: DecisionRunPage,
  errorComponent: () => (
    <main className="p-6">
      <h1 className="text-xl font-semibold">
        This decision run could not be loaded
      </h1>
      <p className="mt-2 text-slate-400">Check the run link or try again.</p>
      <a href="/decision" className="text-cyan-400 underline">
        Browse decision runs
      </a>
    </main>
  ),
});
function DecisionRunPage() {
  const { runId } = Route.useParams();
  return <DecisionRunView runId={runId} search={Route.useSearch()} />;
}
