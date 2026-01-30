import {
  createFileRoute,
  useParams,
  Link,
  useSearch,
} from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { useQuery } from "convex/react";
import { api } from "../../../evalScores/convex/_generated/api";
import type { Id } from "../../../evalScores/convex/_generated/dataModel";
import {
  getTaskContent,
  browseDirectory,
  getFileContent,
  getAnswerDirectory,
} from "../lib/data";
import {
  getEvalStatusIcon,
  getStepStatusIcon,
  formatDuration,
  formatStepName,
  type Step,
  type FileEntry,
} from "../lib/types";

export const Route = createFileRoute("/run/$runId/$category/$evalId")({
  validateSearch: (search: Record<string, unknown>) => ({
    tab: (search.tab as string) ?? "steps",
  }),
  component: EvalDetailsPage,
});

function EvalDetailsPage() {
  const { runId, category, evalId } = useParams({
    from: "/run/$runId/$category/$evalId",
  });
  const { tab } = useSearch({ from: "/run/$runId/$category/$evalId" });

  const run = useQuery(api.runs.getRunDetails, {
    runId: runId as Id<"runs">,
  });

  if (run === undefined) {
    return (
      <main className="flex-1 flex items-center justify-center">
        <div className="text-slate-400">Loading...</div>
      </main>
    );
  }

  if (run === null) {
    return (
      <main className="flex-1 flex items-center justify-center">
        <div className="text-red-400">Run not found</div>
      </main>
    );
  }

  const evalItem = run.evals.find((e) => e._id === evalId);

  if (!evalItem) {
    return (
      <main className="flex-1 flex items-center justify-center">
        <div className="text-red-400">Evaluation not found</div>
      </main>
    );
  }

  return (
    <main className="flex-1 flex flex-col overflow-hidden">
      <div className="border-b border-slate-700 px-6 py-4">
        <div className="breadcrumb">
          <Link to="/" className="breadcrumb-btn">
            All Runs
          </Link>
          <span className="breadcrumb-separator">→</span>
          <Link
            to="/run/$runId"
            params={{ runId }}
            className="breadcrumb-btn"
          >
            {run.model}
          </Link>
          <span className="breadcrumb-separator">→</span>
          <Link
            to="/run/$runId/$category"
            params={{ runId, category }}
            className="breadcrumb-btn"
          >
            {formatCategoryName(category)}
          </Link>
          <span className="breadcrumb-separator">→</span>
          <span className="breadcrumb-current">{evalItem.name}</span>
        </div>
        <div className="flex items-center gap-3 mt-2">
          <span className="text-2xl">{getEvalStatusIcon(evalItem.status)}</span>
          <h1 className="text-xl font-bold text-white">{evalItem.name}</h1>
          {(evalItem.status.kind === "passed" || evalItem.status.kind === "failed") && (
            <span className="text-slate-500 text-sm">
              {formatDuration(evalItem.status.durationMs)}
            </span>
          )}
        </div>
        {evalItem.status.kind === "failed" && (
          <div className="mt-2 text-red-400 text-sm">
            {evalItem.status.failureReason}
          </div>
        )}
      </div>

      <div className="tab-nav px-6">
        <TabButton
          tab="steps"
          currentTab={tab}
          runId={runId}
          category={category}
          evalId={evalId}
        >
          📊 Steps
        </TabButton>
        <TabButton
          tab="task"
          currentTab={tab}
          runId={runId}
          category={category}
          evalId={evalId}
        >
          📋 Task
        </TabButton>
        <TabButton
          tab="answer"
          currentTab={tab}
          runId={runId}
          category={category}
          evalId={evalId}
        >
          💡 Answer
        </TabButton>
      </div>

      <div className="flex-1 overflow-hidden">
        {tab === "steps" ? (
          <StepsTab steps={evalItem.steps || []} evalStatus={evalItem.status} />
        ) : tab === "task" ? (
          <TaskTab category={category} evalName={evalItem.name} />
        ) : tab === "answer" ? (
          <AnswerTab category={category} evalName={evalItem.name} />
        ) : null}
      </div>
    </main>
  );
}

function TabButton({
  tab,
  currentTab,
  runId,
  category,
  evalId,
  children,
}: {
  tab: string;
  currentTab: string;
  runId: string;
  category: string;
  evalId: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      to="/run/$runId/$category/$evalId"
      params={{ runId, category, evalId }}
      search={{ tab }}
      className={`tab-button ${currentTab === tab ? "active" : ""}`}
    >
      {children}
    </Link>
  );
}

