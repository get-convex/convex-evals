import os
import json
import hashlib
import requests
import zipfile
import tempfile
from braintrust import Reporter
from runner.logging import log_info
from braintrust.framework import report_failures, EvalResultWithSummary


# Config
OUTPUT_RESULTS_FILE = os.getenv("LOCAL_RESULTS", "local_results.jsonl")
CONVEX_EVAL_ENDPOINT = os.getenv("CONVEX_EVAL_ENDPOINT")
CONVEX_AUTH_TOKEN = os.getenv("CONVEX_AUTH_TOKEN")
EVALS_EXPERIMENT = os.getenv("EVALS_EXPERIMENT")

# Cache for eval source hashes to avoid re-uploading
_eval_source_cache: dict[str, str] = {}  # hash -> storageId


def _make_convex_request(endpoint_suffix: str, payload: dict) -> dict | None:
    """Make a request to Convex endpoint. Returns response JSON or None on error."""
    if CONVEX_EVAL_ENDPOINT is None or CONVEX_AUTH_TOKEN is None:
        log_info(f"Skipping {endpoint_suffix}: CONVEX_EVAL_ENDPOINT or CONVEX_AUTH_TOKEN not set")
        return None
    
    base_url = CONVEX_EVAL_ENDPOINT.rstrip("/")
    if not base_url.endswith("/updateScores"):
        # If endpoint doesn't end with /updateScores, assume it's a base URL
        url = f"{base_url}/{endpoint_suffix}"
    else:
        # Replace /updateScores with the new endpoint
        url = base_url.replace("/updateScores", f"/{endpoint_suffix}")
    
    log_info(f"POST {url} with payload keys: {list(payload.keys())}")
    try:
        response = requests.post(
            url,
            json=payload,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {CONVEX_AUTH_TOKEN}",
            },
        )
        if response.status_code == 200:
            result = response.json()
            log_info(f"Successfully posted to {endpoint_suffix}")
            return result
        else:
            log_info(f"Failed to post to {endpoint_suffix}: HTTP {response.status_code}")
            log_info(f"Response: {response.text}")
            return None
    except Exception as e:
        log_info(f"Error posting to {endpoint_suffix}: {str(e)}")
        return None


def start_run(model: str, planned_evals: list[str], provider: str | None = None, run_id: str | None = None, experiment: str | None = None) -> str | None:
    """Start a new run. Returns the Convex run ID (not the external run_id)."""
    payload = {
        "model": model,
        "plannedEvals": planned_evals,
    }
    if provider:
        payload["provider"] = provider
    if run_id:
        payload["runId"] = run_id
    if experiment:
        payload["experiment"] = experiment
    elif EVALS_EXPERIMENT:
        payload["experiment"] = EVALS_EXPERIMENT
    
    result = _make_convex_request("startRun", payload)
    if result and result.get("success") and "runId" in result:
        return result["runId"]
    return None


def _compute_directory_hash(dir_path: str, exclude_dirs: list[str] | None = None) -> str:
    """Compute MD5 hash of a directory's contents (excluding certain directories)."""
    if exclude_dirs is None:
        exclude_dirs = ["node_modules", "_generated", "__pycache__"]
    
    hasher = hashlib.md5()
    
    for root, dirs, files in sorted(os.walk(dir_path)):
        # Filter out excluded directories
        dirs[:] = sorted([d for d in dirs if d not in exclude_dirs])
        
        for filename in sorted(files):
            file_path = os.path.join(root, filename)
            rel_path = os.path.relpath(file_path, dir_path)
            
            # Add the relative path to the hash
            hasher.update(rel_path.encode("utf-8"))
            
            # Add the file contents to the hash
            try:
                with open(file_path, "rb") as f:
                    hasher.update(f.read())
            except Exception:
                pass  # Skip files that can't be read
    
    return hasher.hexdigest()


def _check_asset_hash(hash_value: str) -> str | None:
    """Check if an asset with this hash already exists. Returns storageId if exists."""
    # Check local cache first
    if hash_value in _eval_source_cache:
        return _eval_source_cache[hash_value]
    
    result = _make_convex_request("checkAssetHash", {"hash": hash_value})
    if result and result.get("exists") and "storageId" in result:
        storage_id = result["storageId"]
        _eval_source_cache[hash_value] = storage_id
        return storage_id
    return None


