#!/usr/bin/env bun
// Web server to visualize local_results.jsonl evaluation data
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const RESULTS_FILE = resolve(process.cwd(), "local_results.jsonl");
const PORT = 3000;

interface EvalScore {
  name: string;
  score: number;
  improvements: number;
  regressions: number;
  diff: any;
  _longest_score_name?: number;
}

interface EvalSummary {
  project_name: string;
  project_id: string | null;
  experiment_id: string | null;
  experiment_name: string | null;
  project_url: string | null;
  experiment_url: string | null;
  comparison_experiment_name: string | null;
  scores: Record<string, EvalScore>;
  metrics: Record<string, any>;
}

interface IndividualResult {
  category: string;
  name: string;
  passed: boolean;
  tests_pass_score: number;
  failure_reason: string | null;
  directory_path: string | null;
  scores: Record<string, any>;
}

interface CategorySummary {
  total: number;
  passed: number;
  failed: number;
}

interface RunStats {
  total_tests: number;
  total_passed: number;
  total_failed: number;
  overall_score: number;
}

interface EvalResult {
  summary: EvalSummary;
  tempdir: string;
  model_name?: string;
  individual_results?: IndividualResult[];
  category_summaries?: Record<string, CategorySummary>;
  run_stats?: RunStats;
}

function readJsonlResults(): EvalResult[] {
  if (!existsSync(RESULTS_FILE)) {
    throw new Error(`Results file not found: ${RESULTS_FILE}`);
  }

  const content = readFileSync(RESULTS_FILE, { encoding: "utf-8" });
  const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);

  return lines.map((line) => {
    try {
      return JSON.parse(line) as EvalResult;
    } catch (err) {
      console.warn(`Failed to parse line: ${line}`);
      throw err;
    }
  });
}

function generateRunsListHTML(results: EvalResult[]): string {
  const runRows = results
    .map((result, index) => {
      const modelName = result.model_name || "Unknown Model";
      const timestamp = new Date().toLocaleString(); // TODO: Add actual timestamp from data
      const overallScore = result.run_stats?.overall_score || 0;
      const totalTests = result.run_stats?.total_tests || 0;
      const passedTests = result.run_stats?.total_passed || 0;

      const percentage = (overallScore * 100).toFixed(1);
      const statusClass =
        overallScore >= 0.9
          ? "excellent"
          : overallScore >= 0.7
            ? "good"
            : overallScore >= 0.5
              ? "fair"
              : "poor";
      const statusIcon =
        overallScore >= 0.9
          ? "🟢"
          : overallScore >= 0.7
            ? "🟡"
            : overallScore >= 0.5
              ? "🟠"
              : "🔴";

      return `
        <tr class="run-row ${statusClass}" onclick="showRunDetails(${index})" data-run-index="${index}">
          <td>
            <span class="status-icon">${statusIcon}</span>
            <strong>${modelName}</strong>
          </td>
          <td class="score-cell">
            <div class="score-bar-container">
              <div class="score-bar" style="width: ${percentage}%"></div>
              <span class="score-text">${percentage}%</span>
            </div>
          </td>
          <td class="numeric">${passedTests}/${totalTests}</td>
          <td class="timestamp">${timestamp}</td>
          <td class="tempdir-cell">
            <code>${result.tempdir || "N/A"}</code>
          </td>
        </tr>
      `;
    })
    .join("");

  return `
    <div class="runs-list">
      <div class="card">
        <div class="card-header">
          📊 Evaluation Runs
        </div>
        <div class="card-content">
          <div class="table-container">
            <table>
              <thead>
                <tr>
                  <th>Model</th>
                  <th>Overall Score</th>
                  <th>Pass/Total</th>
                  <th>Timestamp</th>
                  <th>Temp Directory</th>
                </tr>
              </thead>
              <tbody>
                ${runRows}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  `;
}

function generateRunDetailsHTML(result: EvalResult, runIndex: number): string {
  const modelName = result.model_name || "Unknown Model";
  const categoryRows = Object.entries(result.category_summaries || {})
    .map(([category, summary]) => {
      const percentage =
        summary.total > 0
          ? ((summary.passed / summary.total) * 100).toFixed(1)
          : "0.0";
      const statusClass =
        summary.passed === summary.total
          ? "pass"
          : summary.failed === summary.total
            ? "fail"
            : "warning";
      const statusIcon =
        summary.passed === summary.total
          ? "✅"
          : summary.failed === summary.total
            ? "❌"
            : "⚠️";

      return `
        <tr class="${statusClass}" onclick="showCategoryDetails('${category}', ${runIndex})">
          <td>
            <span class="status-icon">${statusIcon}</span>
            ${category}
          </td>
          <td class="score-cell">
            <div class="score-bar-container">
              <div class="score-bar" style="width: ${percentage}%"></div>
              <span class="score-text">${percentage}%</span>
            </div>
          </td>
          <td class="numeric">${summary.passed}/${summary.total}</td>
          <td class="numeric">${summary.failed}</td>
        </tr>
      `;
    })
    .join("");

  return `
    <div class="run-details">
      <div class="breadcrumb">
        <button onclick="showRunsList()" class="breadcrumb-btn">← All Runs</button>
        <span class="breadcrumb-current">${modelName}</span>
      </div>
      
      <div class="stats-grid">
        <div class="stat-card overall-score">
          <div class="stat-number">${((result.run_stats?.overall_score || 0) * 100).toFixed(1)}%</div>
          <div class="stat-label">Overall Score</div>
        </div>
        <div class="stat-card pass-rate">
          <div class="stat-number">${result.run_stats?.total_passed || 0}</div>
          <div class="stat-label">Tests Passed</div>
        </div>
        <div class="stat-card total-tests">
          <div class="stat-number">${result.run_stats?.total_failed || 0}</div>
          <div class="stat-label">Tests Failed</div>
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          📋 Category Breakdown
        </div>
        <div class="card-content">
          <div class="table-container">
            <table>
              <thead>
                <tr>
                  <th>Category</th>
                  <th>Success Rate</th>
                  <th>Passed</th>
                  <th>Failed</th>
                </tr>
              </thead>
              <tbody>
                ${categoryRows}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  `;
}

