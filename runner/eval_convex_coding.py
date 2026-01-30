from braintrust import Eval, init_logger
from braintrust.framework import EvalResultWithSummary
from runner.models import MODELS_BY_NAME, ModelTemplate, ModelProvider
from runner.models.model_codegen import Model
from runner.scorer import convex_scorer, walk_answer
from runner.reporting import (
    convex_reporter,
    file_reporter,
    combined_reporter,
    start_run,
    start_eval,
    complete_run,
    get_or_upload_eval_source,
)
import tempfile
from dotenv import load_dotenv
from runner.logging import log_info
import os
import re
import json
import requests
import time
import atexit

PROJECT = "Convex Coding"

load_dotenv()

# Avoid initializing Braintrust logger if Braintrust is disabled
_disable_braintrust = os.getenv("DISABLE_BRAINTRUST") == "1"
logger = None
if not _disable_braintrust:
    logger = init_logger(project=PROJECT)

if os.getenv("OUTPUT_TEMPDIR") is not None:
    tempdir = os.getenv("OUTPUT_TEMPDIR")
else:
    tempdir = tempfile.mkdtemp()
log_info(f"Using tempdir: {tempdir}")

test_filter = None
if os.getenv("TEST_FILTER") is not None:
    test_filter = re.compile(os.getenv("TEST_FILTER"))


environment = os.getenv("ENVIRONMENT", "dev")
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
    
    # Filter evals
    filtered_eval_paths = [
        (category, name, eval_path)
        for category, name, eval_path in eval_paths
        if test_filter is None or test_filter.search(f"{category}/{name}")
    ]
    
    # Start run if Convex endpoint is configured
    run_id = None
    run_start_time = None
    if CONVEX_EVAL_ENDPOINT and CONVEX_AUTH_TOKEN:
        planned_evals = [f"{cat}/{n}" for cat, n, _ in filtered_eval_paths]
        provider_name = model.provider.value if hasattr(model.provider, 'value') else str(model.provider)
        experiment = os.getenv("EVALS_EXPERIMENT")
        run_id = start_run(
            model=model.name,
            planned_evals=planned_evals,
            provider=provider_name,
            experiment=experiment,
        )
        if run_id:
            run_start_time = time.time()
            log_info(f"Started run {run_id} for model {model.name} with {len(planned_evals)} evals")
            
            # Register atexit handler to complete run when script exits
            def complete_run_on_exit():
                if run_id and run_start_time:
                    run_duration = int((time.time() - run_start_time) * 1000)
                    complete_run(run_id, {"kind": "completed", "durationMs": run_duration})
                    log_info(f"Completed run {run_id}")
            
            atexit.register(complete_run_on_exit)
        else:
            log_info("Failed to start run in Convex (endpoint may not be configured)")
    
    data = []
    for category, name, eval_path in filtered_eval_paths:
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

        eval_path_str = f"{category}/{name}"
        
        # Start eval if run_id is available
        eval_id = None
        if run_id:
            # Get or upload eval source files with deduplication
            task_content, eval_source_storage_id = get_or_upload_eval_source(eval_path)
            
            eval_id = start_eval(
                run_id, 
                eval_path_str, 
                category, 
                name,
                task=task_content,
                eval_source_storage_id=eval_source_storage_id,
            )
            if eval_id:
                log_info(f"Started eval {eval_id} for {eval_path_str}")

        data.append(
            {
                "input": task_description,
                "expected": expected,
                "name": eval_path_str,
                "metadata": {
                    "name": eval_path_str,
                    "category": category,
                    "eval_name": name,
                    "model": model.name,
                    "model_name": model.formatted_name,
                    "tempdir": tempdir,
                    "eval_id": eval_id,  # Add eval_id to metadata
                    "run_id": run_id,  # Also store run_id for completion
                },
                "id": eval_path_str,
            }
        )

    disable_braintrust = os.getenv("DISABLE_BRAINTRUST") == "1"
    reporter = file_reporter if disable_braintrust else combined_reporter
    
    return Eval(
        PROJECT,
        data=data,
        task=lambda input: convex_coding_task(model, input),
        scores=[lambda *args, **kwargs: convex_scorer(model, tempdir, *args, **kwargs)],
        experiment_name=model.formatted_name,
        metadata={
            "model": model.name,
            "model_slug": model.formatted_name,
            "tempdir": tempdir,
            "environment": environment,
        },
        max_concurrency=model.max_concurrency,
        reporter=reporter,
        no_send_logs=disable_braintrust,
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
    elif model.provider == ModelProvider.MOONSHOT:
        api_key = os.getenv("MOONSHOT_API_KEY")
        if not api_key:
            raise ValueError("MOONSHOT_API_KEY is not set")
        model_impl = Model(api_key, model)
    else:
        raise ValueError(f"Unknown model provider: {model.provider}")
    return model_impl.generate(input)


# Default to running Claude, GPT-4o, GPT 4.5 preview, o3-mini, Gemini 2.0 Flash Lite, and Meta Llama 3.1 405B.
model_names = [
    "claude-3-5-sonnet-latest",
    "claude-3-7-sonnet-latest",
    "claude-sonnet-4-0",
    "claude-sonnet-4-5",
    "claude-haiku-4-5",
    "claude-opus-4-5",
    "gpt-4o",
    "o3-mini",
    "gemini-2.0-flash-lite",
    "meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo",
    "gemini-3-pro-preview",
    "grok-3-mini-beta",
]

if os.getenv("MODELS") is not None:
    model_names = [name.strip() for name in os.getenv("MODELS").split(",") if name.strip()]

for model_name in model_names:
    assert model_name in MODELS_BY_NAME, f"Model {model_name} not supported"
    model = MODELS_BY_NAME[model_name]
    convex_coding_evals(model)
