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
            if tests_pass >= 0.999:
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
        log_info("")
        log_info("=== Eval Summary ===")
        log_info(f"Model: {results[0].metadata.get('model_name', 'unknown') if results and results[0].metadata else 'unknown'}")
        log_info(f"Overall: {overall_rate:.2%} ({total_passed} pass, {total_num_tests - total_passed} fail)")
        for category in sorted(num_tests.keys()):
            rate = scores[category] / num_tests[category]
            cat_pass = passed_counts.get(category, 0)
            log_info(f"- {category}: {rate:.2%} ({cat_pass} pass, {num_tests[category] - cat_pass} fail)")

        # Always write local results; print the path
        log_info(f"Results written to: {OUTPUT_RESULTS_FILE}")

        if jsonl:
            log_info(json.dumps(summary.as_dict()))

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
        entry = {
            "summary": result.summary.as_dict(),
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

    num_tests: dict[str, int] = {}
    tests_pass_scores: dict[str, float] = {}
    total_score = 0.0
    total_num_tests = 0
    for r in results:
        category = r.metadata.get("category") if r.metadata else "unknown"
        num_tests[category] = num_tests.get(category, 0) + 1
        score_val = 0.0
        if r.scores and "Tests pass" in r.scores and isinstance(r.scores["Tests pass"], (int, float)):
            score_val = float(r.scores["Tests pass"])  # already normalized ratio per our scorer
        tests_pass_scores[category] = tests_pass_scores.get(category, 0.0) + score_val
        total_num_tests += 1
        total_score += score_val

    overall_rate = (total_score / total_num_tests) if total_num_tests > 0 else 0.0
    model_name = None
    if results and results[0].metadata and "model_name" in results[0].metadata:
        model_name = results[0].metadata["model_name"]

    log_info("")
    log_info("=== Eval Summary ===")
    log_info(f"Model: {model_name if model_name else 'unknown'}")
    log_info(f"Overall: {overall_rate:.2%} ({total_num_tests} tests)")
    for category in sorted(num_tests.keys()):
        rate = (tests_pass_scores.get(category, 0.0) / num_tests[category]) if num_tests[category] > 0 else 0.0
        log_info(f"- {category}: {rate:.2%} ({num_tests[category]} tests)")
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


