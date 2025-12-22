import {
  createFileRoute,
  useParams,
  Link,
  useSearch,
} from "@tanstack/react-router";
import { useState, useEffect } from "react";
import {
  getResults,
  getTaskContent,
  getLogContent,
  browseDirectory,
  getFileContent,
  getAnswerDirectory,
} from "../lib/data";
import { getPassFailIcon } from "../lib/types";
import type { FileEntry, IndividualResult } from "../lib/types";

export const Route = createFileRoute("/run/$runIndex/$category/$evalName")({
  validateSearch: (search: Record<string, unknown>) => ({
    tab: (search.tab as string) ?? "log",
  }),
  loader: () => getResults(),
  component: EvalDetailsPage,
});

function EvalDetailsPage() {
  const results = Route.useLoaderData();
  const { runIndex, category, evalName } = useParams({
    from: "/run/$runIndex/$category/$evalName",
  });
  const { tab } = useSearch({ from: "/run/$runIndex/$category/$evalName" });
  const runIdx = parseInt(runIndex, 10);
  const result = results[runIdx];

  if (!result) {
    return <div className="p-8 text-red-400">Run not found</div>;
  }

  const evalResult = (result.individual_results ?? []).find(
    (r) => r.category === category && r.name === evalName,
  );

  if (!evalResult) {
    return <div className="p-8 text-red-400">Evaluation not found</div>;
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
            to="/run/$runIndex"
            params={{ runIndex }}
            className="breadcrumb-btn"
          >
            {result.model_name ?? "Unknown Model"}
          </Link>
          <span className="breadcrumb-separator">→</span>
          <Link
            to="/run/$runIndex/$category"
            params={{ runIndex, category }}
            className="breadcrumb-btn"
          >
            {category}
          </Link>
          <span className="breadcrumb-separator">→</span>
          <span className="breadcrumb-current">{evalName}</span>
        </div>
        <div className="flex items-center gap-3 mt-2">
          <span className="text-2xl">{getPassFailIcon(evalResult.passed)}</span>
          <h1 className="text-xl font-bold text-white">{evalName}</h1>
        </div>
      </div>

      <div className="tab-nav px-6">
        <TabButton
          tab="log"
          currentTab={tab}
          runIndex={runIndex}
          category={category}
          evalName={evalName}
        >
          📄 Log
        </TabButton>
        <TabButton
          tab="task"
          currentTab={tab}
          runIndex={runIndex}
          category={category}
          evalName={evalName}
        >
          📋 Task
        </TabButton>
        <TabButton
          tab="steps"
          currentTab={tab}
          runIndex={runIndex}
          category={category}
          evalName={evalName}
        >
          📊 Steps
        </TabButton>
        <TabButton
          tab="answer"
          currentTab={tab}
          runIndex={runIndex}
          category={category}
          evalName={evalName}
        >
          💡 Answer
        </TabButton>
        <TabButton
          tab="output"
          currentTab={tab}
          runIndex={runIndex}
          category={category}
          evalName={evalName}
        >
          📁 Output
        </TabButton>
      </div>

      <div className="flex-1 overflow-hidden">
        {tab === "log" ? (
          <LogTab evalResult={evalResult} />
        ) : tab === "task" ? (
          <TaskTab category={category} evalName={evalName} />
        ) : tab === "steps" ? (
          <StepsTab evalResult={evalResult} />
        ) : tab === "answer" ? (
          <AnswerTab category={category} evalName={evalName} />
        ) : tab === "output" ? (
          <OutputTab
            evalResult={evalResult}
            category={category}
            evalName={evalName}
          />
        ) : null}
      </div>
    </main>
  );
}

function TabButton({
  tab,
  currentTab,
  runIndex,
  category,
  evalName,
  children,
}: {
  tab: string;
  currentTab: string;
  runIndex: string;
  category: string;
  evalName: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      to="/run/$runIndex/$category/$evalName"
      params={{ runIndex, category, evalName }}
      search={{ tab }}
      className={`tab-button ${currentTab === tab ? "active" : ""}`}
    >
      {children}
    </Link>
  );
}

