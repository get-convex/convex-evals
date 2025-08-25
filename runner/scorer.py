import os
import shutil
import subprocess
import json
import re
from braintrust import traced, Score
from runner.convex_backend import convex_backend, admin_key
from runner.logging import append_log, append_log_block, log_cmd_results, log_info, run_command_step


def convex_scorer(model, tempdir, *, input, expected, metadata, output):
    model = metadata["model"]
    category = metadata["category"]
    name = metadata["name"]

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

    log_info(f"[{category}/{name}] Writing generated filesystem")
    run_log_path = os.path.join(output_project_dir_abs, "run.log")
    append_log(run_log_path, f"=== Eval: {category}/{name} ===")
    try:
        write_filesystem(output_project_dir_abs, output)
        scores.append(Score("Valid filesystem output", 1))
        passed_filesystem = True
        append_log(run_log_path, "[ok] write_filesystem")
    except Exception as e:
        scores.append(Score("Valid filesystem output", 0))
        append_log(run_log_path, f"[error] write_filesystem: {e}")
        status = "❌"
        log_info(f"[eval] Result {status} {category}/{name} – filesystem fail – dir: {output_project_dir_abs}")
        return scores

    # run_command_step moved to runner.logging for reuse across modules

    log_info(f"[{category}/{name}] Installing dependencies (bun install)")
    if run_command_step(run_log_path, lambda: install_dependencies(output_project_dir_abs), "bun", "bun install"):
        scores.append(Score("`bun install` succeeds", 1))
        passed_install = True
    else:
        scores.append(Score("`bun install` succeeds", 0))

    log_info(f"[{category}/{name}] Running convex codegen")
    if run_command_step(run_log_path, lambda: generate_code(output_project_dir_abs), "codegen", "convex codegen"):
        scores.append(Score("`convex codegen` succeeds", 1))
        passed_codegen = True
    else:
        scores.append(Score("`convex codegen` succeeds", 0))

    log_info(f"[{category}/{name}] Typechecking (tsc)")
    if run_command_step(run_log_path, lambda: typecheck_code(output_project_dir_abs), "tsc", "tsc"):
        scores.append(Score("Passes tsc", 1))
        passed_tsc = True
    else:
        scores.append(Score("Passes tsc", 0))

    log_info(f"[{category}/{name}] Linting (eslint)")
    if run_command_step(run_log_path, lambda: lint_code(output_project_dir_abs), "eslint", "eslint"):
        scores.append(Score("Passes eslint", 1))
        passed_eslint = True
    else:
        scores.append(Score("Passes eslint", 0))

    output_backend_dir = f"{tempdir}/backends/output/{model}/{category}/{name}"
    os.makedirs(output_backend_dir, exist_ok=True)

    with convex_backend(output_backend_dir) as output_backend:
        log_info(f"[{category}/{name}] Deploying generated backend on port {output_backend['port']}")
        if run_command_step(run_log_path, lambda: deploy(output_backend, output_project_dir_abs), "convex-dev", "convex dev"):
            scores.append(Score("`convex dev` succeeds", 1))
            passed_deploy = True
        else:
            scores.append(Score("`convex dev` succeeds", 0))

        eval_path = f"evals/{category}/{name}"
        answer_project_dir, answer_backend_dir = setup_answer_backend(
            tempdir, eval_path, model, category, name
        )
        log_info(f"[{category}/{name}] Setting up answer backend")
        log_info(f"[{category}/{name}] Installing answer dependencies")
        run_command_step(run_log_path, lambda: install_dependencies(answer_project_dir), "answer-bun", "(answer) bun install", cmd_prefix="(answer) ")
        log_info(f"[{category}/{name}] Generating answer code")
        run_command_step(run_log_path, lambda: generate_code(answer_project_dir), "answer-codegen", "(answer) convex codegen", cmd_prefix="(answer) ")

        with convex_backend(answer_backend_dir) as answer_backend:
            log_info(f"[{category}/{name}] Deploying answer backend on port {answer_backend['port']}")
            run_command_step(run_log_path, lambda: deploy(answer_backend, answer_project_dir), "answer-convex-dev", "(answer) convex dev", cmd_prefix="(answer) ")
            test_file = os.path.abspath(os.path.join(eval_path, "grader.test.ts"))
            tests_ratio = 0.0
            try:
                log_info(f"[{category}/{name}] Running tests")
                pass_rate, vitest_stdout, test_cmd = run_tests(output_backend, answer_backend, test_file)
                scores.append(Score("Tests pass", pass_rate))
                tests_ratio = pass_rate
                log_cmd_results(run_log_path, [(test_cmd, vitest_stdout)], "vitest")
            except Exception as e:
                if isinstance(e, TestsFailedException):
                    scores.append(Score("Tests pass", e.ratio))
                    tests_ratio = e.ratio
                else:
                    scores.append(Score("Tests pass", 0))
                    tests_ratio = 0.0
                append_log(run_log_path, f"[error] vitest: {e}")

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

    return scores


class TestsFailedException(Exception):
    def __init__(self, message, ratio):
        super().__init__(message)
        self.ratio = ratio


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


@traced
def install_dependencies(project_dir):
    cmd = ["bun", "install"]
    done = subprocess.run(
        cmd,
        cwd=project_dir,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        encoding="utf-8",
    )
    if done.returncode != 0:
        raise Exception(f"Failed to install dependencies:\n{done.stdout}")
    # Return a list of (safe_cmd, stdout)
    return [(cmd, done.stdout)]


