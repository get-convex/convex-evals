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
  selectedTab: string = "log",
  selectedFile: string = "",
  selectedLine: number | null = null,
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
             <div class="tab-container">
         <div class="tab-nav">
           <button class="tab-button ${selectedTab === "log" ? "active" : ""}" onclick="switchTab('log', '${category}', '${evalName}')">📄 Log</button>
           <button class="tab-button ${selectedTab === "task" ? "active" : ""}" onclick="switchTab('task', '${category}', '${evalName}')">📋 Task</button>
           <button class="tab-button ${selectedTab === "steps" ? "active" : ""}" onclick="switchTab('steps', '${category}', '${evalName}')">📊 Steps</button>
           <button class="tab-button ${selectedTab === "answer" ? "active" : ""}" onclick="switchTab('answer', '${category}', '${evalName}')">💡 Answer</button>
           <button class="tab-button ${selectedTab === "output" ? "active" : ""}" onclick="switchTab('output', '${category}', '${evalName}')">📁 Output</button>
         </div>
        
                 <div class="tab-content">
           <!-- Log Tab -->
           <div class="tab-pane ${selectedTab === "log" ? "active" : ""}" id="log-tab-${category}-${evalName}">
             <div class="log-content" id="log-content-${category}-${evalName}">
               <p><em>Loading run log...</em></p>
             </div>
           </div>
           
           <!-- Task Tab -->
           <div class="tab-pane ${selectedTab === "task" ? "active" : ""}" id="task-tab-${category}-${evalName}">
             <div class="task-content" id="task-content-${category}-${evalName}">
               <p><em>Loading task description...</em></p>
             </div>
           </div>
          
          <!-- Steps Tab -->
          <div class="tab-pane ${selectedTab === "steps" ? "active" : ""}" id="steps-tab-${category}-${evalName}">
            <div class="scores-list">
              ${scoresBreakdown}
            </div>
            ${
              evalResult.failure_reason
                ? `
            <div class="failure-summary">
              <strong>Failure Reason:</strong> ${evalResult.failure_reason}
            </div>
          `
                : ""
            }
          </div>
          
          <!-- Answer Tab -->
          <div class="tab-pane ${selectedTab === "answer" ? "active" : ""}" id="answer-tab-${category}-${evalName}">
            <div class="file-browser">
              <div class="file-tree">
                <div class="file-tree-header">
                  Answer Directory
                  <button onclick="copyDirectoryPath('evals/${category}/${evalName}/answer')" class="copy-path-button" title="Copy answer directory path">
                    📋
                  </button>
                </div>
                <div id="answer-file-tree-content-${category}-${evalName}">
                  <p><em>Loading answer directory...</em></p>
                </div>
              </div>
              <div class="file-viewer">
                <div class="file-viewer-header">
                  <span id="answer-current-file-name-${category}-${evalName}">Select a file</span>
                </div>
                <div class="file-content" id="answer-file-content-${category}-${evalName}">
                  <p><em>Select a file to view its contents</em></p>
                </div>
              </div>
            </div>
          </div>
          
          <!-- Output Tab -->
          <div class="tab-pane ${selectedTab === "output" ? "active" : ""}" id="output-tab-${category}-${evalName}">
            <div class="file-browser">
              <div class="file-tree">
                <div class="file-tree-header">
                  Directory Structure
                  ${
                    evalResult.directory_path
                      ? `
                    <button onclick="copyDirectoryPath('${evalResult.directory_path.replace(/\\/g, "\\\\")}')" class="copy-path-button" title="Copy directory path">
                      📋
                    </button>
                  `
                      : ""
                  }
                </div>
                <div id="file-tree-content-${category}-${evalName}">
                  <p><em>Loading directory structure...</em></p>
                </div>
              </div>
              <div class="file-viewer">
                <div class="file-viewer-header">
                  <span id="current-file-name-${category}-${evalName}">run.log</span>
                </div>
                                 <div class="file-content-split" id="file-content-split-${category}-${evalName}">
                   <div class="file-content-pane">
                     <div class="file-content-header">Generated Output</div>
                     <div class="file-content" id="file-content-${category}-${evalName}">
                       <p><em>Loading run log...</em></p>
                     </div>
                   </div>
                   <div class="split-handle" onmousedown="initSplitResize(event, '${category}', '${evalName}')"></div>
                   <div class="file-content-pane" id="answer-pane-${category}-${evalName}" style="display: flex; flex-direction: column;">
                     <div class="file-content-header answer">Answer (Reference)</div>
                     <div class="file-content" id="answer-content-${category}-${evalName}">
                       <p><em>No corresponding answer file</em></p>
                     </div>
                   </div>
                 </div>
              </div>
            </div>
          </div>
        </div>
      </div>
        
                 <script>
           // Auto-load task file and run log when page loads
           (async function() {
             // Load run log into the Log tab
             ${
               evalResult.directory_path
                 ? `
             try {
               const logPath = '${evalResult.directory_path.replace(/\\/g, "/")}/run.log';
               const response = await fetch(\`/file/\${encodeURIComponent(logPath)}\`);
               const logElement = document.getElementById('log-content-${category}-${evalName}');
               if (response.ok) {
                 const data = await response.json();
                 if (logElement) {
                   // Process log content to make file paths clickable
                   const processedContent = makeLogPathsClickable(data.content, '${category}', '${evalName}');
                   logElement.innerHTML = \`<pre>\${processedContent}</pre>\`;
                 }
               } else {
                 if (logElement) {
                   logElement.innerHTML = '<p style="color: #f87171; padding: 1.5rem;">Run log not found.</p>';
                 }
               }
             } catch (error) {
               const logElement = document.getElementById('log-content-${category}-${evalName}');
               if (logElement) {
                 logElement.innerHTML = \`<p style="color: #f87171; padding: 1.5rem;">Error loading run log: \${error.message}</p>\`;
               }
             }
             `
                 : `
             const logElement = document.getElementById('log-content-${category}-${evalName}');
             if (logElement) {
               logElement.innerHTML = '<p style="color: #9ca3af; padding: 1.5rem;">No run log available.</p>';
             }
             `
             }
             
             // Load task file
             try {
               const response = await fetch(\`/task/\${encodeURIComponent('${category}')}/\${encodeURIComponent('${evalName}')}\`);
               const taskElement = document.getElementById('task-content-${category}-${evalName}');
               if (response.ok) {
                 const data = await response.json();
                 if (taskElement) {
                   taskElement.innerHTML = \`<pre style="white-space: pre-wrap; margin: 0; font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace; font-size: 0.875rem; line-height: 1.6; height: 100%; overflow-y: auto;">\${data.content}</pre>\`;
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
            
            // Load file browser
            ${
              evalResult.directory_path
                ? `
            try {
              const dirPath = '${evalResult.directory_path.replace(/\\/g, "/")}';
              const response = await fetch(\`/browse/\${encodeURIComponent(dirPath)}\`);
              const treeElement = document.getElementById('file-tree-content-${category}-${evalName}');
              
              if (response.ok) {
                const data = await response.json();
                if (treeElement && data.files) {
                  const fileTreeHTML = data.files.map(file => {
                    const safeId = btoa(file.path).replace(/[^a-zA-Z0-9]/g, '');
                    if (file.isDirectory) {
                      return \`
                        <div class="directory-container">
                          <button class="file-tree-item directory" onclick="toggleDirectory('\${file.path.replace(/\\\\/g, '\\\\\\\\')}', '\${file.name}', '${category}', '${evalName}')">
                            <span>📁 \${file.name}</span>
                            <span class="expand-arrow">▶</span>
                          </button>
                          <div class="file-tree-children collapsed" id="children-\${safeId}"></div>
                        </div>
                      \`;
                    } else {
                      return \`<button class="file-tree-item file" onclick="loadFile('\${file.path.replace(/\\\\/g, '\\\\\\\\')}', '\${file.name}', '${category}', '${evalName}')" title="\${file.name}">📄 \${file.name}</button>\`;
                    }
                  }).join('');
                  treeElement.innerHTML = fileTreeHTML;
                  
                  // Check if we should auto-load a file from URL, otherwise default to run.log
                  const fragment = window.location.hash.slice(1);
                  const hasFileInUrl = fragment && (fragment.includes('/') || fragment.includes('.'));
                  
                  if (hasFileInUrl) {
                    // Don't auto-load run.log, let the URL-based loading handle it
                    console.log('URL fragment detected, skipping run.log auto-load:', fragment);
                    
                    // Immediately try to load the file from URL
                    setTimeout(() => {
                      autoLoadFileFromUrl('${selectedFile}', '${category}', '${evalName}', ${selectedLine || "null"});
                    }, 200);
                  } else {
                    // Auto-load run.log as default
                    const runLogFile = data.files.find(f => f.name === 'run.log');
                    if (runLogFile) {
                      loadFile(runLogFile.path, 'run.log', '${category}', '${evalName}');
                      
                      // Mark run.log as active in the file tree
                      setTimeout(() => {
                        const runLogButton = document.querySelector(\`#file-tree-content-\${category}-\${evalName} .file-tree-item[title="run.log"]\`);
                        if (runLogButton) {
                          runLogButton.classList.add('active');
                        }
                      }, 100);
                    }
                  }
                  
                  // Also try to load answer for the first file (usually index.ts or similar)
                  const firstCodeFile = data.files.find(f => !f.isDirectory && (f.name.endsWith('.ts') || f.name.endsWith('.js')));
                  if (firstCodeFile) {
                    console.log('Testing answer loading for first code file:', firstCodeFile.path);
                    loadCorrespondingAnswerFile(firstCodeFile.path, firstCodeFile.name, '${category}', '${evalName}');
                  }
                }
              } else {
                if (treeElement) {
                  treeElement.innerHTML = '<p style="color: #dc2626;">Directory not found.</p>';
                }
              }
            } catch (error) {
              const treeElement = document.getElementById('file-tree-content-${category}-${evalName}');
              if (treeElement) {
                treeElement.innerHTML = \`<p style="color: #dc2626;">Error loading directory: \${error.message}</p>\`;
              }
            }
            `
                : `
            const treeElement = document.getElementById('file-tree-content-${category}-${evalName}');
            if (treeElement) {
              treeElement.innerHTML = '<p style="color: #6b7280;">No directory available.</p>';
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
  selectedTab: string = "log",
  selectedFile: string = "",
  selectedLine: number | null = null,
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
    selectedTab,
    selectedFile,
    selectedLine,
  );

  return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Convex Evaluation Results</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/themes/prism.min.css">
    <script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-core.min.js"></script>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/plugins/autoloader/prism-autoloader.min.js"></script>
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
             width: 280px;
             background: #f9fafb;
             padding-left: 0;
             transition: width 0.3s ease;
         }
         
         .runs-sidebar.collapsed {
             width: 40px;
         }
         
         .categories-sidebar {
             width: 240px;
             background: white;
             display: none; /* Hide the separate categories sidebar */
         }
         
         .evals-sidebar {
             width: 300px;
             background: #f9fafb;
             transition: width 0.3s ease;
         }
         
         .evals-sidebar.collapsed {
             width: 40px;
         }
        
        .main-content {
            flex: 1;
            background: white;
            overflow: hidden;
            padding: 2rem;
            display: flex;
            flex-direction: column;
        }
        
        /* Remove padding for eval details with tabs */
        .main-content .tab-container {
            margin: -2rem;
            flex: 1;
            display: flex;
            flex-direction: column;
        }
        
        .main-content .tab-container .tab-nav {
            padding: 0;
        }
        
        .main-content .tab-container .tab-button:first-child {
            margin-left: 0;
            padding-left: 2rem;
        }
        
        .main-content .tab-container .tab-button:last-child {
            padding-right: 2rem;
        }
        
                 .sidebar-header {
             padding: 1.5rem 1rem;
             border-bottom: 1px solid #e5e7eb;
             background: #4f46e5;
             color: white;
             display: flex;
             justify-content: space-between;
             align-items: center;
         }
         
         .sidebar-header h3 {
             font-size: 1.1rem;
             font-weight: 600;
             margin: 0;
         }
         
         .sidebar-collapse-btn {
             background: rgba(255, 255, 255, 0.2);
             border: none;
             color: white;
             width: 24px;
             height: 24px;
             border-radius: 4px;
             cursor: pointer;
             display: flex;
             align-items: center;
             justify-content: center;
             font-size: 14px;
             transition: all 0.2s ease;
         }
         
         .sidebar-collapse-btn:hover {
             background: rgba(255, 255, 255, 0.3);
         }
         
         .sidebar.collapsed .sidebar-header {
             padding: 1rem 0.5rem;
         }
         
         .sidebar.collapsed .sidebar-header h3 {
             display: none;
         }
         
         .sidebar.collapsed .sidebar-content {
             display: none;
         }
         
         .sidebar.collapsed .sidebar-collapse-btn {
             margin: 0 auto;
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
        
        /* Tab Interface */
        .tab-container {
            padding: 0;
        }
        
        .tab-nav {
            display: flex;
            border-bottom: 2px solid #e5e7eb;
            margin-bottom: 0;
        }
        
        .tab-button {
            background: none;
            border: none;
            padding: 1rem 2rem;
            font-size: 1rem;
            font-weight: 500;
            cursor: pointer;
            color: #6b7280;
            border-bottom: 3px solid transparent;
            transition: all 0.2s ease;
        }
        
        .tab-button:hover {
            color: #4f46e5;
            background: #f8fafc;
        }
        
        .tab-button.active {
            color: #4f46e5;
            border-bottom-color: #4f46e5;
            background: #f8fafc;
        }
        
        .tab-content {
            flex: 1;
            display: flex;
            flex-direction: column;
        }
        
        .tab-pane {
            display: none;
            flex: 1;
            overflow: hidden;
        }
        
        .tab-pane.active {
            display: flex;
            flex-direction: column;
        }
        
        /* Add padding to specific content within tabs */
        .task-content {
            flex: 1;
            overflow: hidden;
            height: 100%;
            background: #f8fafc;
            border: 1px solid #e5e7eb;
            border-radius: 4px;
            margin: 1.5rem;
        }
        
                 .task-content pre {
             padding: 1.5rem;
             margin: 0;
             height: 100%;
             overflow-y: auto;
             box-sizing: border-box;
             background: transparent;
             border: none;
         }
         
         .log-content {
             flex: 1;
             overflow: hidden;
             height: 100%;
             background: #1f2937;
             border: 1px solid #374151;
             border-radius: 4px;
             margin: 1.5rem;
         }
         
         .log-content pre {
             padding: 1.5rem;
             margin: 0;
             height: 100%;
             overflow-y: auto;
             box-sizing: border-box;
             background: transparent;
             border: none;
             color: #f3f4f6;
             font-family: "Monaco", "Menlo", "Ubuntu Mono", monospace;
             font-size: 0.875rem;
             line-height: 1.4;
             white-space: pre-wrap;
         }
        

        
        .failure-summary {
            margin: 0 1.5rem 1.5rem 1.5rem;
        }
        
        .directory-info {
            background: #f8fafc;
            border: 1px solid #e5e7eb;
            border-radius: 6px;
            padding: 1rem;
            margin-bottom: 1rem;
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 1rem;
        }
        
        .directory-path {
            flex: 1;
        }
        
        .directory-path code {
            background: #e5e7eb;
            padding: 0.25rem 0.5rem;
            border-radius: 4px;
            font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
            font-size: 0.875rem;
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
            padding: 1.5rem;
            flex: 1;
            overflow-y: auto;
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
            max-height: none;
            overflow-y: visible;
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
        
        /* File Browser Styles */
        .file-browser {
            display: flex;
            flex: 1;
            border: 1px solid #e5e7eb;
            border-radius: 4px;
            overflow: hidden;
        }
        
        .file-tree {
            width: 300px;
            min-width: 250px;
            background: #f8fafc;
            border-right: 1px solid #e5e7eb;
            display: flex;
            flex-direction: column;
            flex-shrink: 0;
        }
        
        .file-tree-header {
            padding: 0.75rem;
            background: #e5e7eb;
            font-weight: 600;
            font-size: 0.875rem;
            border-bottom: 1px solid #d1d5db;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        
        .copy-path-button {
            background: #4f46e5;
            color: white;
            border: none;
            padding: 0.25rem 0.5rem;
            border-radius: 4px;
            font-size: 0.75rem;
            cursor: pointer;
            transition: all 0.2s ease;
            margin-left: 0.5rem;
        }
        
        .copy-path-button:hover {
            background: #4338ca;
            transform: scale(1.05);
        }
        
        /* Syntax highlighting customizations */
        pre[class*="language-"] {
            background: #f8fafc !important;
            border: 1px solid #e5e7eb;
            border-radius: 4px;
            padding: 1rem !important;
        }
        
        code[class*="language-"] {
            font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace !important;
            font-size: 0.875rem !important;
        }
        
        /* Override Prism's default colors for better readability */
        .token.comment,
        .token.prolog,
        .token.doctype,
        .token.cdata {
            color: #6b7280;
        }
        
        .token.punctuation {
            color: #374151;
        }
        
        .token.property,
        .token.tag,
        .token.constant,
        .token.symbol,
        .token.deleted {
            color: #dc2626;
        }
        
        .token.boolean,
        .token.number {
            color: #7c3aed;
        }
        
        .token.selector,
        .token.attr-name,
        .token.string,
        .token.char,
        .token.builtin,
        .token.inserted {
            color: #059669;
        }
        
        .token.operator,
        .token.entity,
        .token.url,
        .language-css .token.string,
        .style .token.string,
        .token.variable {
            color: #0891b2;
        }
        
        .token.atrule,
        .token.attr-value,
        .token.function,
        .token.class-name {
            color: #7c2d12;
        }
        
                 .token.keyword {
             color: #1d4ed8;
         }
         
         /* Line numbers styling */
         .line-numbers .line-number {
             display: inline-block;
             width: 45px;
             padding-right: 8px;
             color: #9ca3af;
             text-align: right;
             user-select: none;
             border-right: 1px solid #e5e7eb;
             margin-right: 12px;
             font-family: "Monaco", "Menlo", "Ubuntu Mono", monospace;
             font-size: 0.75rem;
             line-height: 1.4;
         }
         
         .line-numbers .line-content {
             display: inline;
             padding-left: 4px;
         }
         
         /* Clickable log file paths */
         .log-file-path {
             color: #3b82f6;
             text-decoration: underline;
             cursor: pointer;
             transition: all 0.2s ease;
         }
         
         .log-file-path:hover {
             color: #1d4ed8;
             background-color: rgba(59, 130, 246, 0.1);
             padding: 2px 4px;
             border-radius: 3px;
         }
        
        .file-viewer {
            flex: 1;
            display: flex;
            flex-direction: column;
            background: white;
        }
        
                 .file-content-split {
             display: flex;
             flex: 1;
             position: relative;
         }
         
         .file-content-pane {
             display: flex;
             flex-direction: column;
             overflow: hidden;
         }
         
         .file-content-pane:first-child {
             flex: 0 0 50%;
         }
         
         .file-content-pane:last-child {
             flex: 1;
         }
         
         .split-handle {
             width: 6px;
             background: #e5e7eb;
             cursor: col-resize;
             position: relative;
             flex-shrink: 0;
             transition: background-color 0.2s ease;
         }
         
         .split-handle:hover {
             background: #d1d5db;
         }
         
         .split-handle::after {
             content: '';
             position: absolute;
             top: 50%;
             left: 50%;
             transform: translate(-50%, -50%);
             width: 2px;
             height: 40px;
             background: #9ca3af;
             border-radius: 1px;
         }
         
         .file-content-split:has(.file-content-pane[style*="display: none"]) .file-content-pane:not([style*="display: none"]) {
             flex: 1;
         }
         
         .file-content-split:has(.file-content-pane[style*="display: none"]) .split-handle {
             display: none;
         }
        
        .file-content-header {
            padding: 0.5rem 0.75rem;
            background: #f8fafc;
            border-bottom: 1px solid #e5e7eb;
            font-size: 0.875rem;
            font-weight: 500;
            color: #374151;
        }
        
        .file-content-header.answer {
            background: #fef3c7;
            color: #92400e;
        }
        
        .file-viewer-header {
            padding: 0.75rem;
            background: #f3f4f6;
            border-bottom: 1px solid #e5e7eb;
            font-weight: 600;
            font-size: 0.875rem;
            font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
        }
        
        .file-content {
            flex: 1;
            overflow-y: auto;
            padding: 0;
        }
        
        .file-tree-item {
            display: block;
            width: 100%;
            padding: 0.5rem 0.75rem;
            border: none;
            background: none;
            text-align: left;
            cursor: pointer;
            font-size: 0.875rem;
            transition: background-color 0.2s ease;
            border-bottom: 1px solid #f1f5f9;
        }
        
        .file-tree-item:hover {
            background: #e2e8f0;
        }
        
        .file-tree-item.active {
            background: #ddd6fe;
            color: #4f46e5;
            font-weight: 600;
        }
        
        .file-tree-item.folder {
            font-weight: 500;
        }
        
        .file-tree-item.file {
            padding-left: 1.5rem;
        }
        
        .file-tree-item.directory {
            display: flex;
            align-items: center;
            justify-content: space-between;
        }
        
        .file-tree-item.directory .expand-arrow {
            font-size: 0.75rem;
            transition: transform 0.2s ease;
            color: #6b7280;
        }
        
        .file-tree-item.directory .expand-arrow.expanded {
            transform: rotate(90deg);
        }
        
        .file-tree-children {
            margin-left: 1rem;
            border-left: 1px solid #e5e7eb;
            padding-left: 0.5rem;
        }
        
        .file-tree-children.collapsed {
            display: none;
        }
        
        .header-action-button {
            background: #4f46e5;
            color: white;
            border: none;
            padding: 0.375rem 0.75rem;
            border-radius: 4px;
            cursor: pointer;
            font-size: 0.75rem;
            margin-left: auto;
            transition: background-color 0.2s ease;
        }
        
        .header-action-button:hover {
            background: #4338ca;
        }
        
        /* Collapsible Card Styles */
        .collapsible-header {
            cursor: pointer;
            display: flex;
            justify-content: space-between;
            align-items: center;
            transition: background-color 0.2s ease;
        }
        
        .collapsible-header:hover {
            background: #3f3cbb;
        }
        
        .collapse-arrow {
            font-size: 0.75rem;
            transition: transform 0.2s ease;
            color: rgba(255, 255, 255, 0.8);
        }
        
        .collapse-arrow.expanded {
            transform: rotate(180deg);
        }
        
        .card-content.collapsed {
            max-height: 0;
            overflow: hidden;
            padding: 0 1.5rem;
            transition: max-height 0.3s ease, padding 0.3s ease;
        }
        
        .card-content.expanded {
            max-height: 1000px;
            padding: 1.5rem;
            transition: max-height 0.3s ease, padding 0.3s ease;
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
        

    </style>
</head>
<body>
    <div class="layout">
                 <!-- Runs Sidebar -->
         <div class="sidebar runs-sidebar" id="runs-sidebar">
             <div class="sidebar-header">
                 <h3>🚀 Evaluation Runs</h3>
                 <button class="sidebar-collapse-btn" onclick="toggleSidebar('runs-sidebar')" title="Collapse sidebar">
                     ◀
                 </button>
             </div>
             <div class="sidebar-content">
                 ${runsSidebarHTML}
             </div>
         </div>
        

        
        <!-- Evals Sidebar (shown when a category is selected) -->
                 ${
                   runIndex >= 0 && category
                     ? `
         <div class="sidebar evals-sidebar" id="evals-sidebar">
             <div class="sidebar-header">
                 <h3>🔍 Evaluations</h3>
                 <button class="sidebar-collapse-btn" onclick="toggleSidebar('evals-sidebar')" title="Collapse sidebar">
                     ◀
                 </button>
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
        
        // Auto-load file and line from URL fragment on page load (backup for non-output tabs)
        document.addEventListener('DOMContentLoaded', function() {
            const fragment = window.location.hash.slice(1);
            if (fragment && '${selectedTab}' !== 'output' && '${selectedFile}') {
                // Only auto-load if not already handled by output tab inline script
                setTimeout(() => {
                    autoLoadFileFromUrl('${selectedFile}', '${category}', '${evalName}', ${selectedLine || "null"});
                }, 500);
            }
        });
        
        // Function to auto-load a file from URL
        async function autoLoadFileFromUrl(filePath, category, evalName, lineNumber) {
            console.log('Auto-loading file from URL:', filePath);
            
            // Wait for the file tree to be fully loaded
            let attempts = 0;
            const maxAttempts = 10;
            
            const tryToLoadFile = () => {
                const fileButtons = document.querySelectorAll(\`#file-tree-content-\${category}-\${evalName} .file-tree-item\`);
                console.log(\`Attempt \${attempts + 1}: Found \${fileButtons.length} file buttons\`);
                
                for (const button of fileButtons) {
                    const buttonPath = button.getAttribute('onclick');
                    const buttonTitle = button.getAttribute('title');
                    
                    // Check if this button matches our file path
                    if ((buttonPath && buttonPath.includes(filePath)) || 
                        (buttonTitle && filePath.endsWith(buttonTitle))) {
                        console.log('Found matching file button, clicking:', buttonTitle);
                        
                        // Simulate the click
                        button.click();
                        
                        // If we have a line number, scroll to it after the file loads
                        if (lineNumber) {
                            setTimeout(() => {
                                console.log('Scrolling to line:', lineNumber);
                                scrollToLineNumber(lineNumber, category, evalName);
                            }, 1000);
                        }
                        return true;
                    }
                }
                return false;
            };
            
            // Try to load the file, with retries
            const loadWithRetry = () => {
                if (tryToLoadFile()) {
                    return; // Success
                }
                
                attempts++;
                if (attempts < maxAttempts) {
                    console.log(\`File not found yet, retrying in 200ms... (attempt \${attempts}/\${maxAttempts})\`);
                    setTimeout(loadWithRetry, 200);
                } else {
                    console.log(\`File not found after \${maxAttempts} attempts: \${filePath}\`);
                }
            };
            
            loadWithRetry();
        }
        
        function showEvalDetails(evalName, runIndex, category) {
            window.location.href = \`/run-\${runIndex}/\${category}/\${evalName}\`;
        }
        
        function toggleRunAccordion(runIndex) {
            // Navigate to the run and let the accordion expand
            window.location.href = \`/run-\${runIndex}\`;
        }
        
                 function switchTab(tabName, category, evalName) {
             // Hide all tab panes for this eval
             const tabPanes = document.querySelectorAll(\`[id$="-tab-\${category}-\${evalName}"]\`);
             tabPanes.forEach(pane => pane.classList.remove('active'));
             
             // Remove active class from all tab buttons
             const tabButtons = document.querySelectorAll(\`[onclick*="switchTab"][onclick*="'\${category}'"][onclick*="'\${evalName}'"]\`);
             tabButtons.forEach(button => button.classList.remove('active'));
             
             // Show the selected tab pane
             const selectedPane = document.getElementById(\`\${tabName}-tab-\${category}-\${evalName}\`);
             if (selectedPane) {
                 selectedPane.classList.add('active');
             }
             
             // Add active class to the clicked button
             event.target.classList.add('active');
             
             // Update URL to include tab
             updateURL(category, evalName, tabName);
             
             // Load answer directory if answer tab is selected
             if (tabName === 'answer') {
                 loadAnswerDirectory(category, evalName);
             }
         }

        function toggleCollapse(sectionId) {
            const content = document.getElementById(\`\${sectionId}-content\`);
            const arrow = document.getElementById(\`\${sectionId}-arrow\`);
            
            if (content && arrow) {
                if (content.classList.contains('collapsed')) {
                    content.classList.remove('collapsed');
                    content.classList.add('expanded');
                    arrow.classList.add('expanded');
                } else {
                    content.classList.remove('expanded');
                    content.classList.add('collapsed');
                    arrow.classList.remove('expanded');
                }
            }
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
        
        async function toggleDirectory(dirPath, dirName, category, evalName) {
            // Create a safe ID by encoding the path
            const safeId = btoa(dirPath).replace(/[^a-zA-Z0-9]/g, '');
            const childrenContainer = document.getElementById(\`children-\${safeId}\`);
            
            // Find the arrow within the button that was clicked
            const button = event.target.closest('.file-tree-item.directory');
            const arrow = button ? button.querySelector('.expand-arrow') : null;
            
            if (!childrenContainer) {
                console.error('Children container not found for:', dirPath);
                return;
            }
            
            if (childrenContainer.classList.contains('collapsed')) {
                // Expand directory
                console.log('Expanding directory:', dirPath);
                try {
                    const response = await fetch(\`/browse/\${encodeURIComponent(dirPath)}\`);
                    if (response.ok) {
                        const data = await response.json();
                        if (data.files) {
                            const childrenHTML = data.files.map(file => {
                                const childSafeId = btoa(file.path).replace(/[^a-zA-Z0-9]/g, '');
                                if (file.isDirectory) {
                                    return \`
                                        <div class="directory-container">
                                            <button class="file-tree-item directory" onclick="toggleDirectory('\${file.path.replace(/\\\\/g, '\\\\\\\\')}', '\${file.name}', '\${category}', '\${evalName}')">
                                                <span>📁 \${file.name}</span>
                                                <span class="expand-arrow">▶</span>
                                            </button>
                                            <div class="file-tree-children collapsed" id="children-\${childSafeId}"></div>
                                        </div>
                                    \`;
                                } else {
                                    return \`<button class="file-tree-item file" onclick="loadFile('\${file.path.replace(/\\\\/g, '\\\\\\\\')}', '\${file.name}', '\${category}', '\${evalName}')" title="\${file.name}">📄 \${file.name}</button>\`;
                                }
                            }).join('');
                            childrenContainer.innerHTML = childrenHTML;
                        }
                    } else {
                        console.error('Failed to fetch directory:', response.status);
                        childrenContainer.innerHTML = '<p style="color: #dc2626; padding: 0.5rem;">Error loading directory</p>';
                    }
                } catch (error) {
                    console.error('Error fetching directory:', error);
                    childrenContainer.innerHTML = '<p style="color: #dc2626; padding: 0.5rem;">Error loading directory</p>';
                }
                
                childrenContainer.classList.remove('collapsed');
                if (arrow) arrow.classList.add('expanded');
            } else {
                // Collapse directory
                console.log('Collapsing directory:', dirPath);
                childrenContainer.classList.add('collapsed');
                if (arrow) arrow.classList.remove('expanded');
            }
        }

        function getLanguageFromFileName(fileName) {
            const ext = fileName.split('.').pop().toLowerCase();
            const languageMap = {
                'js': 'javascript',
                'jsx': 'javascript',
                'ts': 'typescript',
                'tsx': 'typescript',
                'py': 'python',
                'json': 'json',
                'html': 'html',
                'css': 'css',
                'scss': 'scss',
                'md': 'markdown',
                'yaml': 'yaml',
                'yml': 'yaml',
                'xml': 'xml',
                'sql': 'sql',
                'sh': 'bash',
                'bash': 'bash',
                'log': 'log',
                'txt': 'text'
            };
            return languageMap[ext] || 'text';
        }

        async function loadFile(filePath, fileName, category, evalName) {
            try {
                // Update active state in file tree
                const treeItems = document.querySelectorAll(\`#file-tree-content-\${category}-\${evalName} .file-tree-item\`);
                treeItems.forEach(item => item.classList.remove('active'));
                
                // Only update active state if event.target exists (when clicked)
                if (typeof event !== 'undefined' && event.target) {
                    event.target.classList.add('active');
                }
                
                                 // Update file name in header
                 const fileNameElement = document.getElementById(\`current-file-name-\${category}-\${evalName}\`);
                 if (fileNameElement) {
                     fileNameElement.textContent = fileName;
                 }
                 
                 // Update URL to include the selected file
                 updateURL(category, evalName, 'output', fileName);
                
                // Load file content
                const response = await fetch(\`/file/\${encodeURIComponent(filePath)}\`);
                const contentElement = document.getElementById(\`file-content-\${category}-\${evalName}\`);
                
                if (response.ok) {
                    const data = await response.json();
                    if (contentElement) {
                        const language = getLanguageFromFileName(fileName);
                        const isLogFile = fileName.endsWith('.log') || fileName.endsWith('.txt');
                        
                                                 if (isLogFile || language === 'text' || language === 'log') {
                             // For log files and plain text, use simple styling
                             const style = isLogFile 
                                 ? 'white-space: pre-wrap; background: #1f2937; color: #f3f4f6; padding: 1rem; margin: 0; font-family: "Monaco", "Menlo", "Ubuntu Mono", monospace; font-size: 0.875rem; line-height: 1.4; height: 100%; overflow-y: auto;'
                                 : 'white-space: pre-wrap; background: #f8fafc; color: #374151; padding: 1rem; margin: 0; font-family: "Monaco", "Menlo", "Ubuntu Mono", monospace; font-size: 0.875rem; line-height: 1.4; height: 100%; overflow-y: auto; border: 1px solid #e5e7eb;';
                             
                             contentElement.innerHTML = \`<pre style="\${style}">\${data.content}</pre>\`;
                         } else {
                             // For code files, add line numbers and use Prism.js syntax highlighting
                             const lines = data.content.split('\\n');
                             const numberedContent = lines.map((line, index) => {
                                 const lineNumber = (index + 1).toString().padStart(4, ' ');
                                 const escapedLine = line
                                     .replace(/&/g, '&amp;')
                                     .replace(/</g, '&lt;')
                                     .replace(/>/g, '&gt;');
                                 return \`<span class="line-number">\${lineNumber}</span><span class="line-content">\${escapedLine}</span>\`;
                             }).join('\\n');
                             
                             contentElement.innerHTML = \`
                                 <pre class="language-\${language} line-numbers" style="margin: 0; height: 100%; overflow-y: auto; font-size: 0.875rem; line-height: 1.4;"><code class="language-\${language}">\${numberedContent}</code></pre>
                             \`;
                             
                             // Apply syntax highlighting
                             if (window.Prism) {
                                 Prism.highlightAllUnder(contentElement);
                             }
                         }
                        
                        // Try to load corresponding answer file for split view
                        await loadCorrespondingAnswerFile(filePath, fileName, category, evalName);
                    }
                } else {
                    if (contentElement) {
                        contentElement.innerHTML = '<p style="color: #dc2626; padding: 1rem;">File not found or could not be loaded.</p>';
                    }
                }
            } catch (error) {
                const contentElement = document.getElementById(\`file-content-\${category}-\${evalName}\`);
                if (contentElement) {
                    contentElement.innerHTML = \`<p style="color: #dc2626; padding: 1rem;">Error loading file: \${error.message}</p>\`;
                }
            }
        }
        
        async function loadCorrespondingAnswerFile(outputFilePath, fileName, category, evalName) {
            try {
                console.log('Trying to find answer for:', outputFilePath, 'fileName:', fileName);
                
                // Convert output file path to answer file path
                // Example: /path/to/output/gpt-5/000-fundamentals/007-basic_file_storage/convex/index.ts
                // Should become: evals/000-fundamentals/007-basic_file_storage/answer/convex/index.ts
                
                // Normalize path separators for both Windows and Unix
                const normalizedPath = outputFilePath.replace(/\\\\/g, '/');
                const pathParts = normalizedPath.split('/');
                console.log('Path parts:', pathParts);
                
                // Find the category and eval name in the path
                const categoryIndex = pathParts.findIndex(part => part === category);
                const evalIndex = pathParts.findIndex(part => part === evalName);
                
                if (categoryIndex === -1 || evalIndex === -1) {
                    console.log('Category or eval not found in path');
                    return;
                }
                
                // Get the relative path after the eval name
                const relativePathParts = pathParts.slice(evalIndex + 1);
                console.log('Relative path parts:', relativePathParts);
                
                // Build answer path: evals/category/evalName/answer/relativePath
                const answerFilePath = \`evals/\${category}/\${evalName}/answer/\${relativePathParts.join('/')}\`;
                console.log('Trying answer path:', answerFilePath);
                
                // Try to load the answer file
                const response = await fetch(\`/file/\${encodeURIComponent(answerFilePath)}\`);
                const answerPane = document.getElementById(\`answer-pane-\${category}-\${evalName}\`);
                const answerContentElement = document.getElementById(\`answer-content-\${category}-\${evalName}\`);
                
                if (response.ok && answerContentElement) {
                    console.log('Answer file found! Loading content...');
                    const data = await response.json(); // Back to json() since endpoint returns JSON
                    const content = data.content;
                    const language = getLanguageFromFileName(fileName);
                    const isLogFile = fileName.endsWith('.log') || fileName.endsWith('.txt');
                    
                                             if (isLogFile || language === 'text' || language === 'log') {
                             const style = isLogFile 
                                 ? 'white-space: pre-wrap; background: #1f2937; color: #f3f4f6; padding: 1rem; margin: 0; font-family: "Monaco", "Menlo", "Ubuntu Mono", monospace; font-size: 0.875rem; line-height: 1.4; height: 100%; overflow-y: auto;'
                                 : 'white-space: pre-wrap; background: #f8fafc; color: #374151; padding: 1rem; margin: 0; font-family: "Monaco", "Menlo", "Ubuntu Mono", monospace; font-size: 0.875rem; line-height: 1.4; height: 100%; overflow-y: auto; border: 1px solid #e5e7eb;';
                             
                             answerContentElement.innerHTML = \`<pre style="\${style}">\${content}</pre>\`;
                         } else {
                             // For code files, add line numbers and use Prism.js syntax highlighting
                             const lines = content.split('\\n');
                             const numberedContent = lines.map((line, index) => {
                                 const lineNumber = (index + 1).toString().padStart(4, ' ');
                                 const escapedLine = line
                                     .replace(/&/g, '&amp;')
                                     .replace(/</g, '&lt;')
                                     .replace(/>/g, '&gt;');
                                 return \`<span class="line-number">\${lineNumber}</span><span class="line-content">\${escapedLine}</span>\`;
                             }).join('\\n');
                             
                             answerContentElement.innerHTML = \`
                                 <pre class="language-\${language} line-numbers" style="margin: 0; height: 100%; overflow-y: auto; font-size: 0.875rem; line-height: 1.4;"><code class="language-\${language}">\${numberedContent}</code></pre>
                             \`;
                             
                             if (window.Prism) {
                                 Prism.highlightAllUnder(answerContentElement);
                             }
                         }
                    
                    // Show the answer pane
                    if (answerPane) {
                        answerPane.style.display = 'flex';
                        console.log('Answer pane shown');
                    }
                } else {
                    console.log('No answer file found, response status:', response.status);
                    // Hide the answer pane if no corresponding file found
                    if (answerPane) {
                        answerPane.style.display = 'none';
                    }
                }
            } catch (error) {
                // Hide the answer pane on error
                const answerPane = document.getElementById(\`answer-pane-\${category}-\${evalName}\`);
                if (answerPane) {
                    answerPane.style.display = 'none';
                }
            }
        }
        
        // Directory and log functions
        function copyDirectoryPath(path) {
            navigator.clipboard.writeText(path).then(() => {
                // Show a brief success indicator
                const button = event.target;
                const originalText = button.textContent;
                button.textContent = '✓';
                button.style.background = '#10b981';
                setTimeout(() => {
                    button.textContent = originalText;
                    button.style.background = '#4f46e5';
                }, 1000);
            }).catch(() => {
                // Fallback for older browsers
                prompt("Copy this directory path:", path);
            });
        }

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
        
        // Auto-refresh disabled for better user experience
        // setTimeout(() => {
        //     window.location.reload();
        // }, 30000);
        
                 // Debug function to test answer loading
         window.testAnswerLoad = function(category, evalName) {
             console.log('Testing answer load for:', category, evalName);
             const testPath = \`C:\\\\Users\\\\mikec\\\\AppData\\\\Local\\\\Temp\\\\tmp123/output/gpt-5/\${category}/\${evalName}/convex/index.ts\`;
             loadCorrespondingAnswerFile(testPath, 'index.ts', category, evalName);
         };
         
         // Split pane resizing functionality
         let isResizing = false;
         let currentSplitContainer = null;
         
         function initSplitResize(event, category, evalName) {
             isResizing = true;
             currentSplitContainer = document.getElementById(\`file-content-split-\${category}-\${evalName}\`);
             
             // Prevent text selection during drag
             document.body.style.userSelect = 'none';
             document.body.style.cursor = 'col-resize';
             
             // Add event listeners
             document.addEventListener('mousemove', handleSplitResize);
             document.addEventListener('mouseup', stopSplitResize);
             
             event.preventDefault();
         }
         
         function handleSplitResize(event) {
             if (!isResizing || !currentSplitContainer) return;
             
             const containerRect = currentSplitContainer.getBoundingClientRect();
             const mouseX = event.clientX;
             const containerLeft = containerRect.left;
             const containerWidth = containerRect.width;
             
             // Calculate percentage (between 20% and 80%)
             let percentage = ((mouseX - containerLeft) / containerWidth) * 100;
             percentage = Math.max(20, Math.min(80, percentage));
             
             // Update the flex basis of the first pane
             const firstPane = currentSplitContainer.querySelector('.file-content-pane:first-child');
             if (firstPane) {
                 firstPane.style.flex = \`0 0 \${percentage}%\`;
             }
         }
         
         function stopSplitResize() {
             isResizing = false;
             currentSplitContainer = null;
             
             // Restore normal cursor and text selection
             document.body.style.userSelect = '';
             document.body.style.cursor = '';
             
             // Remove event listeners
             document.removeEventListener('mousemove', handleSplitResize);
             document.removeEventListener('mouseup', stopSplitResize);
         }
         
         // Sidebar collapse/expand functionality
         function toggleSidebar(sidebarId) {
             const sidebar = document.getElementById(sidebarId);
             const button = sidebar.querySelector('.sidebar-collapse-btn');
             
             if (sidebar.classList.contains('collapsed')) {
                 // Expand
                 sidebar.classList.remove('collapsed');
                 button.innerHTML = '◀';
                 button.title = 'Collapse sidebar';
             } else {
                 // Collapse
                 sidebar.classList.add('collapsed');
                 button.innerHTML = '▶';
                 button.title = 'Expand sidebar';
             }
         }
         
         // Make file paths in log content clickable
         function makeLogPathsClickable(logContent, category, evalName) {
             // Escape HTML first
             const escapedContent = logContent
                 .replace(/&/g, '&amp;')
                 .replace(/</g, '&lt;')
                 .replace(/>/g, '&gt;');
             
             // Regex to match file paths - looking for patterns like:
             // convex/file.ts, src/file.js, ./file.ts, /path/to/file.ts
             // Also match paths with line numbers like: convex/file.ts(14,18) or convex/file.ts:14:18
             const filePathRegex = /(?:^|\\s)((?:[a-zA-Z0-9_-]+\\/)*[a-zA-Z0-9_-]+\\.[a-zA-Z0-9]+)(?:\\((\\d+)(?:,\\d+)?\\)|:(\\d+)(?::\\d+)?)?/gm;
             
             return escapedContent.replace(filePathRegex, (match, filePath, lineNum1, lineNum2) => {
                 const lineNumber = lineNum1 || lineNum2;
                 const displayPath = match.trim();
                 const cleanPath = filePath.replace(/\\\\/g, '/');
                 
                 // Create clickable link that switches to Output tab and opens the file
                 return \` <span class="log-file-path" onclick="openFileFromLog('\${cleanPath}', '\${category}', '\${evalName}', \${lineNumber || 'null'})" title="Click to open \${cleanPath}">\${displayPath}</span>\`;
             });
         }
         
         // Function to open a file from log click
         async function openFileFromLog(filePath, category, evalName, lineNumber) {
             // Update URL to navigate to output tab with the specific file
             const runIndex = getCurrentRunIndex();
             let newUrl = \`/run-\${runIndex}/\${category}/\${evalName}/output#\${encodeURIComponent(filePath)}\`;
             if (lineNumber) {
                 newUrl += \`:\${lineNumber}\`;
             }
             
             // Navigate to the new URL, which will trigger a page reload with the correct state
             window.location.href = newUrl;
         }
         
         // Function to scroll to a specific line number
         function scrollToLineNumber(lineNumber, category, evalName) {
             const contentElement = document.getElementById(\`file-content-\${category}-\${evalName}\`);
             if (contentElement) {
                 const lineElements = contentElement.querySelectorAll('.line-number');
                 for (const lineEl of lineElements) {
                     if (lineEl.textContent.trim() === lineNumber.toString().padStart(4, ' ')) {
                         lineEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
                         // Highlight the line briefly
                         const lineContent = lineEl.nextElementSibling;
                         if (lineContent) {
                             lineContent.style.backgroundColor = '#fef3c7';
                             setTimeout(() => {
                                 lineContent.style.backgroundColor = '';
                             }, 2000);
                         }
                         break;
                     }
                 }
             }
         }
         
         // Function to update URL with current tab and file
         function updateURL(category, evalName, tab, fileName) {
             const runIndex = getCurrentRunIndex();
             let url = \`/run-\${runIndex}/\${category}/\${evalName}\`;
             
             if (tab) {
                 url += \`/\${tab}\`;
                 if (fileName && (tab === 'output' || tab === 'answer')) {
                     url += \`#\${encodeURIComponent(fileName)}\`;
                 }
             }
             
             // Update URL without triggering page reload
             window.history.replaceState({}, '', url);
         }
        
        // Answer directory functions
        async function loadAnswerDirectory(category, evalName) {
            try {
                const answerPath = 'evals/' + category + '/' + evalName + '/answer';
                const response = await fetch(\`/browse/\${encodeURIComponent(answerPath)}\`);
                const treeElement = document.getElementById(\`answer-file-tree-content-\${category}-\${evalName}\`);
                
                if (response.ok) {
                    const data = await response.json();
                    if (treeElement && data.files) {
                        const fileTreeHTML = data.files.map(file => {
                            const safeId = btoa(file.path).replace(/[^a-zA-Z0-9]/g, '');
                            if (file.isDirectory) {
                                return \`
                                    <div class="directory-container">
                                        <button class="file-tree-item directory" onclick="toggleAnswerDirectory('\${file.path.replace(/\\\\/g, '\\\\\\\\')}', '\${file.name}', '\${category}', '\${evalName}')">
                                            <span>📁 \${file.name}</span>
                                            <span class="expand-arrow">▶</span>
                                        </button>
                                        <div class="file-tree-children collapsed" id="answer-children-\${safeId}"></div>
                                    </div>
                                \`;
                            } else {
                                return \`<button class="file-tree-item file" onclick="loadAnswerFile('\${file.path.replace(/\\\\/g, '\\\\\\\\')}', '\${file.name}', '\${category}', '\${evalName}')" title="\${file.name}">📄 \${file.name}</button>\`;
                            }
                        }).join('');
                        treeElement.innerHTML = fileTreeHTML;
                    }
                } else {
                    if (treeElement) {
                        treeElement.innerHTML = '<p style="color: #dc2626;">Answer directory not found.</p>';
                    }
                }
            } catch (error) {
                const treeElement = document.getElementById(\`answer-file-tree-content-\${category}-\${evalName}\`);
                if (treeElement) {
                    treeElement.innerHTML = \`<p style="color: #dc2626;">Error loading answer directory: \${error.message}</p>\`;
                }
            }
        }
        
        async function toggleAnswerDirectory(dirPath, dirName, category, evalName) {
            const safeId = btoa(dirPath).replace(/[^a-zA-Z0-9]/g, '');
            const childrenContainer = document.getElementById(\`answer-children-\${safeId}\`);
            const button = event.target.closest('.file-tree-item.directory');
            const arrow = button ? button.querySelector('.expand-arrow') : null;
            
            if (!childrenContainer) return;
            
            if (childrenContainer.classList.contains('collapsed')) {
                try {
                    const response = await fetch(\`/browse/\${encodeURIComponent(dirPath)}\`);
                    if (response.ok) {
                        const data = await response.json();
                        if (data.files) {
                            const childrenHTML = data.files.map(file => {
                                const childSafeId = btoa(file.path).replace(/[^a-zA-Z0-9]/g, '');
                                if (file.isDirectory) {
                                    return \`
                                        <div class="directory-container">
                                            <button class="file-tree-item directory" onclick="toggleAnswerDirectory('\${file.path.replace(/\\\\/g, '\\\\\\\\')}', '\${file.name}', '\${category}', '\${evalName}')">
                                                <span>📁 \${file.name}</span>
                                                <span class="expand-arrow">▶</span>
                                            </button>
                                            <div class="file-tree-children collapsed" id="answer-children-\${childSafeId}"></div>
                                        </div>
                                    \`;
                                } else {
                                    return \`<button class="file-tree-item file" onclick="loadAnswerFile('\${file.path.replace(/\\\\/g, '\\\\\\\\')}', '\${file.name}', '\${category}', '\${evalName}')" title="\${file.name}">📄 \${file.name}</button>\`;
                                }
                            }).join('');
                            childrenContainer.innerHTML = childrenHTML;
                        }
                    }
                } catch (error) {
                    childrenContainer.innerHTML = '<p style="color: #dc2626; padding: 0.5rem;">Error loading directory</p>';
                }
                
                childrenContainer.classList.remove('collapsed');
                if (arrow) arrow.classList.add('expanded');
            } else {
                childrenContainer.classList.add('collapsed');
                if (arrow) arrow.classList.remove('expanded');
            }
        }
        
        async function loadAnswerFile(filePath, fileName, category, evalName) {
            try {
                const treeItems = document.querySelectorAll(\`#answer-file-tree-content-\${category}-\${evalName} .file-tree-item\`);
                treeItems.forEach(item => item.classList.remove('active'));
                
                if (typeof event !== 'undefined' && event.target) {
                    event.target.classList.add('active');
                }
                
                                 const fileNameElement = document.getElementById(\`answer-current-file-name-\${category}-\${evalName}\`);
                 if (fileNameElement) {
                     fileNameElement.textContent = fileName;
                 }
                 
                 // Update URL to include the selected answer file
                 updateURL(category, evalName, 'answer', fileName);
                
                const response = await fetch(\`/file/\${encodeURIComponent(filePath)}\`);
                const contentElement = document.getElementById(\`answer-file-content-\${category}-\${evalName}\`);
                
                if (response.ok) {
                    const data = await response.json();
                    if (contentElement) {
                        const language = getLanguageFromFileName(fileName);
                        const isLogFile = fileName.endsWith('.log') || fileName.endsWith('.txt');
                        
                                                 if (isLogFile || language === 'text' || language === 'log') {
                             const style = isLogFile 
                                 ? 'white-space: pre-wrap; background: #1f2937; color: #f3f4f6; padding: 1rem; margin: 0; font-family: "Monaco", "Menlo", "Ubuntu Mono", monospace; font-size: 0.875rem; line-height: 1.4; height: 100%; overflow-y: auto;'
                                 : 'white-space: pre-wrap; background: #f8fafc; color: #374151; padding: 1rem; margin: 0; font-family: "Monaco", "Menlo", "Ubuntu Mono", monospace; font-size: 0.875rem; line-height: 1.4; height: 100%; overflow-y: auto; border: 1px solid #e5e7eb;';
                             
                             contentElement.innerHTML = \`<pre style="\${style}">\${data.content}</pre>\`;
                         } else {
                             // For code files, add line numbers and use Prism.js syntax highlighting
                             const lines = data.content.split('\\n');
                             const numberedContent = lines.map((line, index) => {
                                 const lineNumber = (index + 1).toString().padStart(4, ' ');
                                 const escapedLine = line
                                     .replace(/&/g, '&amp;')
                                     .replace(/</g, '&lt;')
                                     .replace(/>/g, '&gt;');
                                 return \`<span class="line-number">\${lineNumber}</span><span class="line-content">\${escapedLine}</span>\`;
                             }).join('\\n');
                             
                             contentElement.innerHTML = \`
                                 <pre class="language-\${language} line-numbers" style="margin: 0; height: 100%; overflow-y: auto; font-size: 0.875rem; line-height: 1.4;"><code class="language-\${language}">\${numberedContent}</code></pre>
                             \`;
                             
                             if (window.Prism) {
                                 Prism.highlightAllUnder(contentElement);
                             }
                         }
                    }
                } else {
                    if (contentElement) {
                        contentElement.innerHTML = '<p style="color: #dc2626; padding: 1rem;">File not found or could not be loaded.</p>';
                    }
                }
            } catch (error) {
                const contentElement = document.getElementById(\`answer-file-content-\${category}-\${evalName}\`);
                if (contentElement) {
                    contentElement.innerHTML = \`<p style="color: #dc2626; padding: 1rem;">Error loading file: \${error.message}</p>\`;
                }
            }
        }
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
      const fragment = url.hash.slice(1); // Remove the # character

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

        // Handle directory listing requests
        if (pathParts[0] === "browse") {
          try {
            const dirPath = decodeURIComponent(pathParts.slice(1).join("/"));
            const fs = require("fs");
            const path = require("path");

            if (!fs.existsSync(dirPath)) {
              return new Response("Directory not found", { status: 404 });
            }

            const items = fs.readdirSync(dirPath, { withFileTypes: true });
            const fileTree = items.map((item: any) => ({
              name: item.name,
              isDirectory: item.isDirectory(),
              path: path.join(dirPath, item.name),
            }));

            return new Response(JSON.stringify({ files: fileTree }), {
              headers: { "Content-Type": "application/json" },
            });
          } catch (err) {
            return new Response("Error reading directory", { status: 500 });
          }
        }

        // Handle file content requests
        if (pathParts[0] === "file") {
          try {
            const filePath = decodeURIComponent(pathParts.slice(1).join("/"));
            const fs = require("fs");

            if (!fs.existsSync(filePath)) {
              return new Response("File not found", { status: 404 });
            }

            const content = fs.readFileSync(filePath, "utf-8");
            return new Response(JSON.stringify({ content }), {
              headers: { "Content-Type": "application/json" },
            });
          } catch (err) {
            return new Response("Error reading file", { status: 500 });
          }
        }

        // Route handling
        let currentView = "runs-list";
        let runIndex = -1;
        let category = "";
        let evalName = "";
        let selectedTab = "log"; // Default tab
        let selectedFile = "";
        let selectedLine = null;

        // Parse file and line from URL fragment (e.g., #convex/index.ts:42)
        if (fragment) {
          const colonIndex = fragment.lastIndexOf(":");
          if (colonIndex > 0 && /^\d+$/.test(fragment.slice(colonIndex + 1))) {
            // Fragment has line number
            selectedFile = decodeURIComponent(fragment.slice(0, colonIndex));
            selectedLine = parseInt(fragment.slice(colonIndex + 1));
          } else {
            // Fragment is just a file path
            selectedFile = decodeURIComponent(fragment);
          }
        }

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

                  // Check if there's a tab specified
                  if (pathParts.length >= 4) {
                    selectedTab = pathParts[3];
                  }

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
          selectedTab,
          selectedFile,
          selectedLine,
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
