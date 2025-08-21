import os
import shutil
import subprocess
import json
import re
from braintrust import traced, Score
from runner.convex_backend import convex_backend, admin_key


def convex_scorer(model, tempdir, *, input, expected, metadata, output):
    model = metadata["model"]
    category = metadata["category"]
    name = metadata["name"]

    output_project_dir = f"{tempdir}/output/{model}/{category}/{name}"
    os.makedirs(output_project_dir, exist_ok=True)
    output_project_dir_abs = os.path.abspath(output_project_dir)

    scores = []

    print(f"[eval] Writing generated filesystem to {output_project_dir_abs}", flush=True)
    try:
        write_filesystem(output_project_dir_abs, output)
        scores.append(Score("Valid filesystem output", 1))
    except Exception:
        scores.append(Score("Valid filesystem output", 0))
        return scores

    print(f"[eval] Installing dependencies (bun install)", flush=True)
    try:
        install_dependencies(output_project_dir_abs)
        scores.append(Score("`bun install` succeeds", 1))
    except Exception:
        scores.append(Score("`bun install` succeeds", 0))

    print(f"[eval] Running convex codegen", flush=True)
    try:
        generate_code(output_project_dir_abs)
        scores.append(Score("`convex codegen` succeeds", 1))
    except Exception:
        scores.append(Score("`convex codegen` succeeds", 0))

    print(f"[eval] Typechecking (tsc)", flush=True)
    try:
        typecheck_code(output_project_dir_abs)
        scores.append(Score("Passes tsc", 1))
    except Exception:
        scores.append(Score("Passes tsc", 0))

    print(f"[eval] Linting (eslint)", flush=True)
    try:
        lint_code(output_project_dir_abs)
        scores.append(Score("Passes eslint", 1))
    except Exception:
        scores.append(Score("Passes eslint", 0))

    output_backend_dir = f"{tempdir}/backends/output/{model}/{category}/{name}"
    os.makedirs(output_backend_dir, exist_ok=True)

    with convex_backend(output_backend_dir) as output_backend:
        print(f"[eval] Deploying generated backend on port {output_backend['port']}", flush=True)
        try:
            deploy(output_backend, output_project_dir_abs)
            scores.append(Score("`convex dev` succeeds", 1))
        except Exception:
            scores.append(Score("`convex dev` succeeds", 0))

        eval_path = f"evals/{category}/{name}"
        answer_project_dir, answer_backend_dir = setup_answer_backend(
            tempdir, eval_path, model, category, name
        )
        print(f"[eval] Installing answer dependencies", flush=True)
        install_dependencies(answer_project_dir)
        print(f"[eval] Generating answer code", flush=True)
        generate_code(answer_project_dir)

        with convex_backend(answer_backend_dir) as answer_backend:
            print(f"[eval] Deploying answer backend on port {answer_backend['port']}", flush=True)
            deploy(answer_backend, answer_project_dir)
            test_file = os.path.abspath(os.path.join(eval_path, "grader.test.ts"))
            tests_ratio = 0.0
            try:
                print(f"[eval] Running tests: {test_file}", flush=True)
                pass_rate = run_tests(output_backend, answer_backend, test_file)
                scores.append(Score("Tests pass", pass_rate))
                tests_ratio = pass_rate
            except Exception as e:
                if isinstance(e, TestsFailedException):
                    scores.append(Score("Tests pass", e.ratio))
                    tests_ratio = e.ratio
                else:
                    scores.append(Score("Tests pass", 0))
                    tests_ratio = 0.0

            status = "✅" if tests_ratio == 1 else "❌"
            print(
                f"[eval] Result {status} {category}/{name} – Tests pass: {tests_ratio:.0%} – dir: {output_project_dir_abs}",
                flush=True,
            )

    return scores


class TestsFailedException(Exception):
    def __init__(self, message, ratio):
        super().__init__(message)
        self.ratio = ratio


