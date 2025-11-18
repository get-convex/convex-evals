import os
import sys
import re
import concurrent.futures
from runner.scorer import install_dependencies, generate_code, typecheck_code, lint_code, deploy, run_tests
from runner.logging import log_info
from runner.convex_backend import convex_backend



def is_tempdir(directory: str):
    return {"answer", "backends", "output"} <= set(os.listdir(directory))


def is_project_dir(directory: str):
    return {"convex", "package.json"} <= set(os.listdir(directory))


test_filter = None
if os.getenv("TEST_FILTER") is not None:
    test_filter = re.compile(str(os.getenv("TEST_FILTER")))


def run_grader(category: str, name: str, project_dir: str):
    success = False

    message = []
    message.append(f"\nGrading {category}/{name}")
    try:
        install_dependencies(project_dir)
        message.append("  - `bun install` succeeds")
    except Exception as e:
        message.append(f"  - `bun install` fails: {e}")
        print("\n".join(message))
        return False
    try:
        generate_code(project_dir)
        message.append("  - `convex codegen` succeeds")
    except Exception as e:
        message.append(f"  - `convex codegen` fails: {e}")
        print("\n".join(message))
        return False

    try:
        typecheck_code(project_dir)
        message.append("  - Passes tsc")
    except Exception as e:
        message.append(f"  - Fails tsc: {e}")
        print("\n".join(message))
        return False

    try:
        lint_code(project_dir)
        message.append("  - Passes eslint")
    except Exception as e:
        message.append(f"  - Fails eslint: {e}")
        print("\n".join(message))
        return False

    with convex_backend(project_dir) as backend:
        try:
            deploy(backend, project_dir)
            message.append("  - `convex dev` succeeds")
        except Exception as e:
            message.append(f"  - `convex dev` fails: {e}")
            print("\n".join(message))
            return False

        test_file = f"evals/{category}/{name}/grader.test.ts"
        try:
            run_tests(backend, None, test_file)
            message.append("  - Tests pass")
            success = True
        except Exception as e:
            message.append(f"  - Tests fail: {e}")

    print("\n".join(message), flush=True)
    return success


def run_graders(directory: str):
    if is_tempdir(directory):
        project_paths = [
            (category, name, f"{directory}/output/{model}/{category}/{name}")
            for model in os.listdir(f"{directory}/output")
            if os.path.isdir(f"{directory}/output/{model}")
            for category in os.listdir(f"{directory}/output/{model}")
            if os.path.isdir(f"{directory}/output/{model}/{category}")
            for name in os.listdir(f"{directory}/output/{model}/{category}")
            if os.path.isdir(f"{directory}/output/{model}/{category}/{name}")
            if test_filter is None or test_filter.search(f"{model}/{category}/{name}")
        ]
        project_paths.sort()
        log_info(f"Running grader for {len(project_paths)} projects")
    elif is_project_dir(directory):
        if os.path.basename(directory) == "answer":
            evals_dir = os.path.dirname(directory)
            name = os.path.basename(evals_dir)
            category = os.path.basename(os.path.dirname(evals_dir))
        else:
            category = os.path.basename(os.path.dirname(directory))
            name = os.path.basename(directory)

        if not os.path.exists(f"evals/{category}/{name}"):
            raise ValueError(f"Couldn't find evals for {category}/{name}")

        project_paths = [(category, name, directory)]
    else:
        raise ValueError(f"Couldn't interpret directory: {directory}")

    success = True
    with concurrent.futures.ThreadPoolExecutor() as executor:
        futures = [
            executor.submit(run_grader, category, name, project_dir)
            for category, name, project_dir in project_paths
        ]
        for future in concurrent.futures.as_completed(futures):
            success = success and future.result()

    if not success:
        raise ValueError("Grader failed")


if __name__ == "__main__":
    run_graders(sys.argv[1])