function generateCategoryDetailsHTML(
  category: string,
  result: EvalResult,
  runIndex: number,
): string {
  const modelName = result.model_name || "Unknown Model";
  const categoryResults = (result.individual_results || []).filter(
    (r) => r.category === category,
  );

  const individualRows = categoryResults
    .map((individualResult) => {
      const statusIcon = individualResult.passed ? "✅" : "❌";
      const statusClass = individualResult.passed ? "pass" : "fail";
      const failureReason = individualResult.failure_reason || "N/A";
      const directoryPath = individualResult.directory_path || "";

      // Convert Windows path to file:// URL for clickable links
      const fileUrl = directoryPath
        ? `file:///${directoryPath.replace(/\\/g, "/")}`
        : "";

      return `
         <tr class="${statusClass}">
           <td>
             <span class="status-icon">${statusIcon}</span>
             ${individualResult.name}
           </td>
           <td class="status-text">
             ${individualResult.passed ? "Pass" : failureReason}
           </td>
           <td class="directory-cell">
             ${directoryPath ? `<button onclick="openDirectory('${directoryPath.replace(/\\/g, "\\\\")}')" class="directory-link" title="Open directory">📁 Open</button>` : "N/A"}
             ${directoryPath ? `<button onclick="viewLog('${directoryPath.replace(/\\/g, "\\\\")}/run.log')" class="log-link" title="View run.log">📄 Log</button>` : ""}
           </td>
         </tr>
       `;
    })
    .join("");

  const categoryStats = result.category_summaries?.[category];
  const successRate = categoryStats
    ? ((categoryStats.passed / categoryStats.total) * 100).toFixed(1)
    : "0.0";

  return `
    <div class="category-details">
      <div class="breadcrumb">
        <button onclick="showRunsList()" class="breadcrumb-btn">All Runs</button>
        <span class="breadcrumb-separator">→</span>
        <button onclick="showRunDetails(${runIndex})" class="breadcrumb-btn">${modelName}</button>
        <span class="breadcrumb-separator">→</span>
        <span class="breadcrumb-current">${category}</span>
      </div>
      
      <div class="stats-grid">
        <div class="stat-card overall-score">
          <div class="stat-number">${successRate}%</div>
          <div class="stat-label">Success Rate</div>
        </div>
        <div class="stat-card pass-rate">
          <div class="stat-number">${categoryStats?.passed || 0}</div>
          <div class="stat-label">Passed</div>
        </div>
        <div class="stat-card total-tests">
          <div class="stat-number">${categoryStats?.failed || 0}</div>
          <div class="stat-label">Failed</div>
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          🔍 Individual Results - ${category}
        </div>
        <div class="card-content">
          <div class="table-container">
            <table>
              <thead>
                <tr>
                  <th>Evaluation</th>
                  <th>Status</th>
                  <th>Directory</th>
                </tr>
              </thead>
              <tbody>
                ${individualRows}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  `;
}

function generateRunsSidebar(
  results: EvalResult[],
  selectedRunIndex: number,
  selectedCategory: string = "",
): string {
  return results
    .map((result, index) => {
      const modelName = result.model_name || "Unknown Model";
      const overallScore = result.run_stats?.overall_score || 0;
      const percentage = (overallScore * 100).toFixed(1);
      const scoreClass =
        overallScore >= 0.9
          ? "score-excellent"
          : overallScore >= 0.7
            ? "score-good"
            : overallScore >= 0.5
              ? "score-fair"
              : "score-poor";
      const isActive = selectedRunIndex === index;

      // Generate categories accordion content
      const categories = result.category_summaries || {};
      const categoriesContent = Object.entries(categories)
        .map(([categoryName, stats]) => {
          const isSelectedCategory = selectedCategory === categoryName;
          return `
            <button class="category-accordion-item ${isSelectedCategory ? "active" : ""}" onclick="showCategoryDetails('${categoryName}', ${index})">
              <div class="category-item">
                <div class="category-name">${categoryName}</div>
                <div class="category-stats">${stats.passed}/${stats.total}</div>
              </div>
            </button>
          `;
        })
        .join("");

      const totalPassed = result.run_stats?.total_passed || 0;
      const totalTests = result.run_stats?.total_tests || 0;

      return `
        <div class="run-accordion">
          <button class="sidebar-item run-header ${isActive ? "active" : ""}" onclick="toggleRunAccordion(${index})">
            <div class="run-item">
              <div class="run-model">${modelName}</div>
              <div class="run-scores">
                <div class="run-score ${scoreClass}">${percentage}%</div>
                <div class="run-count">${totalPassed}/${totalTests}</div>
              </div>
              <div class="accordion-arrow ${isActive ? "expanded" : ""}">▼</div>
            </div>
          </button>
          <div class="categories-accordion ${isActive ? "expanded" : ""}">
            ${categoriesContent}
          </div>
        </div>
      `;
    })
    .join("");
}

function generateCategoriesSidebar(
  result: EvalResult,
  selectedCategory: string,
): string {
  const categories = result.category_summaries || {};
  return Object.entries(categories)
    .map(([categoryName, stats]) => {
      const successRate =
        stats.total > 0
          ? ((stats.passed / stats.total) * 100).toFixed(1)
          : "0.0";
      const isActive = selectedCategory === categoryName;

      return `
        <button class="sidebar-item ${isActive ? "active" : ""}" onclick="showCategoryDetails('${categoryName}', getCurrentRunIndex())">
          <div class="category-item">
            <div class="category-name">${categoryName}</div>
            <div class="category-stats">${stats.passed}/${stats.total}</div>
          </div>
        </button>
      `;
    })
    .join("");
}