function LogTab({ evalResult }: { evalResult: IndividualResult }) {
  const [logContent, setLogContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!evalResult.directory_path) {
      setError("No directory path available");
      return;
    }

    const logPath = `${evalResult.directory_path}/run.log`;
    getLogContent({ data: { logPath } })
      .then(setLogContent)
      .catch((err) => setError(err.message));
  }, [evalResult.directory_path]);

  if (error) {
    return (
      <div className="p-6 text-red-400">
        <p>Error loading log: {error}</p>
      </div>
    );
  }

  if (logContent === null) {
    return <div className="p-6 text-slate-400">Loading log...</div>;
  }

  return (
    <div className="h-full overflow-auto">
      <pre className="file-content">{logContent}</pre>
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
      .catch((err) => setError(err.message));
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

function StepsTab({ evalResult }: { evalResult: IndividualResult }) {
  const scores = evalResult.scores ?? {};

  return (
    <div className="h-full overflow-auto p-6">
      <div className="max-w-2xl">
        <h3 className="text-lg font-semibold text-white mb-4">
          Score Breakdown
        </h3>
        <div className="scores-list">
          {Object.entries(scores).map(([key, value]) => {
            const status = value === 1 ? "pass" : "fail";
            const icon = value === 1 ? "✅" : "❌";
            return (
              <div key={key} className={`score-item ${status}`}>
                <span className="score-icon">{icon}</span>
                <span className="score-name">{key}</span>
                <span className="score-value">
                  {value === 1 ? "Pass" : "Fail"}
                </span>
              </div>
            );
          })}
        </div>

        {evalResult.failure_reason ? (
          <div className="mt-6 p-4 bg-red-500/10 border border-red-500/30 rounded-lg">
            <h4 className="text-sm font-medium text-red-400 mb-2">
              Failure Reason
            </h4>
            <p className="text-slate-300">{evalResult.failure_reason}</p>
          </div>
        ) : null}
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
      .catch((err) => setError(err.message));
  }, [category, evalName]);

  const handleFileClick = async (filePath: string) => {
    setSelectedFile(filePath);
    try {
      const content = await getFileContent({ data: { filePath } });
      setFileContent(content);
    } catch (err: unknown) {
      setFileContent(
        `Error loading file: ${err instanceof Error ? err.message : String(err)}`,
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

function OutputTab({
  evalResult,
  category,
  evalName,
}: {
  evalResult: IndividualResult;
  category: string;
  evalName: string;
}) {
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [answerContent, setAnswerContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!evalResult.directory_path) {
      setError("No directory path available");
      return;
    }

    browseDirectory({ data: { dirPath: evalResult.directory_path } })
      .then(setFiles)
      .catch((err) => setError(err.message));
  }, [evalResult.directory_path]);

  const handleFileClick = async (filePath: string) => {
    setSelectedFile(filePath);
    try {
      const content = await getFileContent({ data: { filePath } });
      setFileContent(content);

      // Try to load corresponding answer file
      const fileName = filePath.split(/[/\\]/).pop();
      if (fileName) {
        try {
          const answer = await getFileContent({
            data: {
              filePath: `evals/${category}/${evalName}/answer/${fileName}`,
            },
          });
          setAnswerContent(answer);
        } catch {
          setAnswerContent(null);
        }
      }
    } catch (err: unknown) {
      setFileContent(
        `Error loading file: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  if (error) {
    return (
      <div className="p-6 text-red-400">
        <p>Error loading output directory: {error}</p>
      </div>
    );
  }

  return (
    <div className="flex h-full">
      <div className="file-tree">
        <div className="file-tree-header">Output Directory</div>
        <div className="p-2">
          <FileTree
            files={files}
            onFileClick={handleFileClick}
            selectedFile={selectedFile}
          />
        </div>
      </div>
      <div className="file-content-split">
        <div className="file-content-pane">
          <div className="file-content-header">Generated Output</div>
          <pre className="file-content">
            {fileContent ?? "Select a file to view its contents"}
          </pre>
        </div>
        <div className="split-handle" />
        <div className="file-content-pane">
          <div className="file-content-header answer">Answer (Reference)</div>
          <pre className="file-content">
            {answerContent ?? "No corresponding answer file"}
          </pre>
        </div>
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
        ),
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
      } catch (err) {
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
      {isExpanded ? (
        <div className="file-tree-children">
          <FileTree
            files={children}
            onFileClick={onFileClick}
            selectedFile={selectedFile}
          />
        </div>
      ) : null}
    </div>
  );
}
