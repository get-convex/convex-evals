from braintrust import Eval, init_logger
from braintrust.framework import EvalResultWithSummary
from runner.models import MODELS_BY_NAME, ModelTemplate, ModelProvider
from runner.models.model_codegen import Model
from runner.scorer import convex_scorer, walk_answer
from runner.reporting import (
    convex_reporter,
    file_reporter,
)
import tempfile
from dotenv import load_dotenv
import os
import re
import json
import requests

PROJECT = "Convex Coding"

load_dotenv()

# Avoid initializing Braintrust logger in local-only mode to prevent login attempts
_no_send_logs_env = os.getenv("BRAINTRUST_NO_SEND_LOGS") == "1" or os.getenv("BRAINTRUST_API_KEY") is None
logger = None
if not _no_send_logs_env:
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


CONVEX_EVAL_ENDPOINT = os.getenv("CONVEX_EVAL_ENDPOINT")
CONVEX_AUTH_TOKEN = os.getenv("CONVEX_AUTH_TOKEN")


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

    no_send_logs = os.getenv("BRAINTRUST_NO_SEND_LOGS") == "1" or os.getenv("BRAINTRUST_API_KEY") is None
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
        reporter=file_reporter,
        no_send_logs=no_send_logs,
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