@traced
def write_filesystem(project_dir, output):
    print(f"[eval] write_filesystem -> {project_dir}", flush=True)
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
    print(f"[eval] install_dependencies -> {project_dir}", flush=True)
    done = subprocess.run(
        ["bun", "install"],
        cwd=project_dir,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        encoding="utf-8",
    )
    if done.returncode != 0:
        raise Exception(f"Failed to install dependencies:\n{done.stdout}")


@traced
def generate_code(project_dir):
    print(f"[eval] generate_code -> {project_dir}", flush=True)
    done = subprocess.run(
        ["bunx", "convex", "codegen", "--typecheck", "disable", "--init"],
        cwd=project_dir,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        encoding="utf-8",
    )
    if done.returncode != 0:
        raise Exception(f"Failed to generate code:\n{done.stdout}")


@traced
def typecheck_code(project_dir):
    print(f"[eval] typecheck_code -> {project_dir}", flush=True)
    convex_dir = os.path.abspath(os.path.join(project_dir, "convex"))
    done = subprocess.run(
        ["bunx", "tsc", "-noEmit", "-p", convex_dir],
        cwd=project_dir,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        encoding="utf-8",
    )
    if done.returncode != 0:
        raise Exception(f"Failed to typecheck code:\n{done.stdout}")

    src_dir = os.path.abspath(os.path.join(project_dir, "src"))
    if os.path.exists(src_dir):
        done = subprocess.run(
            ["bunx", "tsc", "-noEmit", "-p", "."],
            cwd=project_dir,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            encoding="utf-8",
        )
        if done.returncode != 0:
            raise Exception(f"Failed to typecheck code:\n{done.stdout}")


@traced
def lint_code(project_dir):
    print(f"[eval] lint_code -> {project_dir}", flush=True)
    eslint_config = os.path.abspath("eslint.config.mjs")
    done = subprocess.run(
        ["bunx", "eslint", "-c", eslint_config, "convex"],
        cwd=project_dir,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        encoding="utf-8",
    )
    if done.returncode != 0:
        raise Exception(f"Failed to lint code:\n{done.stdout}")

    src_eslint_config = os.path.abspath("src.eslint.config.mjs")
    src_dir = os.path.join(project_dir, "src")
    if os.path.exists(src_dir):
        done = subprocess.run(
            ["bunx", "eslint", "-c", src_eslint_config, "src"],
            cwd=project_dir,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            encoding="utf-8",
        )
        if done.returncode != 0:
            raise Exception(f"Failed to lint code:\n{done.stdout}")


@traced
def deploy(backend, project_dir):
    print(f"[eval] deploy -> {project_dir} (port {backend['port']})", flush=True)
    done = subprocess.run(
        [
            "bunx",
            "convex",
            "dev",
            "--once",
            "--admin-key",
            admin_key,
            "--url",
            f"http://localhost:{backend['port']}",
        ],
        cwd=project_dir,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        encoding="utf-8",
    )
    if done.returncode != 0:
        raise Exception(f"Failed to deploy:\n{done.stdout}")


@traced
def setup_answer_backend(tempdir, eval_path, model, category, name):
    print(f"[eval] setup_answer_backend -> {eval_path}", flush=True)
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
    print(f"[eval] run_tests -> {test_file}", flush=True)
    env = dict(
        os.environ,
        CONVEX_PORT=str(backend["port"]),
    )
    if answer_backend is not None:
        env["CONVEX_ANSWER_PORT"] = str(answer_backend["port"])
    done = subprocess.run(
        [
            "bunx",
            "vitest",
            "run",
            test_file,
            "--reporter=json",
            "--no-color",
        ],
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
    return ratio


def walk_answer(answer_dir):
    for dirpath, _, filenames in os.walk(answer_dir):
        if "node_modules" in dirpath or "_generated" in dirpath:
            continue
        for filename in filenames:
            if filename == "package.json" or filename.endswith(".ts"):
                yield os.path.join(dirpath, filename)
