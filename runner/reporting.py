import os
import json
import requests
from braintrust import Reporter
from runner.logging import log_info
from braintrust.framework import report_failures, EvalResultWithSummary


# Config
OUTPUT_RESULTS_FILE = os.getenv("LOCAL_RESULTS", "local_results.jsonl")
CONVEX_EVAL_ENDPOINT = os.getenv("CONVEX_EVAL_ENDPOINT")
CONVEX_AUTH_TOKEN = os.getenv("CONVEX_AUTH_TOKEN")


def post_scores_to_convex(model_name: str, category_scores: dict, total_score: float) -> None:
    # When Braintrust is disabled, also disable reporting to the Convex endpoint
    if os.getenv("DISABLE_BRAINTRUST") == "1":
        return
    payload = {"model": model_name, "scores": category_scores, "totalScore": total_score}
    if CONVEX_EVAL_ENDPOINT is not None and CONVEX_AUTH_TOKEN is not None:
        try:
            response = requests.post(
                CONVEX_EVAL_ENDPOINT,
                json=payload,
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {CONVEX_AUTH_TOKEN}",
                },
            )
            if response.status_code == 200:
                log_info(f"Successfully posted scores for model {model_name} to Convex")
            else:
                log_info(f"Failed to post scores: HTTP {response.status_code}")
                log_info(f"Response: {response.text}")
        except Exception as e:
            log_info(f"Error posting scores to Convex: {str(e)}")


def report_eval(evaluator, result: EvalResultWithSummary, verbose, jsonl):
    results = result.results
    summary = result.summary

    failing_results = [x for x in results if x.error]
    if len(failing_results) > 0:
        report_failures(evaluator, failing_results, verbose=verbose, jsonl=jsonl)
    else:
        num_tests = {}
        scores = {}
        passed_counts = {}
        total_score = 0
        total_num_tests = 0
        total_passed = 0
        for r in results:
            category = r.metadata["category"] if r.metadata and "category" in r.metadata else "unknown"
            if category not in num_tests:
                num_tests[category] = 0
                scores[category] = 0
                passed_counts[category] = 0
            num_tests[category] += 1
            tests_pass = r.scores.get("Tests pass") if r.scores else 0
            try:
                tests_pass = float(tests_pass)
            except Exception:
                tests_pass = 0
            scores[category] += tests_pass
            if tests_pass >= 1:
                passed_counts[category] += 1
                total_passed += 1
            total_num_tests += 1
            total_score += tests_pass

        # Post the scores to the Convex endpoint
        try:
            model_name = results[0].metadata["model_name"] if results and results[0].metadata else "unknown"
            category_scores = {category: scores[category] / num_tests[category] for category in num_tests}
            combined_score = (total_score / total_num_tests) if total_num_tests > 0 else 0
            post_scores_to_convex(model_name, category_scores, combined_score)
        except Exception as e:
            print(f"Error posting scores to Convex: {e}")

        # Pretty console summary
        overall_rate = (total_score / total_num_tests) if total_num_tests > 0 else 0
        print("", flush=True)
        print("=== Eval Summary ===", flush=True)
        print(f"Model: {results[0].metadata.get('model_name', 'unknown') if results and results[0].metadata else 'unknown'}", flush=True)
        print(f"Overall: {overall_rate:.2%} ({total_passed} pass, {total_num_tests - total_passed} fail)", flush=True)
        for category in sorted(num_tests.keys()):
            rate = scores[category] / num_tests[category]
            cat_pass = passed_counts.get(category, 0)
            print(f"- {category}: {rate:.2%} ({cat_pass} pass, {num_tests[category] - cat_pass} fail)", flush=True)

        # Always write local results; print the path
        print(f"Results written to: {OUTPUT_RESULTS_FILE}", flush=True)

        if jsonl:
            print(json.dumps(summary.as_dict()), flush=True)

    return len(failing_results) == 0


def report_run(eval_reports, verbose, jsonl):
    return all(x for x in eval_reports)


convex_reporter = Reporter(
    name="convex reporter",
    report_eval=report_eval,
    report_run=report_run,
)


