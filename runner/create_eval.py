import os
import sys
import subprocess
from runner.models.anthropic_codegen import AnthropicModel
import glob
from .convex_backend import convex_backend, admin_key

def input_continue(message="Press enter to continue..."):
    input(message)

def open_in_cursor(filepath):
    subprocess.run(["cursor", filepath], check=False)
    input_continue(f"Opened {filepath} in Cursor. Press enter when done editing...")

def get_example_tasks():
    tasks = []
    for task_file in glob.glob("evals/**/TASK.txt", recursive=True):
        with open(task_file, "r") as f:
            tasks.append(f.read().strip())
    return tasks

def get_example_evals(n=10):
    """Get the last 10 evals with their task, files and grader test"""
    evals = []
    for task_file in sorted(glob.glob("evals/**/TASK.txt", recursive=True), reverse=True):
        eval_dir = os.path.dirname(task_file)

        # Read task
        with open(task_file, "r") as f:
            task = f.read().strip()

        # Get all files in answer/convex
        files = {}
        answer_dir = os.path.join(eval_dir, "answer")
        if os.path.exists(answer_dir):
            for root, _, filenames in os.walk(answer_dir):
                for filename in filenames:
                    if filename.endswith(".ts"):
                        file_path = os.path.join(root, filename)
                        rel_path = os.path.relpath(file_path, answer_dir)
                        with open(file_path, "r") as f:
                            files[rel_path] = f.read().strip()

        # Read grader test
        grader_file = os.path.join(eval_dir, "grader.test.ts")
        if os.path.exists(grader_file):
            with open(grader_file, "r") as f:
                grader_test = f.read().strip()

            evals.append({
                "task": task,
                "files": files,
                "grader_test": grader_test
            })

            if len(evals) >= n:
                break

    return evals

def generate_task_description(one_line_desc, example_tasks):
    model = AnthropicModel("claude-3-5-sonnet-latest")
    prompt = f"""Given this one line description of a task:
{one_line_desc}

Please generate a detailed TASK.txt file describing what needs to be implemented. The task should be clear and specific about what Convex backend files and functions need to be created.

Here are some example TASK.txt files for reference:

{chr(10).join(f'Example {i+1}:{chr(10)}{task}{chr(10)}' for i, task in enumerate(example_tasks[-10:]))}

Generate a similar style TASK.txt for the given one-line description."""

    primer = 'Create a backend that'
    response = model.client.chat.completions.create(
        model="claude-3-5-sonnet-latest",
        messages=[{"role": "user", "content": prompt},
                  {"role": "assistant", "content": primer}
                  ],
        max_tokens=1000,
    )
    return primer + response.choices[0].message.content.strip()

def generate_task_test(task, files, examples):
    model = AnthropicModel("claude-3-5-sonnet-latest")
    prompt = f"""Given a task description and implementation files, generate a grader.test.ts file to test the implementation.

The test file should:
1. Import the necessary test utilities
2. Always include the schema and function spec comparison tests
3. Add specific tests to verify the implementation works as expected

Current task:
{task}

Implementation files:
{chr(10).join(f'=== {path} ==={chr(10)}{content}' for path, content in files.items())}

Here are some example tasks with their implementations and tests:

{chr(10).join(f'''
Example {i+1}:
=== TASK.txt ===
{example["task"]}

=== Implementation Files ===
{chr(10).join(f"=== {path} ==={chr(10)}{content}" for path, content in example["files"].items())}

=== grader.test.ts ===
{example["grader_test"]}
''' for i, example in enumerate(examples))}

Generate a grader.test.ts file for the current task that follows a similar style to the examples."""

    primer = 'import { expect, test } from "vitest";' + chr(10)
    response = model.client.chat.completions.create(
        model="claude-3-5-sonnet-latest",
        messages=[{"role": "user", "content": prompt},
                  {"role": "assistant", "content": primer},
                  ],
        max_tokens=2000,
    )
    return primer + response.choices[0].message.content.strip()