function generateEvalsSidebar(
  result: EvalResult,
  selectedCategory: string,
  selectedEval: string = "",
): string {
  const categoryResults = (result.individual_results || []).filter(
    (r) => r.category === selectedCategory,
  );

  return categoryResults
    .map((evalResult) => {
      const isActive = selectedEval === evalResult.name;
      const statusClass = evalResult.passed ? "status-pass" : "status-fail";

      // Parse failure reasons from the scores object
      const failureReasons: string[] = [];
      if (!evalResult.passed && evalResult.scores) {
        Object.entries(evalResult.scores).forEach(([key, value]) => {
          if (value === 0) {
            if (key.toLowerCase().includes("test"))
              failureReasons.push("Tests");
            if (key.toLowerCase().includes("lint"))
              failureReasons.push("Linting");
            if (key.toLowerCase().includes("compile"))
              failureReasons.push("Compile");
            if (key.toLowerCase().includes("tsc"))
              failureReasons.push("TypeScript");
            if (key.toLowerCase().includes("filesystem"))
              failureReasons.push("Files");
            if (key.toLowerCase().includes("valid"))
              failureReasons.push("Validation");
          }
        });
      }

      // Also check failure_reason text for additional context
      if (!evalResult.passed && evalResult.failure_reason) {
        const reason = evalResult.failure_reason.toLowerCase();
        if (reason.includes("tsc") && !failureReasons.includes("TypeScript")) {
          failureReasons.push("TypeScript");
        }
        if (reason.includes("lint") && !failureReasons.includes("Linting")) {
          failureReasons.push("Linting");
        }
        if (reason.includes("test") && !failureReasons.includes("Tests")) {
          failureReasons.push("Tests");
        }
        if (
          reason.includes("convex dev") &&
          !failureReasons.includes("Convex Dev")
        ) {
          failureReasons.push("Convex Dev");
        }
      }

      const statusContent = evalResult.passed
        ? `<div class="eval-status ${statusClass}">Pass</div>`
        : `<div class="failure-reasons">
            ${failureReasons.map((reason) => `<span class="failure-reason">${reason}</span>`).join("")}
           </div>`;

      return `
        <button class="sidebar-item ${isActive ? "active" : ""}" onclick="showEvalDetails('${evalResult.name}', getCurrentRunIndex(), '${selectedCategory}')">
          <div class="eval-item">
            <div class="eval-name">${evalResult.name}</div>
            ${statusContent}
          </div>
        </button>
      `;
    })
    .join("");
}

