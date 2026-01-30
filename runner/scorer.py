import os
import shutil
import subprocess
import re
import json
import tempfile
import time
from braintrust import traced, Score
from runner.convex_backend import convex_backend, admin_key
from runner.logging import append_log, append_log_block, log_cmd_results, log_info, log_vitest_results, run_command_step
from runner.reporting import record_step, complete_eval


def convex_scorer(model, tempdir, *, input, expected, metadata, output):
    model = metadata["model"]
    category = metadata["category"]
    name = metadata["eval_name"]
    eval_id = metadata.get("eval_id")  # Optional eval_id for incremental reporting

    output_project_dir = f"{tempdir}/output/{model}/{category}/{name}"
    os.makedirs(output_project_dir, exist_ok=True)
    output_project_dir_abs = os.path.abspath(output_project_dir)

    scores = []
    # Track step outcomes for a concise end-of-eval summary
    passed_filesystem = False
    passed_install = False
    passed_codegen = False
    passed_tsc = False
    passed_eslint = False
    passed_deploy = False

    eval_start_time = time.time()

    log_info(f"[{category}/{name}] Writing generated filesystem")
    run_log_path = os.path.join(output_project_dir_abs, "run.log")
    append_log(run_log_path, f"=== Eval: {category}/{name} ===")
    
    # Record filesystem step
    step_start = time.time()
    try:
        write_filesystem(output_project_dir_abs, output)
        scores.append(Score("Valid filesystem output", 1))
        passed_filesystem = True
        append_log(run_log_path, "[ok] write_filesystem")
        if eval_id:
            record_step(eval_id, "filesystem", {"kind": "passed", "durationMs": int((time.time() - step_start) * 1000)})
    except Exception as e:
        scores.append(Score("Valid filesystem output", 0))
        append_log(run_log_path, f"[error] write_filesystem: {e}")
        status = "❌"
        log_info(f"[eval] Result {status} {category}/{name} – filesystem fail – dir: {output_project_dir_abs}")
        if eval_id:
            record_step(eval_id, "filesystem", {"kind": "failed", "failureReason": str(e), "durationMs": int((time.time() - step_start) * 1000)})
            complete_eval(eval_id, {"kind": "failed", "failureReason": "filesystem fail", "durationMs": int((time.time() - eval_start_time) * 1000)}, output_project_dir_abs)
        return scores

    # run_command_step moved to runner.logging for reuse across modules

    log_info(f"[{category}/{name}] Installing dependencies (bun install)")
    step_start = time.time()
    if run_command_step(run_log_path, lambda: install_dependencies(output_project_dir_abs), "bun", "bun install"):
        scores.append(Score("`bun install` succeeds", 1))
        passed_install = True
        if eval_id:
            record_step(eval_id, "install", {"kind": "passed", "durationMs": int((time.time() - step_start) * 1000)})
    else:
        scores.append(Score("`bun install` succeeds", 0))
        log_info(f"Result ❌ – bun install fail – dir: {output_project_dir_abs}")
        if eval_id:
            record_step(eval_id, "install", {"kind": "failed", "failureReason": "bun install failed", "durationMs": int((time.time() - step_start) * 1000)})
            complete_eval(eval_id, {"kind": "failed", "failureReason": "install fail", "durationMs": int((time.time() - eval_start_time) * 1000)}, output_project_dir_abs)
        return scores

    output_backend_dir = f"{tempdir}/backends/output/{model}/{category}/{name}"
    os.makedirs(output_backend_dir, exist_ok=True)

    with convex_backend(output_backend_dir) as output_backend:
        log_info(f"[{category}/{name}] Deploying generated backend on port {output_backend['port']}")
        step_start = time.time()
        if run_command_step(run_log_path, lambda: deploy(output_backend, output_project_dir_abs), "convex-dev", "convex dev"):
            scores.append(Score("`convex dev` succeeds", 1))
            passed_deploy = True
            passed_codegen = True  # convex dev also generates code
            if eval_id:
                record_step(eval_id, "deploy", {"kind": "passed", "durationMs": int((time.time() - step_start) * 1000)})
        else:
            scores.append(Score("`convex dev` succeeds", 0))
            log_info(f"Result ❌ – convex dev fail – dir: {output_project_dir_abs}")
            if eval_id:
                record_step(eval_id, "deploy", {"kind": "failed", "failureReason": "convex dev failed", "durationMs": int((time.time() - step_start) * 1000)})
                complete_eval(eval_id, {"kind": "failed", "failureReason": "convex dev fail", "durationMs": int((time.time() - eval_start_time) * 1000)}, output_project_dir_abs)
            return scores

        log_info(f"[{category}/{name}] Typechecking (tsc)")
        step_start = time.time()
        if run_command_step(run_log_path, lambda: typecheck_code(output_project_dir_abs), "tsc", "tsc"):
            scores.append(Score("Passes tsc", 1))
            passed_tsc = True
            if eval_id:
                record_step(eval_id, "tsc", {"kind": "passed", "durationMs": int((time.time() - step_start) * 1000)})
        else:
            scores.append(Score("Passes tsc", 0))
            if eval_id:
                record_step(eval_id, "tsc", {"kind": "failed", "failureReason": "tsc failed", "durationMs": int((time.time() - step_start) * 1000)})

        log_info(f"[{category}/{name}] Linting (eslint)")
        step_start = time.time()
        if run_command_step(run_log_path, lambda: lint_code(output_project_dir_abs), "eslint", "eslint"):
            scores.append(Score("Passes eslint", 1))
            passed_eslint = True
            if eval_id:
                record_step(eval_id, "eslint", {"kind": "passed", "durationMs": int((time.time() - step_start) * 1000)})
        else:
            scores.append(Score("Passes eslint", 0))
            if eval_id:
                record_step(eval_id, "eslint", {"kind": "failed", "failureReason": "eslint failed", "durationMs": int((time.time() - step_start) * 1000)})

        eval_path = f"evals/{category}/{name}"
        answer_project_dir, answer_backend_dir = setup_answer_backend(
            tempdir, eval_path, model, category, name
        )
        log_info(f"[{category}/{name}] Setting up answer backend")
        log_info(f"[{category}/{name}] Installing answer dependencies")
        run_command_step(run_log_path, lambda: install_dependencies(answer_project_dir), "answer-bun", "(answer) bun install", cmd_prefix="(answer) ")

        with convex_backend(answer_backend_dir) as answer_backend:
            log_info(f"[{category}/{name}] Deploying answer backend on port {answer_backend['port']}")
            run_command_step(run_log_path, lambda: deploy(answer_backend, answer_project_dir), "answer-convex-dev", "(answer) convex dev", cmd_prefix="(answer) ")
            test_file = os.path.abspath(os.path.join(eval_path, "grader.test.ts"))
            tests_ratio = 0.0
            vitest_stdout = None
            test_cmd = None
            step_start = time.time()
            try:
                log_info(f"[{category}/{name}] Running tests")
                pass_rate, vitest_stdout, test_cmd = run_tests(output_backend, answer_backend, test_file)
                scores.append(Score("Tests pass", pass_rate))
                tests_ratio = pass_rate
                if eval_id:
                    if pass_rate == 1.0:
                        record_step(eval_id, "tests", {"kind": "passed", "durationMs": int((time.time() - step_start) * 1000)})
                    else:
                        record_step(eval_id, "tests", {"kind": "failed", "failureReason": f"tests failed ({pass_rate:.0%})", "durationMs": int((time.time() - step_start) * 1000)})
            except Exception as e:
                if isinstance(e, TestsFailedException):
                    scores.append(Score("Tests pass", e.ratio))
                    tests_ratio = e.ratio
                    vitest_stdout = e.vitest_stdout
                    test_cmd = e.test_cmd
                    if eval_id:
                        record_step(eval_id, "tests", {"kind": "failed", "failureReason": f"tests failed ({e.ratio:.0%})", "durationMs": int((time.time() - step_start) * 1000)})
                else:
                    scores.append(Score("Tests pass", 0))
                    tests_ratio = 0.0
                    if eval_id:
                        record_step(eval_id, "tests", {"kind": "failed", "failureReason": str(e), "durationMs": int((time.time() - step_start) * 1000)})
                append_log(run_log_path, f"[error] vitest: {e}")
            
            if test_cmd and vitest_stdout:
                log_vitest_results(run_log_path, test_cmd, vitest_stdout)

            status = "✅" if (
                passed_filesystem
                and passed_install
                and passed_codegen
                and passed_tsc
                and passed_eslint
                and passed_deploy
                and tests_ratio == 1
            ) else "❌"

            failures = []
            if not passed_install:
                failures.append("bun install fail")
            if not passed_codegen:
                failures.append("codegen fail")
            if not passed_tsc:
                failures.append("tsc fail")
            if not passed_eslint:
                failures.append("eslint fail")
            if not passed_deploy:
                failures.append("convex dev fail")
            if tests_ratio != 1:
                failures.append(f"tests fail ({tests_ratio:.0%})")

            details = "ok" if len(failures) == 0 else ", ".join(failures)
            log_info(f"Result {status} – {details} – dir: {output_project_dir_abs}")

            # Complete the eval (with output directory for zipping)
            if eval_id:
                eval_duration = int((time.time() - eval_start_time) * 1000)
                if status == "✅":
                    complete_eval(eval_id, {"kind": "passed", "durationMs": eval_duration}, output_project_dir_abs)
                else:
                    failure_reason = failures[0] if failures else "unknown fail"
                    complete_eval(eval_id, {"kind": "failed", "failureReason": failure_reason, "durationMs": eval_duration}, output_project_dir_abs)

    return scores