def _register_asset(hash_value: str, asset_type: str, storage_id: str) -> bool:
    """Register a new asset in the evalAssets table."""
    result = _make_convex_request("registerAsset", {
        "hash": hash_value,
        "assetType": asset_type,
        "storageId": storage_id,
    })
    if result and result.get("success"):
        _eval_source_cache[hash_value] = storage_id
        return True
    return False


def _zip_eval_source(eval_path: str) -> str | None:
    """Zip the eval source directory (excluding node_modules, _generated).
    Returns path to the zip file."""
    if not os.path.exists(eval_path):
        log_info(f"Eval path does not exist: {eval_path}")
        return None
    
    try:
        fd, zip_path = tempfile.mkstemp(suffix=".zip")
        os.close(fd)
        
        exclude_dirs = {"node_modules", "_generated", "__pycache__"}
        
        with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zf:
            for root, dirs, files in os.walk(eval_path):
                # Skip excluded directories
                dirs[:] = [d for d in dirs if d not in exclude_dirs]
                
                for file in files:
                    file_path = os.path.join(root, file)
                    arcname = os.path.relpath(file_path, eval_path)
                    zf.write(file_path, arcname)
        
        return zip_path
    except Exception as e:
        log_info(f"Error creating eval source zip: {str(e)}")
        return None


def _get_task_content(eval_path: str) -> str | None:
    """Read the TASK.txt content from the eval directory."""
    task_file = os.path.join(eval_path, "TASK.txt")
    if os.path.exists(task_file):
        try:
            with open(task_file, "r", encoding="utf-8") as f:
                return f.read()
        except Exception as e:
            log_info(f"Error reading TASK.txt: {str(e)}")
    return None


def get_or_upload_eval_source(eval_path: str) -> tuple[str | None, str | None]:
    """Get or upload eval source files with deduplication.
    Returns (task_content, storage_id) tuple."""
    if CONVEX_EVAL_ENDPOINT is None or CONVEX_AUTH_TOKEN is None:
        return None, None
    
    # Get task content
    task_content = _get_task_content(eval_path)
    
    # Compute hash of the eval directory
    dir_hash = _compute_directory_hash(eval_path)
    
    # Check if already uploaded
    existing_storage_id = _check_asset_hash(dir_hash)
    if existing_storage_id:
        log_info(f"Eval source already uploaded (hash: {dir_hash[:8]}...)")
        return task_content, existing_storage_id
    
    # Zip and upload
    zip_path = _zip_eval_source(eval_path)
    if not zip_path:
        return task_content, None
    
    try:
        storage_id = upload_to_convex_storage(zip_path)
        if storage_id:
            # Register the asset
            if _register_asset(dir_hash, "evalSource", storage_id):
                log_info(f"Uploaded and registered eval source (hash: {dir_hash[:8]}...)")
                return task_content, storage_id
            else:
                log_info("Failed to register eval source asset")
                return task_content, storage_id  # Still return storage_id even if registration failed
    finally:
        try:
            os.unlink(zip_path)
        except Exception:
            pass
    
    return task_content, None


def start_eval(run_id: str, eval_path: str, category: str, name: str, task: str | None = None, eval_source_storage_id: str | None = None) -> str | None:
    """Start a new eval. Returns the Convex eval ID."""
    payload = {
        "runId": run_id,
        "evalPath": eval_path,
        "category": category,
        "name": name,
    }
    if task:
        payload["task"] = task
    if eval_source_storage_id:
        payload["evalSourceStorageId"] = eval_source_storage_id
    
    result = _make_convex_request("startEval", payload)
    if result and result.get("success") and "evalId" in result:
        return result["evalId"]
    return None


def record_step(eval_id: str, step_name: str, status: dict) -> str | None:
    """Record a step result. Returns the Convex step ID."""
    payload = {
        "evalId": eval_id,
        "name": step_name,
        "status": status,
    }
    
    result = _make_convex_request("recordStep", payload)
    if result and result.get("success") and "stepId" in result:
        return result["stepId"]
    return None