function generateMainContent(
  results: EvalResult[],
  currentView: string,
  runIndex: number,
  category: string,
  evalName: string,
): string {
  if (currentView === "runs-list") {
    return `
      <div class="header">
        <h1>🚀 Convex Evaluation Results</h1>
        <p>Select a run from the sidebar to view detailed results</p>
      </div>
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-number">${results.length}</div>
          <div class="stat-label">Total Runs</div>
        </div>
      </div>
    `;
  } else if (currentView === "run-details" && runIndex >= 0) {
    const result = results[runIndex];
    const modelName = result.model_name || "Unknown Model";

    return `
      <div class="header">
        <h1>${modelName}</h1>
        <p>Select a category from the sidebar to view individual evaluations</p>
      </div>
      <div class="stats-grid">
        <div class="stat-card overall-score">
          <div class="stat-number">${((result.run_stats?.overall_score || 0) * 100).toFixed(1)}%</div>
          <div class="stat-label">Overall Score</div>
        </div>
        <div class="stat-card pass-rate">
          <div class="stat-number">${result.run_stats?.total_passed || 0}</div>
          <div class="stat-label">Tests Passed</div>
        </div>
        <div class="stat-card total-tests">
          <div class="stat-number">${result.run_stats?.total_failed || 0}</div>
          <div class="stat-label">Tests Failed</div>
        </div>
      </div>
    `;
  } else if (currentView === "category-details" && runIndex >= 0 && category) {
    const result = results[runIndex];
    const modelName = result.model_name || "Unknown Model";
    const categoryResults = (result.individual_results || []).filter(
      (r) => r.category === category,
    );

    const tableRows = categoryResults
      .map((individualResult) => {
        const statusIcon = individualResult.passed ? "✅" : "❌";
        const statusClass = individualResult.passed ? "pass" : "fail";
        const failureReason = individualResult.failure_reason || "N/A";
        const directoryPath = individualResult.directory_path || "";

        return `
          <tr class="${statusClass}">
            <td>
              <span class="status-icon">${statusIcon}</span>
              ${individualResult.name}
            </td>
            <td class="status-text">
              ${individualResult.passed ? "Pass" : failureReason}
            </td>
            <td class="directory-cell">
              ${directoryPath ? `<button onclick="openDirectory('${directoryPath.replace(/\\/g, "\\\\")}')" class="directory-link" title="Open directory">📁 Open</button>` : "N/A"}
              ${directoryPath ? `<button onclick="viewLog('${directoryPath.replace(/\\/g, "\\\\")}/run.log')" class="log-link" title="View run.log">📄 Log</button>` : ""}
            </td>
          </tr>
        `;
      })
      .join("");

    return `
      <div class="header">
        <h1>${modelName} - ${category}</h1>
        <p>Individual evaluation results for this category</p>
      </div>
      
      <div class="card">
        <div class="card-header">
          🔍 Individual Results - ${category}
        </div>
        <div class="card-content">
          <div class="table-container">
            <table>
              <thead>
                <tr>
                  <th>Evaluation</th>
                  <th>Status</th>
                  <th>Directory</th>
                </tr>
              </thead>
              <tbody>
                ${tableRows}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    `;
  } else if (
    currentView === "eval-details" &&
    runIndex >= 0 &&
    category &&
    evalName
  ) {
    const result = results[runIndex];
    const modelName = result.model_name || "Unknown Model";
    const evalResult = (result.individual_results || []).find(
      (r) => r.category === category && r.name === evalName,
    );

    if (!evalResult) {
      return '<div class="header"><h1>Evaluation not found</h1></div>';
    }

    // Get detailed scores
    const scoresBreakdown = Object.entries(evalResult.scores || {})
      .map(([key, value]) => {
        const status = value === 1 ? "pass" : "fail";
        const icon = value === 1 ? "✅" : "❌";
        return `
          <div class="score-item ${status}">
            <span class="score-icon">${icon}</span>
            <span class="score-name">${key}</span>
            <span class="score-value">${value === 1 ? "Pass" : "Fail"}</span>
          </div>
        `;
      })
      .join("");

    return `
      <div class="eval-details-grid">
        <div class="card">
          <div class="card-header">
            📋 Task Description
          </div>
          <div class="card-content">
            <div class="task-content" id="task-content-${category}-${evalName}">
              <p><em>Loading task description...</em></p>
            </div>
          </div>
        </div>
        
        <div class="card">
          <div class="card-header">
            🔍 Score Breakdown
          </div>
          <div class="card-content">
            <div class="scores-list">
              ${scoresBreakdown}
            </div>
          </div>
        </div>
        
        <div class="card full-width">
          <div class="card-header">
            📁 Files & Logs
          </div>
          <div class="card-content">
            <div class="directory-info">
              ${
                evalResult.directory_path
                  ? `
                <div class="directory-path">
                  <strong>Directory:</strong> <code>${evalResult.directory_path}</code>
                  <button onclick="openDirectory('${evalResult.directory_path.replace(/\\/g, "\\\\")}')" class="action-button">
                    📁 Open
                  </button>
                </div>
              `
                  : "<p>No directory information available</p>"
              }
            </div>
            <div class="run-log-content" id="run-log-content-${category}-${evalName}">
              <p><em>Loading run log...</em></p>
            </div>
          </div>
        </div>
        
        <script>
          // Auto-load task file and run log when page loads
          (async function() {
            // Load task file
            try {
              const response = await fetch(\`/task/\${encodeURIComponent('${category}')}/\${encodeURIComponent('${evalName}')}\`);
              const taskElement = document.getElementById('task-content-${category}-${evalName}');
              if (response.ok) {
                const data = await response.json();
                if (taskElement) {
                  taskElement.innerHTML = \`<pre style="white-space: pre-wrap; background: #f8fafc; padding: 1rem; border-radius: 4px; border: 1px solid #e5e7eb; margin: 0; font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace; font-size: 0.875rem; line-height: 1.5;">\${data.content}</pre>\`;
                }
              } else {
                if (taskElement) {
                  taskElement.innerHTML = '<p style="color: #dc2626;">Task file not found.</p>';
                }
              }
            } catch (error) {
              const taskElement = document.getElementById('task-content-${category}-${evalName}');
              if (taskElement) {
                taskElement.innerHTML = \`<p style="color: #dc2626;">Error loading task: \${error.message}</p>\`;
              }
            }
            
            // Load run log
            ${
              evalResult.directory_path
                ? `
            try {
              const logPath = '${evalResult.directory_path.replace(/\\/g, "/")}/run.log';
              const response = await fetch(\`/logs/\${encodeURIComponent(logPath)}\`);
              const logElement = document.getElementById('run-log-content-${category}-${evalName}');
              if (response.ok) {
                const logContent = await response.text();
                if (logElement) {
                  logElement.innerHTML = \`<pre style="white-space: pre-wrap; background: #1f2937; color: #f3f4f6; padding: 1rem; border-radius: 4px; margin: 0; font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace; font-size: 0.875rem; line-height: 1.4; max-height: 400px; overflow-y: auto;">\${logContent}</pre>\`;
                }
              } else {
                if (logElement) {
                  logElement.innerHTML = '<p style="color: #dc2626;">Run log not found.</p>';
                }
              }
            } catch (error) {
              const logElement = document.getElementById('run-log-content-${category}-${evalName}');
              if (logElement) {
                logElement.innerHTML = \`<p style="color: #dc2626;">Error loading log: \${error.message}</p>\`;
              }
            }
            `
                : `
            const logElement = document.getElementById('run-log-content-${category}-${evalName}');
            if (logElement) {
              logElement.innerHTML = '<p style="color: #6b7280;">No log available - directory path not found.</p>';
            }
            `
            }
          })();
        </script>
      </div>
    `;
  }

  return '<div class="header"><h1>Select a run to get started</h1></div>';
}

function generateHTML(
  results: EvalResult[],
  currentView: string = "runs-list",
  runIndex: number = -1,
  category: string = "",
  evalName: string = "",
): string {
  const runsListHTML = generateRunsListHTML(results);

  // Generate details for each run (but hidden initially)
  const runDetailsHTML = results
    .map((result, index) => generateRunDetailsHTML(result, index))
    .join("");

  // Generate category details for each run and category (but hidden initially)
  const categoryDetailsHTML = results
    .map((result, runIndex) => {
      return Object.keys(result.category_summaries || {})
        .map((category) =>
          generateCategoryDetailsHTML(category, result, runIndex),
        )
        .join("");
    })
    .join("");

  // Generate sidebar content
  const runsSidebarHTML = generateRunsSidebar(results, runIndex, category);
  const categoriesSidebarHTML =
    runIndex >= 0 ? generateCategoriesSidebar(results[runIndex], category) : "";
  const evalsSidebarHTML =
    runIndex >= 0 && category
      ? generateEvalsSidebar(results[runIndex], category, evalName)
      : "";
  const mainContentHTML = generateMainContent(
    results,
    currentView,
    runIndex,
    category,
    evalName,
  );

  return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Convex Evaluation Results</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #f8fafc;
            min-height: 100vh;
            color: #333;
            margin: 0;
            overflow-x: hidden;
        }
        
        .layout {
            display: flex;
            min-height: 100vh;
        }
        
        /* Sidebar System */
        .sidebar {
            background: white;
            border-right: 1px solid #e5e7eb;
            overflow-y: auto;
            flex-shrink: 0;
        }
        
        .runs-sidebar {
            width: 350px;
            background: #f9fafb;
            padding-left: 0;
        }
        
        .categories-sidebar {
            width: 240px;
            background: white;
            display: none; /* Hide the separate categories sidebar */
        }
        
        .evals-sidebar {
            width: 300px;
            background: #f9fafb;
        }
        
        .main-content {
            flex: 1;
            background: white;
            overflow-y: auto;
            padding: 2rem;
        }
        
        .sidebar-header {
            padding: 1.5rem 1rem;
            border-bottom: 1px solid #e5e7eb;
            background: #4f46e5;
            color: white;
        }
        
        .sidebar-header h3 {
            font-size: 1.1rem;
            font-weight: 600;
            margin: 0;
        }
        
        .sidebar-content {
            padding: 0;
        }
        
        .runs-sidebar .sidebar-content {
            padding: 0;
        }
        
        .sidebar-item {
            display: block;
            width: 100%;
            padding: 1rem;
            border: none;
            background: none;
            text-align: left;
            cursor: pointer;
            transition: all 0.2s ease;
            border-bottom: 1px solid #f3f4f6;
            font-size: 0.875rem;
            min-height: 60px;
        }
        
        .sidebar-item:hover {
            background: #f3f4f6;
            transform: translateX(2px);
        }
        
        .sidebar-item.active {
            background: #e0e7ff;
            border-left: 3px solid #4f46e5;
            font-weight: 600;
            color: #4f46e5;
        }
        
        .run-item {
            display: flex;
            align-items: center;
            justify-content: space-between;
            width: 100%;
            gap: 1rem;
        }
        
        .run-model {
            font-weight: 600;
            color: #374151;
            flex: 1;
            min-width: 0;
        }
        
        .run-scores {
            display: flex;
            flex-direction: column;
            align-items: flex-end;
            gap: 0.125rem;
            flex-shrink: 0;
            min-width: fit-content;
        }
        
        .run-score {
            font-size: 0.75rem;
            padding: 0.25rem 0.5rem;
            border-radius: 12px;
            font-weight: 600;
        }
        
        .run-count {
            font-size: 0.65rem;
            color: #6b7280;
            font-weight: 500;
        }
        
        .score-excellent { background: #dcfce7; color: #166534; }
        .score-good { background: #dbeafe; color: #1d4ed8; }
        .score-fair { background: #fef3c7; color: #92400e; }
        .score-poor { background: #fecaca; color: #dc2626; }
        
        .category-item {
            display: flex;
            align-items: center;
            justify-content: space-between;
        }
        
        .category-name {
            font-weight: 500;
        }
        
        .category-stats {
            font-size: 0.75rem;
            color: #6b7280;
        }
        
        .eval-item {
            display: flex;
            align-items: center;
            justify-content: space-between;
        }
        
        .eval-name {
            font-weight: 500;
            color: #374151;
        }
        
        .eval-status {
            font-size: 0.75rem;
            padding: 0.25rem 0.5rem;
            border-radius: 8px;
            font-weight: 600;
        }
        
        .status-pass { background: #dcfce7; color: #166534; }
        .status-fail { background: #fecaca; color: #dc2626; }
        
        .failure-reasons {
            display: flex;
            flex-wrap: wrap;
            gap: 0.25rem;
        }
        
        .failure-reason {
            background: #dc2626;
            color: white;
            font-size: 0.625rem;
            padding: 0.125rem 0.375rem;
            border-radius: 50px;
            font-weight: 600;
        }
        
        .header {
            margin-bottom: 2rem;
        }
        
        .header h1 {
            font-size: 2.5rem;
            font-weight: 700;
            margin-bottom: 0.5rem;
            color: #1f2937;
        }
        
        .header p {
            font-size: 1.1rem;
            color: #6b7280;
        }
        
        /* Eval Details Layout */
        .eval-details-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 1.5rem;
            margin-bottom: 2rem;
            padding: 0 1rem;
        }
        
        .eval-details-grid .full-width {
            grid-column: 1 / -1;
        }
        
        .status-badge {
            font-size: 1.25rem;
            font-weight: 700;
            padding: 1rem;
            border-radius: 8px;
            text-align: center;
            margin-bottom: 1rem;
        }
        
        .failure-summary {
            background: #fef2f2;
            border: 1px solid #fecaca;
            border-radius: 6px;
            padding: 1rem 1.25rem;
            color: #991b1b;
            margin-top: 0.5rem;
        }
        
        .scores-list {
            display: flex;
            flex-direction: column;
            gap: 0.5rem;
        }
        
        .score-item {
            display: flex;
            align-items: center;
            gap: 0.75rem;
            padding: 0.75rem 1rem;
            border-radius: 6px;
            border: 1px solid #e5e7eb;
        }
        
        .score-item.pass {
            background: #f0fdf4;
            border-color: #bbf7d0;
        }
        
        .score-item.fail {
            background: #fef2f2;
            border-color: #fecaca;
        }
        
        .score-name {
            flex: 1;
            font-weight: 500;
        }
        
        .score-value {
            font-weight: 600;
            font-size: 0.875rem;
        }
        
        .file-actions {
            display: flex;
            gap: 0.75rem;
            flex-wrap: wrap;
        }
        
        .action-button {
            background: #4f46e5;
            color: white;
            border: none;
            padding: 0.5rem 1rem;
            border-radius: 6px;
            cursor: pointer;
            font-size: 0.875rem;
            transition: background-color 0.2s ease;
        }
        
        .action-button:hover {
            background: #4338ca;
        }
        
        .task-content {
            line-height: 1.6;
            padding: 0.5rem 0;
            max-height: 500px;
            overflow-y: auto;
        }
        
        .task-content pre {
            max-height: 500px;
            overflow-y: auto;
        }
        
        .directory-info {
            margin-bottom: 1rem;
        }
        
        .directory-path {
            display: flex;
            align-items: center;
            gap: 0.75rem;
            background: #f8fafc;
            padding: 0.75rem;
            border-radius: 4px;
            border: 1px solid #e5e7eb;
            margin-bottom: 1rem;
        }
        
        .directory-path code {
            flex: 1;
            background: #e5e7eb;
            padding: 0.25rem 0.5rem;
            border-radius: 3px;
            font-size: 0.875rem;
            word-break: break-all;
        }
        
        .run-log-content {
            margin-top: 0.5rem;
        }
        
        /* Accordion Styles */
        .run-accordion {
            border-bottom: 1px solid #f3f4f6;
        }
        
        .run-header {
            width: 100%;
            border: none;
            background: none;
            padding: 0;
        }
        
        .accordion-arrow {
            font-size: 0.75rem;
            transition: transform 0.2s ease;
            color: #6b7280;
        }
        
        .accordion-arrow.expanded {
            transform: rotate(180deg);
        }
        
        .categories-accordion {
            max-height: 0;
            overflow: hidden;
            transition: max-height 0.3s ease;
            background: #f8fafc;
        }
        
        .categories-accordion.expanded {
            max-height: 500px;
        }
        
        .category-accordion-item {
            display: block;
            width: 100%;
            padding: 0.75rem 1rem 0.75rem 1.5rem;
            border: none;
            background: none;
            text-align: left;
            cursor: pointer;
            transition: all 0.2s ease;
            border-bottom: 1px solid #f1f5f9;
            font-size: 0.875rem;
            min-height: 48px;
        }
        
        .category-accordion-item:hover {
            background: #e2e8f0;
        }
        
        .category-accordion-item.active {
            background: #ddd6fe;
            border-left: 3px solid #4f46e5;
            font-weight: 600;
            color: #4f46e5;
        }
        
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 1.5rem;
            margin-bottom: 3rem;
        }
        
        .stat-card {
            background: white;
            padding: 2rem;
            border-radius: 16px;
            box-shadow: 0 8px 32px rgba(0,0,0,0.1);
            text-align: center;
            backdrop-filter: blur(10px);
        }
        
        .stat-number {
            font-size: 2.5rem;
            font-weight: 700;
            margin-bottom: 0.5rem;
        }
        
        .stat-label {
            color: #666;
            font-size: 0.9rem;
            text-transform: uppercase;
            letter-spacing: 1px;
        }
        
        .overall-score .stat-number {
            color: #10b981;
        }
        
        .pass-rate .stat-number {
            color: #10b981;
        }
        
        .total-tests .stat-number {
            color: #ef4444;
        }
        
        .card {
            background: white;
            border-radius: 4px;
            box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
            border: 1px solid #e5e7eb;
            overflow: hidden;
            margin-bottom: 2rem;
        }
        
        .card-header {
            background: #4f46e5;
            color: white;
            padding: 1rem 1.5rem;
            font-size: 1rem;
            font-weight: 600;
        }
        
        .card-content {
            padding: 1.5rem;
        }
        
        .table-container {
            max-height: 600px;
            overflow-y: auto;
        }
        
        table {
            width: 100%;
            border-collapse: collapse;
        }
        
        th, td {
            padding: 1rem;
            text-align: left;
            border-bottom: 1px solid #e5e7eb;
        }
        
        th {
            background: #f8fafc;
            font-weight: 600;
            color: #374151;
            position: sticky;
            top: 0;
            z-index: 10;
        }
        
        tr.pass {
            background: #f0fdf4;
        }
        
        tr.warning {
            background: #fffbeb;
        }
        
        tr.fail {
            background: #fef2f2;
        }
        
        /* Hover effects for clickable table rows */
        tr[onclick] {
            cursor: pointer;
            transition: all 0.2s ease;
        }
        
        tr[onclick]:hover {
            transform: translateY(-1px);
            box-shadow: 0 2px 8px rgba(0,0,0,0.1);
        }
        
        tr.pass[onclick]:hover {
            background: #ecfdf5 !important;
        }
        
        tr.warning[onclick]:hover {
            background: #fefce8 !important;
        }
        
        tr.fail[onclick]:hover {
            background: #fef7f7 !important;
        }
        
        tr.excellent {
            background: #f0fdf4;
        }
        
        tr.good {
            background: #f0f9ff;
        }
        
        tr.fair {
            background: #fffbeb;
        }
        
        tr.poor {
            background: #fef2f2;
        }
        
        .run-row {
            cursor: pointer;
            transition: all 0.2s ease;
        }
        
        .run-row:hover {
            background: #f3f4f6 !important;
            transform: translateY(-1px);
            box-shadow: 0 4px 12px rgba(0,0,0,0.1);
        }
        
        .status-icon {
            margin-right: 0.5rem;
        }
        
        .score-cell {
            min-width: 200px;
        }
        
        .score-bar-container {
            position: relative;
            background: #e5e7eb;
            border-radius: 8px;
            height: 24px;
            overflow: hidden;
        }
        
        .score-bar {
            height: 100%;
            background: linear-gradient(90deg, #ef4444 0%, #f59e0b 50%, #10b981 100%);
            transition: width 0.3s ease;
            border-radius: 8px;
        }
        
        .score-text {
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            font-weight: 600;
            font-size: 0.875rem;
            color: #374151;
            text-shadow: 1px 1px 2px rgba(255,255,255,0.8);
        }
        
        .numeric {
            text-align: right;
            font-family: 'SF Mono', Monaco, monospace;
            font-weight: 500;
        }
        
        .timestamp {
            font-family: 'SF Mono', Monaco, monospace;
            font-size: 0.875rem;
            color: #6b7280;
        }
        
        .tempdir-cell code {
            background: #f3f4f6;
            padding: 0.25rem 0.5rem;
            border-radius: 4px;
            font-size: 0.75rem;
            max-width: 200px;
            display: inline-block;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        
        .breadcrumb {
            background: rgba(255, 255, 255, 0.1);
            color: white;
            padding: 1rem;
            border-radius: 8px;
            margin-bottom: 2rem;
            display: flex;
            align-items: center;
            gap: 0.5rem;
        }
        
        .breadcrumb-btn {
            background: rgba(255, 255, 255, 0.2);
            color: white;
            border: none;
            padding: 0.5rem 1rem;
            border-radius: 6px;
            cursor: pointer;
            transition: all 0.2s ease;
            font-size: 0.875rem;
        }
        
        .breadcrumb-btn:hover {
            background: rgba(255, 255, 255, 0.3);
            transform: translateY(-1px);
            box-shadow: 0 2px 8px rgba(0,0,0,0.2);
        }
        
        .breadcrumb-separator {
            opacity: 0.7;
        }
        
        .breadcrumb-current {
            font-weight: 600;
        }
        
        .status-text {
            font-family: 'SF Mono', Monaco, monospace;
            font-size: 0.875rem;
        }
        
        .directory-cell {
            font-family: 'SF Mono', Monaco, monospace;
            font-size: 0.875rem;
        }
        
        .directory-link, .log-link {
            color: #4f46e5;
            text-decoration: none;
            padding: 0.25rem 0.5rem;
            border-radius: 4px;
            background: #f3f4f6;
            border: none;
            cursor: pointer;
            transition: all 0.2s ease;
            margin-right: 0.5rem;
            font-size: 0.75rem;
        }
        
        .directory-link:hover, .log-link:hover {
            background: #e5e7eb;
            color: #3730a3;
            transform: translateY(-1px);
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        
        .log-link {
            background: #fef3c7;
            color: #92400e;
        }
        
        .log-link:hover {
            background: #fde68a;
            color: #78350f;
            transform: translateY(-1px);
            box-shadow: 0 2px 4px rgba(146,64,14,0.2);
        }
        
        .view {
            display: none;
        }
        
        .view.active {
            display: block;
        }
        
        .footer {
            text-align: center;
            color: white;
            opacity: 0.8;
            margin-top: 2rem;
        }
        
        .refresh-btn {
            position: fixed;
            bottom: 2rem;
            right: 2rem;
            background: #4f46e5;
            color: white;
            border: none;
            padding: 1rem;
            border-radius: 50%;
            width: 60px;
            height: 60px;
            cursor: pointer;
            box-shadow: 0 4px 16px rgba(79, 70, 229, 0.3);
            transition: all 0.3s ease;
            font-size: 1.5rem;
        }
        
        .refresh-btn:hover {
            background: #4338ca;
            transform: scale(1.1);
            box-shadow: 0 6px 20px rgba(79, 70, 229, 0.4);
        }
    </style>
</head>
<body>
    <div class="layout">
        <!-- Runs Sidebar -->
        <div class="sidebar runs-sidebar">
            <div class="sidebar-header">
                <h3>🚀 Evaluation Runs</h3>
            </div>
            <div class="sidebar-content">
                ${runsSidebarHTML}
            </div>
        </div>
        

        
        <!-- Evals Sidebar (shown when a category is selected) -->
        ${
          runIndex >= 0 && category
            ? `
        <div class="sidebar evals-sidebar">
            <div class="sidebar-header">
                <h3>🔍 Evaluations</h3>
            </div>
            <div class="sidebar-content">
                ${evalsSidebarHTML}
            </div>
        </div>
        `
            : ""
        }
        
        <!-- Main Content -->
        <div class="main-content">
            ${mainContentHTML}
        </div>
    </div>
    
    <button class="refresh-btn" onclick="window.location.reload()" title="Refresh Results">
        🔄
    </button>
    
    <script>
        // Store the results data for navigation
        const resultsData = ${JSON.stringify(results)};
        
        function hideAllViews() {
            document.querySelectorAll('.view').forEach(view => {
                view.classList.remove('active');
            });
        }
        
        function showRunsList() {
            window.location.href = '/';
        }
        
        function showRunDetails(runIndex) {
            window.location.href = \`/run-\${runIndex}\`;
        }
        
        function showCategoryDetails(category, runIndex) {
            window.location.href = \`/run-\${runIndex}/\${category}\`;
        }
        
        function getCurrentRunIndex() {
            const path = window.location.pathname;
            const match = path.match(/\\/run-(\\d+)/);
            return match ? parseInt(match[1]) : 0;
        }
        
        function showEvalDetails(evalName, runIndex, category) {
            window.location.href = \`/run-\${runIndex}/\${category}/\${evalName}\`;
        }
        
        function toggleRunAccordion(runIndex) {
            // Navigate to the run and let the accordion expand
            window.location.href = \`/run-\${runIndex}\`;
        }
        
        async function loadTaskFile(directoryPath, category, evalName) {
            try {
                const response = await fetch(\`/task/\${encodeURIComponent(category)}/\${encodeURIComponent(evalName)}\`);
                if (response.ok) {
                    const data = await response.json();
                    const taskContent = document.querySelector('.task-content');
                    if (taskContent) {
                        taskContent.innerHTML = \`<pre style="white-space: pre-wrap; background: #f8fafc; padding: 1rem; border-radius: 6px; border: 1px solid #e5e7eb;">\${data.content}</pre>\`;
                    }
                } else {
                    const taskContent = document.querySelector('.task-content');
                    if (taskContent) {
                        taskContent.innerHTML = '<p style="color: #dc2626;">Task file not found or could not be loaded.</p>';
                    }
                }
            } catch (error) {
                const taskContent = document.querySelector('.task-content');
                if (taskContent) {
                    taskContent.innerHTML = \`<p style="color: #dc2626;">Error loading task file: \${error.message}</p>\`;
                }
            }
        }
        
        // Directory and log functions
        function openDirectory(path) {
            // Try different methods to open directory
            if (window.electronAPI) {
                // If running in Electron
                window.electronAPI.openPath(path);
            } else {
                // Fallback: copy path to clipboard and show message
                navigator.clipboard.writeText(path).then(() => {
                    alert(\`Directory path copied to clipboard:\\n\${path}\\n\\nPaste this into your file explorer.\`);
                }).catch(() => {
                    prompt('Copy this directory path:', path);
                });
            }
        }
        
        function viewLog(logPath) {
            // Open log in a new window/tab
            const encodedPath = encodeURIComponent(logPath);
            const logUrl = \`/logs/\${encodedPath}\`;
            window.open(logUrl, '_blank', 'width=1000,height=600,scrollbars=yes,resizable=yes');
        }
        
        // Auto-refresh every 30 seconds, preserving current URL
        setTimeout(() => {
            window.location.reload();
        }, 30000);
    </script>
</body>
</html>
  `;
}