class TestsFailedException(Exception):
    def __init__(self, message, ratio, vitest_stdout, test_cmd):
        super().__init__(message)
        self.ratio = ratio
        self.vitest_stdout = vitest_stdout
        self.test_cmd = test_cmd


@traced
def write_filesystem(project_dir, output):
    project_dir_abs = os.path.abspath(project_dir)
    for relative_path, file_content in output.items():
        file_path = os.path.normpath(os.path.join(project_dir_abs, relative_path))
        if not file_path.startswith(project_dir_abs):
            raise Exception(f"Invalid filesystem output: {file_path} is not in {project_dir_abs}")

        os.makedirs(os.path.dirname(file_path), exist_ok=True)
        with open(file_path, "w") as f:
            f.write(file_content)


# Timeout for bun install (in seconds)
BUN_INSTALL_TIMEOUT_SECONDS = 60


@traced
def install_dependencies(project_dir):
    cmd = ["bun", "install"]
    try:
        done = subprocess.run(
            cmd,
            cwd=project_dir,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            encoding="utf-8",
            timeout=BUN_INSTALL_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired:
        raise Exception(f"bun install timed out after {BUN_INSTALL_TIMEOUT_SECONDS} seconds")
    if done.returncode != 0:
        raise Exception(f"Failed to install dependencies:\n{done.stdout}")
    # Return a list of (safe_cmd, stdout)
    return [(cmd, done.stdout)]


# Timeout for convex codegen (in seconds)
CODEGEN_TIMEOUT_SECONDS = 60


@traced
def generate_code(project_dir):
    cmd = ["bunx", "convex", "codegen", "--typecheck", "disable", "--init"]
    try:
        done = subprocess.run(
            cmd,
            cwd=project_dir,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            encoding="utf-8",
            timeout=CODEGEN_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired:
        raise Exception(f"convex codegen timed out after {CODEGEN_TIMEOUT_SECONDS} seconds")
    if done.returncode != 0:
        raise Exception(f"Failed to generate code:\n{done.stdout}")
    return [(cmd, done.stdout)]


# Timeout for tsc (in seconds)
TSC_TIMEOUT_SECONDS = 60


@traced
def typecheck_code(project_dir):
    results = []
    convex_dir = os.path.abspath(os.path.join(project_dir, "convex"))
    tsc_convex_cmd = ["bunx", "tsc", "-noEmit", "-p", convex_dir]
    try:
        done = subprocess.run(
            tsc_convex_cmd,
            cwd=project_dir,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            encoding="utf-8",
            timeout=TSC_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired:
        raise Exception(f"tsc timed out after {TSC_TIMEOUT_SECONDS} seconds")
    if done.returncode != 0:
        raise Exception(f"Failed to typecheck code:\n{done.stdout}")
    results.append((tsc_convex_cmd, done.stdout))

    src_dir = os.path.abspath(os.path.join(project_dir, "src"))
    if os.path.exists(src_dir):
        tsc_src_cmd = ["bunx", "tsc", "-noEmit", "-p", "."]
        try:
            done = subprocess.run(
                tsc_src_cmd,
                cwd=project_dir,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                encoding="utf-8",
                timeout=TSC_TIMEOUT_SECONDS,
            )
        except subprocess.TimeoutExpired:
            raise Exception(f"tsc timed out after {TSC_TIMEOUT_SECONDS} seconds")
        if done.returncode != 0:
            raise Exception(f"Failed to typecheck code:\n{done.stdout}")
        results.append((tsc_src_cmd, done.stdout))
    return results


# Timeout for eslint (in seconds)
ESLINT_TIMEOUT_SECONDS = 60


@traced
def lint_code(project_dir):
    results = []
    eslint_config = os.path.abspath("eslint.config.mjs")
    eslint_convex_cmd = ["bunx", "eslint", "-c", eslint_config, "convex"]
    try:
        done = subprocess.run(
            eslint_convex_cmd,
            cwd=project_dir,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            encoding="utf-8",
            timeout=ESLINT_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired:
        raise Exception(f"eslint timed out after {ESLINT_TIMEOUT_SECONDS} seconds")
    if done.returncode != 0:
        raise Exception(f"Failed to lint code:\n{done.stdout}")
    results.append((eslint_convex_cmd, done.stdout))

    src_eslint_config = os.path.abspath("src.eslint.config.mjs")
    src_dir = os.path.join(project_dir, "src")
    if os.path.exists(src_dir):
        eslint_src_cmd = ["bunx", "eslint", "-c", src_eslint_config, "src"]
        try:
            done = subprocess.run(
                eslint_src_cmd,
                cwd=project_dir,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                encoding="utf-8",
                timeout=ESLINT_TIMEOUT_SECONDS,
            )
        except subprocess.TimeoutExpired:
            raise Exception(f"eslint timed out after {ESLINT_TIMEOUT_SECONDS} seconds")
        if done.returncode != 0:
            raise Exception(f"Failed to lint code:\n{done.stdout}")
        results.append((eslint_src_cmd, done.stdout))
    return results


# Timeout for convex dev --once (in seconds)
DEPLOY_TIMEOUT_SECONDS = 90


@traced
def deploy(backend, project_dir):
    results = []
    convex_url = f"http://localhost:{backend['port']}"    
      
    # Run codegen --init to create convex/tsconfig.json and other boilerplate files
    init_cmd = ["bunx", "convex", "codegen", "--typecheck", "disable", "--init"]
    try:
        init_done = subprocess.run(
            init_cmd,
            cwd=project_dir,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            encoding="utf-8",
            timeout=CODEGEN_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired:
        raise Exception(f"convex codegen timed out after {CODEGEN_TIMEOUT_SECONDS} seconds")
    results.append((init_cmd, init_done.stdout))
    
    # Run convex dev --once to generate code and push functions
    exec_cmd = [
        "bunx",
        "convex",
        "dev",
        "--once",
        "--admin-key",
        admin_key,
        "--url",
        convex_url,
    ]
    try:
        done = subprocess.run(
            exec_cmd,
            cwd=project_dir,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            encoding="utf-8",
            timeout=DEPLOY_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired:
        raise Exception(f"convex dev timed out after {DEPLOY_TIMEOUT_SECONDS} seconds")
    
    # Check for success: either zero exit code OR output contains success message.
    # On Windows, bun can crash with a libuv assertion failure after successful deploy,
    # causing non-zero exit even though "Convex functions ready!" appeared.
    deploy_succeeded = (
        done.returncode == 0
        or "Convex functions ready!" in done.stdout
    )
    if not deploy_succeeded:
        raise Exception(f"Failed to deploy:\n{done.stdout}")
    
    safe_cmd = [
        "bunx",
        "convex",
        "dev",
        "--once",
        "--url",
        convex_url,
    ]
    results.append((safe_cmd, done.stdout))
    return results


@traced
def setup_answer_backend(tempdir, eval_path, model, category, name):
    answer_project_dir = f"{tempdir}/answer/{model}/{category}/{name}"
    os.makedirs(answer_project_dir, exist_ok=True)

    answer_dir = f"{eval_path}/answer"

    for source_path in walk_answer(answer_dir):
        relative_path = os.path.relpath(source_path, answer_dir)
        destination_path = os.path.join(answer_project_dir, relative_path)
        os.makedirs(os.path.dirname(destination_path), exist_ok=True)
        shutil.copy(source_path, destination_path)

    answer_backend_dir = f"{tempdir}/backends/answer/{model}/{category}/{name}"
    os.makedirs(answer_backend_dir, exist_ok=True)

    return answer_project_dir, answer_backend_dir


# Timeout for vitest test execution (in seconds)
VITEST_TIMEOUT_SECONDS = 120


@traced
def run_tests(backend, answer_backend, test_file):
    env = dict(
        os.environ,
        CONVEX_PORT=str(backend["port"]),
    )
    if answer_backend is not None:
        env["CONVEX_ANSWER_PORT"] = str(answer_backend["port"])
    
    # Write JSON reporter output to a temp file so stdout can include human output + console logs
    tmp_json = tempfile.NamedTemporaryFile(delete=False, suffix=".json")
    tmp_json_path = tmp_json.name
    tmp_json.close()
    
    # Vitest supports multiple reporters; keep JSON (to parse) and default (to include logs on stdout)
    cmd = [
        "bunx",
        "vitest",
        "run",
        test_file,
        "--reporter=json",
        "--outputFile",
        tmp_json_path,
        "--reporter=default",
        "--no-color",
    ]
    try:
        done = subprocess.run(
            cmd,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            encoding="utf-8",
            timeout=VITEST_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired:
        raise Exception(f"Tests timed out after {VITEST_TIMEOUT_SECONDS} seconds")

    # Parse the JSON file for test counts
    try:
        with open(tmp_json_path, "r", encoding="utf-8") as f:
            results = json.load(f)
        
        total = results["numTotalTests"]
        passed = results["numPassedTests"]
        ratio = (passed / total) if total > 0 else 0
    except Exception as e:
        if done.returncode != 0:
            raise Exception(f"Tests failed:\n{done.stdout}")
        else:
            raise Exception(f"Failed to parse test results from {tmp_json_path}: {e}")
    finally:
        # Clean up the temp file
        try:
            os.unlink(tmp_json_path)
        except Exception:
            pass

    if ratio != 1:
        raise TestsFailedException(f"Tests failed (passed {passed}/{total})", ratio, done.stdout, cmd)
    return ratio, done.stdout, cmd


def walk_answer(answer_dir):
    for dirpath, _, filenames in os.walk(answer_dir):
        if "node_modules" in dirpath or "_generated" in dirpath:
            continue
        for filename in filenames:
            if filename == "package.json" or filename.endswith(".ts"):
                yield os.path.join(dirpath, filename)