def zip_output_directory(output_dir: str) -> str | None:
    """Zip the output directory, excluding node_modules and _generated folders.
    Returns the path to the zip file, or None on error."""
    if not os.path.exists(output_dir):
        log_info(f"Output directory does not exist: {output_dir}")
        return None
    
    try:
        # Create a temp file for the zip
        fd, zip_path = tempfile.mkstemp(suffix=".zip")
        os.close(fd)
        
        with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zf:
            for root, dirs, files in os.walk(output_dir):
                # Skip node_modules and _generated directories
                dirs[:] = [d for d in dirs if d not in ('node_modules', '_generated')]
                
                for file in files:
                    file_path = os.path.join(root, file)
                    arcname = os.path.relpath(file_path, output_dir)
                    zf.write(file_path, arcname)
        
        return zip_path
    except Exception as e:
        log_info(f"Error creating zip file: {str(e)}")
        return None


def upload_to_convex_storage(zip_path: str) -> str | None:
    """Upload a zip file to Convex storage. Returns the storage ID, or None on error."""
    if CONVEX_EVAL_ENDPOINT is None or CONVEX_AUTH_TOKEN is None:
        log_info("Skipping upload: CONVEX_EVAL_ENDPOINT or CONVEX_AUTH_TOKEN not set")
        return None
    
    # First, get an upload URL
    result = _make_convex_request("generateUploadUrl", {})
    if not result or not result.get("success") or "uploadUrl" not in result:
        log_info("Failed to get upload URL")
        return None
    
    upload_url = result["uploadUrl"]
    
    # Upload the file
    try:
        with open(zip_path, 'rb') as f:
            response = requests.post(
                upload_url,
                data=f,
                headers={
                    "Content-Type": "application/zip",
                },
            )
        
        if response.status_code == 200:
            result = response.json()
            storage_id = result.get("storageId")
            if storage_id:
                log_info(f"Successfully uploaded to Convex storage: {storage_id}")
                return storage_id
            else:
                log_info(f"Upload succeeded but no storageId in response: {result}")
                return None
        else:
            log_info(f"Failed to upload: HTTP {response.status_code}")
            log_info(f"Response: {response.text}")
            return None
    except Exception as e:
        log_info(f"Error uploading to Convex storage: {str(e)}")
        return None


def complete_eval(eval_id: str, status: dict, output_dir: str | None = None) -> bool:
    """Mark an eval as complete. Optionally zips and uploads the output directory."""
    # If output_dir is provided, zip and upload it
    storage_id = None
    if output_dir:
        zip_path = zip_output_directory(output_dir)
        if zip_path:
            try:
                storage_id = upload_to_convex_storage(zip_path)
                if storage_id:
                    status["outputStorageId"] = storage_id
            finally:
                # Clean up the temp zip file
                try:
                    os.unlink(zip_path)
                except Exception:
                    pass
    
    payload = {
        "evalId": eval_id,
        "status": status,
    }
    
    result = _make_convex_request("completeEval", payload)
    return result is not None and result.get("success", False)


def complete_run(run_id: str, status: dict) -> bool:
    """Mark a run as complete."""
    payload = {
        "runId": run_id,
        "status": status,
    }
    
    result = _make_convex_request("completeRun", payload)
    return result is not None and result.get("success", False)


def post_scores_to_convex(model_name: str, category_scores: dict, total_score: float) -> None:
    # Skip posting unless explicitly enabled or Braintrust is enabled
    post_to_convex = os.getenv("POST_TO_CONVEX") == "1"
    braintrust_enabled = os.getenv("DISABLE_BRAINTRUST") != "1"
    if not post_to_convex and not braintrust_enabled:
        return
    payload = {"model": model_name, "scores": category_scores, "totalScore": total_score}
    if EVALS_EXPERIMENT:
        payload["experiment"] = EVALS_EXPERIMENT
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

    # Post scores to Convex if enabled
    try:
        category_scores = {cat: tests_pass_scores[cat] / num_tests[cat] for cat in num_tests}
        post_scores_to_convex(model_name or "unknown", category_scores, overall_rate)
    except Exception as e:
        log_info(f"Error posting scores to Convex: {e}")

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