async function startServer() {
  console.log(
    `🚀 Starting Convex Evaluation Visualizer on http://localhost:${PORT}`,
  );
  console.log(`📊 Reading data from: ${RESULTS_FILE}`);

  const server = Bun.serve({
    port: PORT,
    fetch(req) {
      const url = new URL(req.url);
      const pathParts = url.pathname.split("/").filter((p) => p.length > 0);

      try {
        const results = readJsonlResults();

        // Serve log files
        if (pathParts[0] === "logs") {
          try {
            const logPath = decodeURIComponent(pathParts.slice(1).join("/"));
            const fs = require("fs");

            if (fs.existsSync(logPath)) {
              const logContent = fs.readFileSync(logPath, "utf-8");
              return new Response(logContent, {
                headers: { "Content-Type": "text/plain" },
              });
            } else {
              return new Response("Log file not found", { status: 404 });
            }
          } catch (err) {
            return new Response("Error reading log file", { status: 500 });
          }
        }

        // Handle task file requests
        if (pathParts[0] === "task") {
          try {
            const category = decodeURIComponent(pathParts[1] || "");
            const evalName = decodeURIComponent(pathParts[2] || "");
            const fs = require("fs");
            const path = require("path");

            // Look for TASK.txt in the eval directory
            const taskPath = path.join("evals", category, evalName, "TASK.txt");

            if (!fs.existsSync(taskPath)) {
              return new Response("Task file not found", { status: 404 });
            }

            const content = fs.readFileSync(taskPath, "utf-8");
            return new Response(JSON.stringify({ content }), {
              headers: { "Content-Type": "application/json" },
            });
          } catch (err) {
            return new Response("Error reading task file", { status: 500 });
          }
        }

        // Route handling
        let currentView = "runs-list";
        let runIndex = -1;
        let category = "";
        let evalName = "";

        if (pathParts.length >= 1) {
          // Parse run index from path
          const runPart = pathParts[0];
          if (runPart.startsWith("run-")) {
            runIndex = parseInt(runPart.replace("run-", ""));
            if (runIndex >= 0 && runIndex < results.length) {
              const result = results[runIndex];

              if (pathParts.length >= 2) {
                category = pathParts[1];

                if (pathParts.length >= 3) {
                  evalName = pathParts[2];
                  currentView = "eval-details";
                } else {
                  // Auto-select first eval when clicking a category
                  const categoryResults = (
                    result.individual_results || []
                  ).filter((r) => r.category === category);
                  if (categoryResults.length > 0) {
                    evalName = categoryResults[0].name;
                    currentView = "eval-details";
                  } else {
                    currentView = "category-details";
                  }
                }
              } else {
                // Auto-select first category when opening a run
                const categories = Object.keys(result.category_summaries || {});
                if (categories.length > 0) {
                  category = categories[0];
                  currentView = "category-details";

                  // Auto-select first eval in first category
                  const categoryResults = (
                    result.individual_results || []
                  ).filter((r) => r.category === category);
                  if (categoryResults.length > 0) {
                    evalName = categoryResults[0].name;
                    currentView = "eval-details";
                  }
                } else {
                  currentView = "run-details";
                }
              }
            }
          }
        }

        const html = generateHTML(
          results,
          currentView,
          runIndex,
          category,
          evalName,
        );
        return new Response(html, {
          headers: { "Content-Type": "text/html" },
        });
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        console.error("Error reading results:", errorMessage);

        const errorHtml = `
          <!DOCTYPE html>
          <html>
          <head>
              <title>Error - Convex Evaluation Visualizer</title>
              <style>
                  body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; padding: 2rem; background: #f3f4f6; }
                  .error { background: white; padding: 2rem; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
                  .error h1 { color: #dc2626; margin-bottom: 1rem; }
                  .error p { color: #6b7280; line-height: 1.6; }
                  .error code { background: #f3f4f6; padding: 0.25rem 0.5rem; border-radius: 4px; }
              </style>
          </head>
          <body>
              <div class="error">
                  <h1>❌ Error Loading Results</h1>
                  <p><strong>Error:</strong> ${errorMessage}</p>
                  <p>Make sure you have run some evaluations and that <code>local_results.jsonl</code> exists in the project root.</p>
                  <p>Try running: <code>npm run local:run:one</code></p>
                  <p>Note: You may need to run evaluations again to generate the enhanced result format with individual evaluation details.</p>
              </div>
          </body>
          </html>
        `;

        return new Response(errorHtml, {
          status: 500,
          headers: { "Content-Type": "text/html" },
        });
      }
    },
  });

  console.log(`✅ Server running at http://localhost:${server.port}`);
  console.log(`🔄 Auto-refresh enabled (30s intervals)`);
  console.log(`📝 Press Ctrl+C to stop`);
}

// Handle graceful shutdown
process.on("SIGINT", () => {
  console.log("\n👋 Shutting down server...");
  process.exit(0);
});

// Start the server
if (import.meta.main) {
  await startServer();
}