function StepsTab({
  steps,
  evalStatus,
}: {
  steps: Step[];
  evalStatus: { kind: string; failureReason?: string };
}) {
  // Sort steps by creation time
  const sortedSteps = [...steps].sort(
    (a, b) => a._creationTime - b._creationTime
  );

  // Define the expected step order
  const stepOrder: string[] = ["filesystem", "install", "deploy", "tsc", "eslint", "tests"];
  
  // Sort by expected order
  sortedSteps.sort((a, b) => {
    const aIndex = stepOrder.indexOf(a.name);
    const bIndex = stepOrder.indexOf(b.name);
    return aIndex - bIndex;
  });

  return (
    <div className="h-full overflow-auto p-6">
      <div className="max-w-2xl">
        <h3 className="text-lg font-semibold text-white mb-4">
          Execution Steps
        </h3>

        {sortedSteps.length === 0 ? (
          <div className="text-slate-400">No steps recorded yet</div>
        ) : (
          <div className="scores-list">
            {sortedSteps.map((step) => {
              const icon = getStepStatusIcon(step.status);
              const duration =
                step.status.kind === "passed" || step.status.kind === "failed"
                  ? formatDuration(step.status.durationMs)
                  : null;
              const statusClass =
                step.status.kind === "passed"
                  ? "pass"
                  : step.status.kind === "failed"
                    ? "fail"
                    : "";

              return (
                <div key={step._id} className={`score-item ${statusClass}`}>
                  <span className="score-icon">{icon}</span>
                  <span className="score-name">{formatStepName(step.name)}</span>
                  <span className="score-value">
                    {step.status.kind === "passed"
                      ? "Pass"
                      : step.status.kind === "failed"
                        ? "Fail"
                        : step.status.kind === "skipped"
                          ? "Skipped"
                          : "Running"}
                    {duration && (
                      <span className="text-slate-500 ml-2 text-xs">
                        ({duration})
                      </span>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {evalStatus.kind === "failed" && evalStatus.failureReason && (
          <div className="mt-6 p-4 bg-red-500/10 border border-red-500/30 rounded-lg">
            <h4 className="text-sm font-medium text-red-400 mb-2">
              Failure Reason
            </h4>
            <p className="text-slate-300">{evalStatus.failureReason}</p>
          </div>
        )}
      </div>
    </div>
  );
}

function TaskTab({
  category,
  evalName,
}: {
  category: string;
  evalName: string;
}) {
  const [taskContent, setTaskContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getTaskContent({ data: { category, evalName } })
      .then(setTaskContent)
      .catch((err: Error) => setError(err.message));
  }, [category, evalName]);

  if (error) {
    return (
      <div className="p-6 text-red-400">
        <p>Error loading task: {error}</p>
      </div>
    );
  }

  if (taskContent === null) {
    return <div className="p-6 text-slate-400">Loading task...</div>;
  }

  return (
    <div className="h-full overflow-auto">
      <div className="p-6">
        <pre className="whitespace-pre-wrap text-slate-300 font-mono text-sm">
          {taskContent}
        </pre>
      </div>
    </div>
  );
}

function AnswerTab({
  category,
  evalName,
}: {
  category: string;
  evalName: string;
}) {
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getAnswerDirectory({ data: { category, evalName } })
      .then(setFiles)
      .catch((err: Error) => setError(err.message));
  }, [category, evalName]);

  const handleFileClick = async (filePath: string) => {
    setSelectedFile(filePath);
    try {
      const content = await getFileContent({ data: { filePath } });
      setFileContent(content);
    } catch (err: unknown) {
      setFileContent(
        `Error loading file: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  };

  if (error) {
    return (
      <div className="p-6 text-red-400">
        <p>Error loading answer directory: {error}</p>
      </div>
    );
  }

  return (
    <div className="flex h-full">
      <div className="file-tree">
        <div className="file-tree-header">Answer Directory</div>
        <div className="p-2">
          <FileTree
            files={files}
            onFileClick={handleFileClick}
            selectedFile={selectedFile}
          />
        </div>
      </div>
      <div className="file-viewer">
        <div className="file-viewer-header">
          {selectedFile ? selectedFile.split(/[/\\]/).pop() : "Select a file"}
        </div>
        <pre className="file-content">
          {fileContent ?? "Select a file to view its contents"}
        </pre>
      </div>
    </div>
  );
}

function FileTree({
  files,
  onFileClick,
  selectedFile,
}: {
  files: FileEntry[];
  onFileClick: (path: string) => void;
  selectedFile: string | null;
}) {
  return (
    <>
      {files.map((file) =>
        file.isDirectory ? (
          <DirectoryItem
            key={file.path}
            file={file}
            onFileClick={onFileClick}
            selectedFile={selectedFile}
          />
        ) : (
          <button
            key={file.path}
            className={`file-tree-item file ${selectedFile === file.path ? "active" : ""}`}
            onClick={() => onFileClick(file.path)}
          >
            📄 {file.name}
          </button>
        )
      )}
    </>
  );
}

function DirectoryItem({
  file,
  onFileClick,
  selectedFile,
}: {
  file: FileEntry;
  onFileClick: (path: string) => void;
  selectedFile: string | null;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [children, setChildren] = useState<FileEntry[]>([]);

  const handleToggle = async () => {
    if (!isExpanded && children.length === 0) {
      try {
        const items = await browseDirectory({ data: { dirPath: file.path } });
        setChildren(items);
      } catch (err: unknown) {
        console.error("Error loading directory:", err);
      }
    }
    setIsExpanded(!isExpanded);
  };

  return (
    <div>
      <button className="file-tree-item directory" onClick={handleToggle}>
        <span>📁 {file.name}</span>
        <span className={`expand-arrow ${isExpanded ? "expanded" : ""}`}>
          ▶
        </span>
      </button>
      {isExpanded && (
        <div className="file-tree-children">
          <FileTree
            files={children}
            onFileClick={onFileClick}
            selectedFile={selectedFile}
          />
        </div>
      )}
    </div>
  );
}

function formatCategoryName(category: string): string {
  return category
    .replace(/^\d+-/, "")
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