@traced
def generate_code(project_dir):
    cmd = ["bunx", "convex", "codegen", "--typecheck", "disable", "--init"]
    done = subprocess.run(
        cmd,
        cwd=project_dir,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        encoding="utf-8",
    )
    if done.returncode != 0:
        raise Exception(f"Failed to generate code:\n{done.stdout}")
    return [(cmd, done.stdout)]


@traced
def typecheck_code(project_dir):
    results = []
    convex_dir = os.path.abspath(os.path.join(project_dir, "convex"))
    tsc_convex_cmd = ["bunx", "tsc", "-noEmit", "-p", convex_dir]
    done = subprocess.run(
        tsc_convex_cmd,
        cwd=project_dir,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        encoding="utf-8",
    )
    if done.returncode != 0:
        raise Exception(f"Failed to typecheck code:\n{done.stdout}")
    results.append((tsc_convex_cmd, done.stdout))

    src_dir = os.path.abspath(os.path.join(project_dir, "src"))
    if os.path.exists(src_dir):
        tsc_src_cmd = ["bunx", "tsc", "-noEmit", "-p", "."]
        done = subprocess.run(
            tsc_src_cmd,
            cwd=project_dir,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            encoding="utf-8",
        )
        if done.returncode != 0:
            raise Exception(f"Failed to typecheck code:\n{done.stdout}")
        results.append((tsc_src_cmd, done.stdout))
    return results


@traced
def lint_code(project_dir):
    results = []
    eslint_config = os.path.abspath("eslint.config.mjs")
    eslint_convex_cmd = ["bunx", "eslint", "-c", eslint_config, "convex"]
    done = subprocess.run(
        eslint_convex_cmd,
        cwd=project_dir,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        encoding="utf-8",
    )
    if done.returncode != 0:
        raise Exception(f"Failed to lint code:\n{done.stdout}")
    results.append((eslint_convex_cmd, done.stdout))

    src_eslint_config = os.path.abspath("src.eslint.config.mjs")
    src_dir = os.path.join(project_dir, "src")
    if os.path.exists(src_dir):
        eslint_src_cmd = ["bunx", "eslint", "-c", src_eslint_config, "src"]
        done = subprocess.run(
            eslint_src_cmd,
            cwd=project_dir,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            encoding="utf-8",
        )
        if done.returncode != 0:
            raise Exception(f"Failed to lint code:\n{done.stdout}")
        results.append((eslint_src_cmd, done.stdout))
    return results


@traced
def deploy(backend, project_dir):
    # Full command with admin key for execution
    exec_cmd = [
        "bunx",
        "convex",
        "dev",
        "--once",
        "--admin-key",
        admin_key,
        "--url",
        f"http://localhost:{backend['port']}",
    ]
    done = subprocess.run(
        exec_cmd,
        cwd=project_dir,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        encoding="utf-8",
    )
    if done.returncode != 0:
        raise Exception(f"Failed to deploy:\n{done.stdout}")
    # Safe command string for logging (omit admin key)
    safe_cmd = [
        "bunx",
        "convex",
        "dev",
        "--once",
        "--url",
        f"http://localhost:{backend['port']}",
    ]
    return [(safe_cmd, done.stdout)]


@traced
def setup_answer_backend(tempdir, eval_path, model, category, name):
    answer_project_dir = f"{tempdir}/answer/{model}/{category}/{name}"
    os.makedirs(answer_project_dir, exist_ok=True)

    answer_dir = f"{eval_path}/answer"
    generate_code(answer_dir)

    for source_path in walk_answer(answer_dir):
        relative_path = os.path.relpath(source_path, answer_dir)
        destination_path = os.path.join(answer_project_dir, relative_path)
        os.makedirs(os.path.dirname(destination_path), exist_ok=True)
        shutil.copy(source_path, destination_path)

    answer_backend_dir = f"{tempdir}/backends/answer/{model}/{category}/{name}"
    os.makedirs(answer_backend_dir, exist_ok=True)

    return answer_project_dir, answer_backend_dir


@traced
def run_tests(backend, answer_backend, test_file):
    env = dict(
        os.environ,
        CONVEX_PORT=str(backend["port"]),
    )
    if answer_backend is not None:
        env["CONVEX_ANSWER_PORT"] = str(answer_backend["port"])
    cmd = [
        "bunx",
        "vitest",
        "run",
        test_file,
        "--reporter=json",
        "--no-color",
    ]
    done = subprocess.run(
        cmd,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        encoding="utf-8",
    )

    try:
        # Removes all characters before the first `{` and after the last `}`
        cleaned_stdout = re.sub(r"^.*?(\{.*\}).*$", r"\1", done.stdout, flags=re.DOTALL)
        results = json.loads(cleaned_stdout)

        total = results["numTotalTests"]
        passed = results["numPassedTests"]
        ratio = (passed / total) if total > 0 else 0
    except Exception as e:
        if done.returncode != 0:
            raise Exception(f"Failed to run tests:\n{done.stdout}")
        else:
            raise Exception(f"Failed to parse tests results: {e}")

    if ratio != 1:
        error_message = ""
        for test in results["testResults"][0]["assertionResults"]:
            if test["status"] == "failed":
                error_message += f"{test['title']}: {test['failureMessages']}\n"
        raise TestsFailedException(f"Tests failed:\n{error_message}", ratio)
    return ratio, done.stdout, cmd


def walk_answer(answer_dir):
    for dirpath, _, filenames in os.walk(answer_dir):
        if "node_modules" in dirpath or "_generated" in dirpath:
            continue
        for filename in filenames:
            if filename == "package.json" or filename.endswith(".ts"):
                yield os.path.join(dirpath, filename)