def _write_local_results(result: EvalResultWithSummary):
    try:
        # Try to capture the tempdir from the first result's metadata (eval-level metadata is propagated)
        tempdir_value = None
        model_name = "unknown"
        try:
            if result and getattr(result, "results", None):
                first = result.results[0]
                if first and getattr(first, "metadata", None) and isinstance(first.metadata, dict):
                    tempdir_value = first.metadata.get("tempdir")
                    model_name = first.metadata.get("model_name", "unknown")
        except Exception:
            tempdir_value = None

        # Extract individual evaluation results with detailed information
        individual_results = []
        category_summaries = {}
        
        for r in result.results:
            if r.error:
                continue  # Skip failed results for now
                
            category = r.metadata.get("category", "unknown") if r.metadata else "unknown"
            name = r.metadata.get("eval_name", "unknown") if r.metadata else "unknown"
            
            # Determine pass/fail based on "Tests pass" score
            tests_pass_score = 0.0
            if r.scores and "Tests pass" in r.scores:
                try:
                    tests_pass_score = float(r.scores["Tests pass"])
                except:
                    tests_pass_score = 0.0
            
            passed = tests_pass_score >= 1
            
            # Determine failure reason from scores
            failure_reason = None
            if not passed:
                if r.scores:
                    for score_name, score_value in r.scores.items():
                        if isinstance(score_value, (int, float)) and score_value < 1:
                            if score_name == "Valid filesystem output":
                                failure_reason = "filesystem fail"
                                break
                            elif score_name == "`bun install` succeeds":
                                failure_reason = "install fail"
                                break
                            elif score_name == "`convex codegen` succeeds":
                                failure_reason = "codegen fail"
                                break
                            elif score_name == "Passes tsc":
                                failure_reason = "tsc fail"
                                break
                            elif score_name == "Passes eslint":
                                failure_reason = "eslint fail"
                                break
                            elif score_name == "`convex dev` succeeds":
                                failure_reason = "convex dev fail"
                                break
                            elif score_name == "Tests pass":
                                failure_reason = "tests fail"
                                break
                if not failure_reason:
                    failure_reason = "unknown fail"
            
            # Build directory path
            directory_path = None
            if tempdir_value:
                model = r.metadata.get("model", "unknown") if r.metadata else "unknown"
                directory_path = f"{tempdir_value}/output/{model}/{category}/{name}"
            
            individual_result = {
                "category": category,
                "name": name,
                "passed": passed,
                "tests_pass_score": tests_pass_score,
                "failure_reason": failure_reason,
                "directory_path": directory_path,
                "scores": r.scores if r.scores else {}
            }
            individual_results.append(individual_result)
            
            # Build category summaries
            if category not in category_summaries:
                category_summaries[category] = {"total": 0, "passed": 0, "failed": 0}
            category_summaries[category]["total"] += 1
            if passed:
                category_summaries[category]["passed"] += 1
            else:
                category_summaries[category]["failed"] += 1

        # Calculate overall statistics using binary pass/fail
        total_tests = len(individual_results)
        total_passed = sum(1 for r in individual_results if r["passed"])
        # With binary scoring, average of test scores equals pass/fail ratio
        overall_score = (total_passed / total_tests) if total_tests > 0 else 0.0

        entry = {
            "summary": result.summary.as_dict(),
            "tempdir": tempdir_value,
            "model_name": model_name,
            "individual_results": individual_results,
            "category_summaries": category_summaries,
            "run_stats": {
                "total_tests": total_tests,
                "total_passed": total_passed,
                "total_failed": total_tests - total_passed,
                "overall_score": overall_score
            }
        }
        with open(OUTPUT_RESULTS_FILE, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")
    except Exception as e:
        print(f"Failed to write local results file: {e}")


def file_report_eval(evaluator, result: EvalResultWithSummary, verbose, jsonl):
    _write_local_results(result)

    # Pretty console output as well
    results = result.results
    failing_results = [x for x in results if x.error]
    if failing_results:
        print()
        print("=== Eval Failures ===")
        for r in failing_results:
            category = r.metadata.get("category") if r.metadata else "unknown"
            name = r.metadata.get("eval_name") if r.metadata else "unknown"
            error_text = r.error if isinstance(r.error, str) else str(r.error)
            print(f"- {category}/{name}: {error_text}")
        print(f"Results written to: {OUTPUT_RESULTS_FILE}")
        return False

    num_tests: dict[str, int] = {}
    tests_pass_scores: dict[str, float] = {}
    passed_counts: dict[str, int] = {}
    total_score = 0.0
    total_num_tests = 0
    total_passed = 0
    for r in results:
        category = r.metadata.get("category") if r.metadata else "unknown"
        num_tests[category] = num_tests.get(category, 0) + 1
        score_val = 0.0
        if r.scores and "Tests pass" in r.scores and isinstance(r.scores["Tests pass"], (int, float)):
            score_val = float(r.scores["Tests pass"])  # already normalized ratio per our scorer
        tests_pass_scores[category] = tests_pass_scores.get(category, 0.0) + score_val
        if score_val >= 1:
            passed_counts[category] = passed_counts.get(category, 0) + 1
            total_passed += 1
        total_num_tests += 1
        total_score += score_val

    overall_rate = (total_score / total_num_tests) if total_num_tests > 0 else 0.0
    model_name = None
    if results and results[0].metadata and "model_name" in results[0].metadata:
        model_name = results[0].metadata["model_name"]

    log_info("")
    log_info("=== Eval Summary ===")
    log_info(f"Model: {model_name if model_name else 'unknown'}")
    log_info(f"Overall: {overall_rate:.2%} ({total_passed} pass, {total_num_tests - total_passed} fail)")
    for category in sorted(num_tests.keys()):
        rate = (tests_pass_scores.get(category, 0.0) / num_tests[category]) if num_tests[category] > 0 else 0.0
        cat_pass = passed_counts.get(category, 0)
        log_info(f"- {category}: {rate:.2%} ({cat_pass} pass, {num_tests[category] - cat_pass} fail)")
    if failing_results:
        log_info(f"Failures: {len(failing_results)} case(s)")
    log_info(f"Results written to: {OUTPUT_RESULTS_FILE}")

    return len(failing_results) == 0


def file_report_run(eval_reports, verbose, jsonl):
    return all(x for x in eval_reports)


file_reporter = Reporter(
    name="local-file reporter",
    report_eval=file_report_eval,
    report_run=file_report_run,
)


def combined_report_eval(evaluator, result: EvalResultWithSummary, verbose, jsonl):
    # Write local file without printing a second summary, then delegate to Braintrust reporter
    _write_local_results(result)
    return report_eval(evaluator, result, verbose, jsonl)


def combined_report_run(eval_reports, verbose, jsonl):
    return all(eval_reports)


combined_reporter = Reporter(
    name="combined reporter",
    report_eval=combined_report_eval,
    report_run=combined_report_run,
)


