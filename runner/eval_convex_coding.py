from braintrust import Eval, init_logger, Reporter
from braintrust.framework import report_failures, EvalResultWithSummary
from runner.models import MODELS_BY_NAME, ModelTemplate, ModelProvider
from runner.models.model_codegen import Model
from runner.scorer import convex_scorer, walk_answer
import tempfile
from dotenv import load_dotenv
import os
import re
import json
import requests

PROJECT = "Convex Coding"

load_dotenv()

logger = init_logger(project=PROJECT)

if os.getenv("OUTPUT_TEMPDIR") is not None:
    tempdir = os.getenv("OUTPUT_TEMPDIR")
else:
    tempdir = tempfile.mkdtemp()
print(f"Using tempdir: {tempdir}")

test_filter = None
if os.getenv("TEST_FILTER") is not None:
    test_filter = re.compile(os.getenv("TEST_FILTER"))


environment = os.getenv("ENVIRONMENT", "dev")
CONVEX_EVAL_ENDPOINT = os.getenv("CONVEX_EVAL_ENDPOINT")
CONVEX_AUTH_TOKEN = os.getenv("CONVEX_AUTH_TOKEN")


def report_eval(evaluator, result: EvalResultWithSummary, verbose, jsonl):
    results = result.results
    summary = result.summary

    failing_results = [x for x in results if x.error]
    if len(failing_results) > 0:
        report_failures(evaluator, failing_results, verbose=verbose, jsonl=jsonl)
    else:
        num_tests = {}
        scores = {}
        total_score = 0
        total_num_tests = 0
        for eval in results:
            if eval.metadata["category"] not in num_tests:
                num_tests[eval.metadata["category"]] = 0
                scores[eval.metadata["category"]] = 0
            num_tests[eval.metadata["category"]] += 1
            scores[eval.metadata["category"]] += eval.scores["Tests pass"]
            total_num_tests += 1
            total_score += eval.scores["Tests pass"]

        # Post the scores to the Convex endpoint
        if eval.metadata.get("model"):
            try:
                model_name = eval.metadata["model_name"]
                # Calculate the average score for each category
                category_scores = {
                    category: scores[category] / num_tests[category] for category in num_tests
                }
                combined_score = total_score / total_num_tests
                post_scores_to_convex(model_name, category_scores, combined_score)
            except Exception as e:
                print(f"Error posting scores to Convex: {e}")

        for category in num_tests:
            print(
                f"{category}: {scores[category] / num_tests[category]} ({num_tests[category]} tests)"
            )
        print(json.dumps(summary.as_dict()) if jsonl else f"{summary}")

    return len(failing_results) == 0


def post_scores_to_convex(model_name, category_scores, total_score):
    """
    Post the evaluation scores to the Convex /updateScores endpoint.

    Args:
        model_name (str): The name of the model
        category_scores (dict): Dictionary mapping category names to scores
        total_score (float): The total score for the model
    """
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
                print(f"Successfully posted scores for model {model_name} to Convex")
            else:
                print(f"Failed to post scores: HTTP {response.status_code}")
                print(f"Response: {response.text}")
        except Exception as e:
            print(f"Error posting scores to Convex: {str(e)}")


def report_run(eval_reports, verbose, jsonl):
    return all(x for x in eval_reports)


convex_reporter = Reporter(
    name="convex reporter",
    report_eval=report_eval,
    report_run=report_run,
)


def convex_coding_evals(model: ModelTemplate):
    eval_paths = [
        (category, name, f"evals/{category}/{name}")
        for category in os.listdir("evals")
        if os.path.isdir(f"evals/{category}")
        for name in os.listdir(f"evals/{category}")
        if os.path.isdir(f"evals/{category}/{name}")
    ]
    data = []
    for category, name, eval_path in eval_paths:
        if test_filter is not None and not test_filter.search(f"{category}/{name}"):
            continue

        with open(f"{eval_path}/TASK.txt", "r") as f:
            task_description = f.read()

        answer_paths = list(walk_answer(f"{eval_path}/answer"))
        answer_paths.sort(key=lambda x: (x.count("/"), x))

        expected = {}
        for file_path in answer_paths:
            with open(file_path, "r") as f:
                base_path = f"{eval_path}/answer"
                relative_path = os.path.relpath(file_path, base_path)
                file_content = f.read().strip()
                expected[relative_path] = file_content

        data.append(
            {
                "input": task_description,
                "expected": expected,
                "metadata": {
                    "category": category,
                    "name": name,
                    "model": model.name,
                    "model_name": model.formatted_name,
                },
            }
        )

    return Eval(
        PROJECT,
        data=data,
        task=lambda input: convex_coding_task(model, input),
        scores=[lambda *args, **kwargs: convex_scorer(model, tempdir, *args, **kwargs)],
        metadata={
            "model": model.name,
            "model_slug": model.formatted_name,
            "tempdir": tempdir,
            "environment": environment,
        },
        max_concurrency=model.max_concurrency,
    )


def convex_coding_task(model: ModelTemplate, input: str):
    if model.provider == ModelProvider.ANTHROPIC:
        api_key = os.getenv("ANTHROPIC_API_KEY")
        if not api_key:
            raise ValueError("ANTHROPIC_API_KEY is not set")
        model_impl = Model(api_key, model)
    elif model.provider == ModelProvider.OPENAI:
        api_key = os.getenv("OPENAI_API_KEY")
        if not api_key:
            raise ValueError("OPENAI_API_KEY is not set")
        model_impl = Model(api_key, model)
    elif model.provider == ModelProvider.TOGETHER:
        api_key = os.getenv("TOGETHER_API_KEY")
        if not api_key:
            raise ValueError("TOGETHER_API_KEY is not set")
        model_impl = Model(api_key, model)
    elif model.provider == ModelProvider.GOOGLE:
        api_key = os.getenv("GOOGLE_API_KEY")
        if not api_key:
            raise ValueError("GOOGLE_API_KEY is not set")
        model_impl = Model(api_key, model)
    elif model.provider == ModelProvider.XAI:
        api_key = os.getenv("XAI_API_KEY")
        if not api_key:
            raise ValueError("XAI_API_KEY is not set")
        model_impl = Model(api_key, model)
    else:
        raise ValueError(f"Unknown model provider: {model.provider}")
    return model_impl.generate(input)


# Default to running Claude, GPT-4o, GPT 4.5 preview, o3-mini, Gemini 2.0 Flash Lite, and Meta Llama 3.1 405B.
model_names = [
    "claude-3-5-sonnet-latest",
    "claude-3-7-sonnet-latest",
    "claude-sonnet-4-0",
    "gpt-4o",
    "o3-mini",
    "gemini-2.0-flash-lite",
    "meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo",
    "gemini-2.5-pro-preview-06-05",
    "grok-3-mini-beta",
]

if os.getenv("MODELS") is not None:
    model_names = os.getenv("MODELS").split(",")

for model_name in model_names:
    assert model_name in MODELS_BY_NAME, f"Model {model_name} not supported"
    model = MODELS_BY_NAME[model_name]
    convex_coding_evals(model)
