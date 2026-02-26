import { useState, useEffect, useMemo, lazy, Suspense } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import JSZip from "jszip";
import { api } from "../convex/api";
import type { Id } from "../convex/types";

// Lazy load Monaco Editor to avoid SSR issues
const Editor = lazy(() => 
  import("@monaco-editor/react").then((mod) => ({ default: mod.default }))
);
import {
  getStepStatusIcon,
  formatDuration,
  formatStepName,
  type Step,
  type EvalStatus,
} from "./types";

// Types for zip file entries
export interface ZipFileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  content?: string;
}

// Route path type for tabs
type RoutePath =
  | "/experiment/$experimentId/run/$runId/$category/$evalId"
  | "/model/$model/experiment/$experimentId/run/$runId/$category/$evalId";

export function StepsTab({
  steps,
  evalStatus,
  routePath,
  model,
  experimentId,
  runId,
  category,
  evalId,
}: {
  steps: Step[];
  evalStatus: { kind: string; failureReason?: string };
  routePath: RoutePath;
  model?: string;
  experimentId?: string;
  runId: string;
  category: string;
  evalId: string;
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

  const linkParams = model && experimentId
    ? { model, experimentId, runId, category, evalId }
    : experimentId
      ? { experimentId, runId, category, evalId }
      : { runId, category, evalId };

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
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-sm font-medium text-red-400">
                Failure Reason
              </h4>
              <Link
                to={routePath}
                params={linkParams as any}
                search={{ tab: "output", file: "run.log" }}
                className="text-xs px-3 py-1 bg-slate-700 hover:bg-slate-600 text-slate-300 rounded transition-colors"
              >
                View Log →
              </Link>
            </div>
            <p className="text-slate-300">{evalStatus.failureReason}</p>
          </div>
        )}
      </div>
    </div>
  );
}