def main():
    # Parse args
    if len(sys.argv) < 3 or len(sys.argv) > 4:
        print("Usage: python create_eval.py <category> <name> [start_step]")
        sys.exit(1)

    category = sys.argv[1]
    name = sys.argv[2]
    start_step = int(sys.argv[3]) if len(sys.argv) > 3 else 1

    def should_run_step(step_num):
        return step_num >= start_step

    evals_dir = "evals"
    categories = os.listdir(evals_dir)

    category_by_name = {category.split("-")[1]: category for category in categories}
    next_category_number = max(int(category.split("-")[0]) for category in categories) + 1

    new_category = category not in category_by_name
    if new_category:
        print(f"Creating new category {category}")
        category_dir = os.path.join(evals_dir, f"{next_category_number:03d}-{category}")
    else:
        category_dir = os.path.join(evals_dir, category_by_name[category])

    existing = [int(existing_name.split("-")[0]) for existing_name in os.listdir(category_dir)]
    next_id = max(existing) + 1 if existing else 0

    assert "-" not in name
    testdir_name = f"{next_id:03d}-{name}"
    testdir = os.path.join(category_dir, testdir_name)
    print(f"\nStep 1: Creating eval directory for category '{category}' and name '{name}'")
    if should_run_step(1):
        os.makedirs(testdir)

    # Step 2: Get one-line task description
    print("\nStep 2: Enter a one-line description of the task")
    if should_run_step(2):
        one_line_desc = input("Description: ")
    else:
        one_line_desc = "Skipped"  # Placeholder since we need it for later steps

    # Step 3: Generate TASK.txt
    print("\nStep 3: Generating TASK.txt")
    task_file = os.path.join(testdir, "TASK.txt")
    if should_run_step(3):
        example_tasks = get_example_tasks()
        task_description = generate_task_description(one_line_desc, example_tasks)
        with open(task_file, "w") as f:
            f.write(task_description)
        open_in_cursor(task_file)

    # Step 4: Create answer directory and package.json
    print("\nStep 4: Creating answer directory and package.json")
    answer_dir = os.path.join(testdir, "answer")
    convex_dir = os.path.join(answer_dir, "convex")
    if should_run_step(4):
        os.makedirs(answer_dir)
        os.makedirs(convex_dir)

        package_json = """{
  "name": "convexbot",
  "version": "1.0.0",
  "dependencies": {
    "convex": "^1.17.4"
  }
}""".strip()

        with open(os.path.join(answer_dir, "package.json"), "w") as f:
            f.write(package_json)

        # Run bun install and codegen
        subprocess.run(["bun", "install"], cwd=answer_dir, check=True)
        subprocess.run(["bunx", "convex", "codegen"], cwd=answer_dir, check=True)

    # Step 5: Generate answer files
    print("\nStep 5: Generating answer files and editing index.ts")
    if should_run_step(5):
        model = AnthropicModel("claude-3-5-sonnet-latest")
        with open(task_file, "r") as f:
            task_content = f.read()

        generated_files = model.generate(task_content)
        for path, content in generated_files.items():
            full_path = os.path.join(answer_dir, path)
            os.makedirs(os.path.dirname(full_path), exist_ok=True)
            with open(full_path, "w") as f:
                f.write(content)
        open_in_cursor(os.path.join(convex_dir, "index.ts"))

    # Step 6: Generate and edit grader.test.ts
    print("\nStep 6: Generating grader.test.ts")
    grader_file = os.path.join(testdir, "grader.test.ts")
    if should_run_step(6):
        # Get implementation files
        files = {}
        for root, _, filenames in os.walk(os.path.join(testdir, "answer")):
            for filename in filenames:
                if filename.endswith(".ts") or filename == "package.json":
                    file_path = os.path.join(root, filename)
                    rel_path = os.path.relpath(file_path, os.path.join(testdir, "answer"))
                    with open(file_path, "r") as f:
                        files[rel_path] = f.read().strip()

        # Get task description
        with open(task_file, "r") as f:
            task_content = f.read().strip()

        # Get example evals
        examples = get_example_evals()

        # Generate test file
        grader_test = generate_task_test(task_content, files, examples)

        with open(grader_file, "w") as f:
            f.write(grader_test)

        print("\nOpening grader.test.ts for editing")
        open_in_cursor(grader_file)

    env = os.environ.copy()
    # Step 7: Run tests interactively
    print("\nStep 7: Running tests interactively")
    if should_run_step(7):
        with convex_backend(answer_dir) as backend:
            subprocess.run(
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
                cwd=answer_dir,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                encoding="utf-8",
                check=True
            )

            subprocess.run(
                [
                    "bunx",
                    "vitest",
                    "run",
                    grader_file,
                    # "--no-color",
                ],
                env=env,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                encoding="utf-8",
                check=False,
            )

    # Step 8: Run eval
    print("\nStep 8: Running eval and reporting gaps")
    if should_run_step(8):
        test_filter = f"{category}/{testdir_name}"
        env["TEST_FILTER"] = test_filter
        env["OUTPUT_TEMPDIR"] = "/tmp/convex-codegen-evals"

        subprocess.run(
            ["pdm", "run", "braintrust", "eval", "runner/eval_convex_coding.py"],
            env=env,
            check=False
        )

        gaps_file = os.path.join(testdir, "GAPS.txt")
        with open(gaps_file, "w") as f:
            f.write(f"{category}, {name}:\n")
        open_in_cursor(gaps_file)

    # Step 10: Git commit
    print("\nStep 10: Committing to git")
    if should_run_step(10):
        subprocess.run(["git", "add", testdir], check=True)
        subprocess.run(["git", "commit", "-m", f"eval: {category} {name}"], check=True)

    print("\nDone! New eval created at:", testdir)

if __name__ == "__main__":
    main()