export function OutputTab({
  evalStatus,
  routePath,
  model,
  experimentId,
  runId,
  category,
  evalId,
  initialFile,
}: {
  evalStatus: EvalStatus;
  routePath: RoutePath;
  model?: string;
  experimentId?: string;
  runId: string;
  category: string;
  evalId: string;
  initialFile?: string;
}) {
  const navigate = useNavigate();
  const [files, setFiles] = useState<ZipFileEntry[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(initialFile ?? null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const linkParams = model && experimentId
    ? { model, experimentId, runId, category, evalId }
    : experimentId
      ? { experimentId, runId, category, evalId }
      : { runId, category, evalId };

  // Update URL when file selection changes
  const handleFileSelect = (filePath: string) => {
    setSelectedFile(filePath);
    navigate({
      to: routePath,
      params: linkParams as any,
      search: { tab: "output", file: filePath },
      replace: true,
    });
  };

  // Get the storage ID from the status (available during running, passed, or failed)
  const storageId = useMemo(() => {
    if (evalStatus.kind === "running" || evalStatus.kind === "passed" || evalStatus.kind === "failed") {
      return evalStatus.outputStorageId;
    }
    return undefined;
  }, [evalStatus]);

  // Query for the download URL
  const downloadUrl = useQuery(
    api.runs.getOutputUrl,
    storageId ? { storageId: storageId as Id<"_storage"> } : "skip"
  );

  // Fetch and extract zip when URL is available
  useEffect(() => {
    if (!downloadUrl) {
      setLoading(false);
      return;
    }

    const fetchAndExtract = async () => {
      setLoading(true);
      setError(null);

      try {
        const response = await fetch(downloadUrl);
        if (!response.ok) {
          throw new Error(`Failed to fetch zip: ${response.status}`);
        }

        const blob = await response.blob();
        const zip = await JSZip.loadAsync(blob);

        const extractedFiles: ZipFileEntry[] = [];

        // Extract all files from the zip
        for (const [path, zipEntry] of Object.entries(zip.files)) {
          if (zipEntry.dir) {
            extractedFiles.push({
              name: path.split("/").filter(Boolean).pop() || path,
              path,
              isDirectory: true,
            });
          } else {
            // Read text content for text files
            let content: string | undefined;
            const ext = path.split(".").pop()?.toLowerCase();
            const isTextFile = [
              "ts", "tsx", "js", "jsx", "json", "md", "txt", "html", "css",
              "yaml", "yml", "toml", "env", "log", "gitignore", "npmrc"
            ].includes(ext || "");

            if (isTextFile) {
              content = await zipEntry.async("string");
            }

            extractedFiles.push({
              name: path.split("/").filter(Boolean).pop() || path,
              path,
              isDirectory: false,
              content,
            });
          }
        }

        // Sort files: directories first, then alphabetically
        extractedFiles.sort((a, b) => {
          if (a.isDirectory !== b.isDirectory) {
            return a.isDirectory ? -1 : 1;
          }
          return a.path.localeCompare(b.path);
        });

        setFiles(extractedFiles);
        
        // Default to run.log if available and no file is pre-selected
        if (!initialFile) {
          const runLog = extractedFiles.find((f) => f.path === "run.log");
          if (runLog) {
            setSelectedFile("run.log");
          }
        }
        
        setLoading(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to extract zip");
        setLoading(false);
      }
    };

    fetchAndExtract();
  }, [downloadUrl, initialFile]);

  // Build file tree structure with implicit directories
  const fileTree = useMemo(() => {
    return buildFileTree(files);
  }, [files]);

  const selectedFileEntry = useMemo(() => {
    return files.find((f) => f.path === selectedFile);
  }, [files, selectedFile]);

  if (!storageId) {
    return (
      <div className="p-6 text-slate-400">
        <p>No output files available for this evaluation.</p>
        <p className="text-sm mt-2">
          Output files are only available for completed evaluations.
        </p>
      </div>
    );
  }

  if (downloadUrl === undefined || loading) {
    return (
      <div className="p-6 text-slate-400">
        <p>Loading output files...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6 text-red-400">
        <p>Error loading output: {error}</p>
      </div>
    );
  }

  if (files.length === 0) {
    return (
      <div className="p-6 text-slate-400">
        <p>No files found in output archive.</p>
      </div>
    );
  }

  return (
    <div className="flex h-full">
      <div className="file-tree">
        <div className="file-tree-header">
          Model Output
          <span className="text-xs text-slate-500 ml-2">
            ({files.filter((f) => !f.isDirectory).length} files)
          </span>
        </div>
        <div className="p-2">
          <ZipFileTree
            files={fileTree.get("") || []}
            fileTree={fileTree}
            onFileClick={handleFileSelect}
            selectedFile={selectedFile}
          />
        </div>
      </div>
      <div className="file-viewer">
        <div className="file-viewer-header">
          {selectedFile ? selectedFile : "Select a file"}
        </div>
        <FileViewer
          content={selectedFileEntry?.content}
          filename={selectedFile}
          isDirectory={selectedFileEntry?.isDirectory}
        />
      </div>
    </div>
  );
}

export function TaskTab({
  evalSourceStorageId,
  routePath,
  model,
  experimentId,
  runId,
  category,
  evalId,
  initialFile,
}: {
  evalSourceStorageId?: string;
  routePath: RoutePath;
  model?: string;
  experimentId?: string;
  runId: string;
  category: string;
  evalId: string;
  initialFile?: string;
}) {
  const navigate = useNavigate();
  const [files, setFiles] = useState<ZipFileEntry[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(initialFile ?? null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const linkParams = model && experimentId
    ? { model, experimentId, runId, category, evalId }
    : experimentId
      ? { experimentId, runId, category, evalId }
      : { runId, category, evalId };

  // Update URL when file selection changes
  const handleFileSelect = (filePath: string) => {
    setSelectedFile(filePath);
    navigate({
      to: routePath,
      params: linkParams as any,
      search: { tab: "task", file: filePath },
      replace: true,
    });
  };

  // Query for the download URL
  const downloadUrl = useQuery(
    api.runs.getOutputUrl,
    evalSourceStorageId ? { storageId: evalSourceStorageId as Id<"_storage"> } : "skip"
  );

  // Fetch and extract zip when URL is available
  useEffect(() => {
    if (!downloadUrl) {
      setLoading(false);
      return;
    }

    const fetchAndExtract = async () => {
      setLoading(true);
      setError(null);

      try {
        const response = await fetch(downloadUrl);
        if (!response.ok) {
          throw new Error(`Failed to fetch zip: ${response.status}`);
        }

        const blob = await response.blob();
        const zip = await JSZip.loadAsync(blob);

        const extractedFiles: ZipFileEntry[] = [];

        // Extract all files from the zip
        for (const [path, zipEntry] of Object.entries(zip.files)) {
          if (zipEntry.dir) {
            extractedFiles.push({
              name: path.split("/").filter(Boolean).pop() || path,
              path,
              isDirectory: true,
            });
          } else {
            // Read text content for text files
            let content: string | undefined;
            const ext = path.split(".").pop()?.toLowerCase();
            const isTextFile = [
              "ts", "tsx", "js", "jsx", "json", "md", "txt", "html", "css",
              "yaml", "yml", "toml", "env", "log", "gitignore", "npmrc"
            ].includes(ext || "");

            if (isTextFile) {
              content = await zipEntry.async("string");
            }

            extractedFiles.push({
              name: path.split("/").filter(Boolean).pop() || path,
              path,
              isDirectory: false,
              content,
            });
          }
        }

        // Sort files: directories first, then alphabetically
        extractedFiles.sort((a, b) => {
          if (a.isDirectory !== b.isDirectory) {
            return a.isDirectory ? -1 : 1;
          }
          return a.path.localeCompare(b.path);
        });

        setFiles(extractedFiles);
        
        // Default to TASK.txt if available and no file is pre-selected
        if (!initialFile) {
          const taskTxt = extractedFiles.find((f) => f.path === "TASK.txt");
          if (taskTxt) {
            setSelectedFile("TASK.txt");
          }
        }
        
        setLoading(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to extract zip");
        setLoading(false);
      }
    };

    fetchAndExtract();
  }, [downloadUrl, initialFile]);

  // Build file tree structure with implicit directories
  const fileTree = useMemo(() => {
    return buildFileTree(files);
  }, [files]);

  const selectedFileEntry = useMemo(() => {
    return files.find((f) => f.path === selectedFile);
  }, [files, selectedFile]);

  if (!evalSourceStorageId) {
    return (
      <div className="p-6 text-slate-400">
        <p>No task files available.</p>
        <p className="text-sm mt-2">
          Task files are stored for newer evaluations.
        </p>
      </div>
    );
  }

  if (downloadUrl === undefined || loading) {
    return (
      <div className="p-6 text-slate-400">
        <p>Loading task files...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6 text-red-400">
        <p>Error loading task: {error}</p>
      </div>
    );
  }

  if (files.length === 0) {
    return (
      <div className="p-6 text-slate-400">
        <p>No files found in task archive.</p>
      </div>
    );
  }

  return (
    <div className="flex h-full">
      <div className="file-tree">
        <div className="file-tree-header">
          Task
          <span className="text-xs text-slate-500 ml-2">
            ({files.filter((f) => !f.isDirectory).length} files)
          </span>
        </div>
        <div className="p-2">
          <ZipFileTree
            files={fileTree.get("") || []}
            fileTree={fileTree}
            onFileClick={handleFileSelect}
            selectedFile={selectedFile}
          />
        </div>
      </div>
      <div className="file-viewer">
        <div className="file-viewer-header">
          {selectedFile ? selectedFile : "Select a file"}
        </div>
        <FileViewer
          content={selectedFileEntry?.content}
          filename={selectedFile}
          isDirectory={selectedFileEntry?.isDirectory}
        />
      </div>
    </div>
  );
}

function buildFileTree(files: ZipFileEntry[]): Map<string, ZipFileEntry[]> {
  const tree: Map<string, ZipFileEntry[]> = new Map();
  tree.set("", []); // Root level
  const directoriesAdded = new Set<string>();

  // Helper to ensure all parent directories exist
  const ensureDirectories = (filePath: string) => {
    const parts = filePath.split("/").filter(Boolean);
    for (let i = 1; i < parts.length; i++) {
      const dirPath = parts.slice(0, i).join("/") + "/";
      if (!directoriesAdded.has(dirPath)) {
        directoriesAdded.add(dirPath);
        const dirEntry: ZipFileEntry = {
          name: parts[i - 1],
          path: dirPath,
          isDirectory: true,
        };
        if (!tree.has(dirPath)) {
          tree.set(dirPath, []);
        }
        const parentPath = i === 1 ? "" : parts.slice(0, i - 1).join("/") + "/";
        if (!tree.has(parentPath)) {
          tree.set(parentPath, []);
        }
        const parentList = tree.get(parentPath)!;
        if (!parentList.find((f) => f.path === dirPath)) {
          parentList.push(dirEntry);
        }
      }
    }
  };

  for (const file of files) {
    if (file.isDirectory) {
      const normalizedPath = file.path.endsWith("/") ? file.path : file.path + "/";
      ensureDirectories(normalizedPath);
    } else {
      const parts = file.path.split("/").filter(Boolean);
      if (parts.length > 1) {
        ensureDirectories(file.path);
        const parentPath = parts.slice(0, -1).join("/") + "/";
        if (!tree.has(parentPath)) {
          tree.set(parentPath, []);
        }
        tree.get(parentPath)!.push(file);
      } else {
        tree.get("")!.push(file);
      }
    }
  }

  for (const [, children] of tree) {
    children.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) {
        return a.isDirectory ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });
  }

  return tree;
}

function FileViewer({
  content,
  filename,
  isDirectory,
}: {
  content?: string;
  filename: string | null;
  isDirectory?: boolean;
}) {
  if (!filename) {
    return (
      <div className="file-content text-slate-500">
        Select a file to view its contents
      </div>
    );
  }

  if (isDirectory) {
    return (
      <div className="file-content text-slate-500">
        Select a file to view its contents
      </div>
    );
  }

  if (content === undefined) {
    return (
      <div className="file-content text-slate-500">
        Binary file - cannot display
      </div>
    );
  }

  const language = getLanguageFromFilename(filename);

  return (
    <Suspense fallback={<div className="file-content text-slate-500">Loading editor...</div>}>
      <Editor
        height="100%"
        language={language}
        value={content}
        theme="vs-dark"
        options={{
          readOnly: true,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          fontSize: 13,
          lineNumbers: "on",
          renderLineHighlight: "none",
          scrollbar: {
            vertical: "auto",
            horizontal: "auto",
          },
          wordWrap: language === "plaintext" ? "on" : "off",
          padding: { top: 12, bottom: 12 },
        }}
      />
    </Suspense>
  );
}

function getLanguageFromFilename(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  const languageMap: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    json: "json",
    md: "markdown",
    html: "html",
    css: "css",
    scss: "scss",
    less: "less",
    yaml: "yaml",
    yml: "yaml",
    toml: "toml",
    xml: "xml",
    sql: "sql",
    sh: "shell",
    bash: "shell",
    zsh: "shell",
    py: "python",
    rb: "ruby",
    go: "go",
    rs: "rust",
    java: "java",
    kt: "kotlin",
    swift: "swift",
    c: "c",
    cpp: "cpp",
    h: "c",
    hpp: "cpp",
    cs: "csharp",
    php: "php",
    log: "plaintext",
    txt: "plaintext",
    env: "plaintext",
    gitignore: "plaintext",
    npmrc: "plaintext",
    dockerfile: "dockerfile",
  };

  const lowerFilename = filename.toLowerCase();
  if (lowerFilename === "dockerfile") return "dockerfile";
  if (lowerFilename === "makefile") return "makefile";
  if (lowerFilename.endsWith(".d.ts")) return "typescript";

  return languageMap[ext || ""] || "plaintext";
}

export function ZipFileTree({
  files,
  fileTree,
  onFileClick,
  selectedFile,
}: {
  files: ZipFileEntry[];
  fileTree: Map<string, ZipFileEntry[]>;
  onFileClick: (path: string) => void;
  selectedFile: string | null;
}) {
  return (
    <>
      {files.map((file) =>
        file.isDirectory ? (
          <ZipDirectoryItem
            key={file.path}
            file={file}
            fileTree={fileTree}
            onFileClick={onFileClick}
            selectedFile={selectedFile}
          />
        ) : (
          <button
            key={file.path}
            className={`file-tree-item file ${selectedFile === file.path ? "active" : ""}`}
            onClick={() => onFileClick(file.path)}
          >
            {getFileIcon(file.name)} {file.name}
          </button>
        )
      )}
    </>
  );
}

function ZipDirectoryItem({
  file,
  fileTree,
  onFileClick,
  selectedFile,
}: {
  file: ZipFileEntry;
  fileTree: Map<string, ZipFileEntry[]>;
  onFileClick: (path: string) => void;
  selectedFile: string | null;
}) {
  const [isExpanded, setIsExpanded] = useState(true);

  const lookupPath = file.path.endsWith("/") ? file.path : file.path + "/";
  const children = fileTree.get(lookupPath) || [];

  return (
    <div>
      <button
        className="file-tree-item directory"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <span>📁 {file.name}</span>
        <span className={`expand-arrow ${isExpanded ? "expanded" : ""}`}>
          ▶
        </span>
      </button>
      {isExpanded && children.length > 0 && (
        <div className="file-tree-children">
          <ZipFileTree
            files={children}
            fileTree={fileTree}
            onFileClick={onFileClick}
            selectedFile={selectedFile}
          />
        </div>
      )}
    </div>
  );
}

function getFileIcon(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "ts":
    case "tsx":
      return "📘";
    case "js":
    case "jsx":
      return "📒";
    case "json":
      return "📋";
    case "md":
      return "📝";
    case "css":
      return "🎨";
    case "html":
      return "🌐";
    case "log":
      return "📜";
    default:
      return "📄";
  }
}

export function formatCategoryName(category: string): string {
  return category
    .replace(/^\d+-/, "")
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
