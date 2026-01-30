import openai
import os
import textwrap
import time
import random
from . import ConvexCodegenModel, SYSTEM_PROMPT, ModelTemplate, ModelProvider
from markdown_it import MarkdownIt
from typing import Union
from .guidelines import Guideline, GuidelineSection, CONVEX_GUIDELINES
from braintrust import wrap_openai


# Retry configuration for flaky API providers (e.g., Together.xyz 503 errors)
MAX_RETRIES = 5
INITIAL_RETRY_DELAY_SECONDS = 2.0
MAX_RETRY_DELAY_SECONDS = 60.0
RETRY_JITTER_FACTOR = 0.25  # Add up to 25% random jitter


def should_skip_guidelines() -> bool:
    """Check if guidelines should be skipped based on EVALS_EXPERIMENT env var."""
    return os.getenv("EVALS_EXPERIMENT") == "no_guidelines"


def get_guidelines_content() -> str:
    """Get guidelines content from custom file or default."""
    custom_path = os.getenv("CUSTOM_GUIDELINES_PATH")
    if custom_path and os.path.exists(custom_path):
        with open(custom_path, "r") as f:
            return f.read()
    if should_skip_guidelines():
        return ""
    return "".join(render_guidelines(CONVEX_GUIDELINES))


class Model(ConvexCodegenModel):
    def __init__(self, api_key: str, model: ModelTemplate):
        self.model = model
        # Allow disabling Braintrust proxy entirely via env toggle
        disable_proxy = os.getenv("DISABLE_BRAINTRUST") == "1"

        url = "https://api.braintrust.dev/v1/proxy"

        if disable_proxy:
            match model.provider:
                case ModelProvider.OPENAI:
                    url = "https://api.openai.com/v1"
                case ModelProvider.ANTHROPIC:
                    url = "https://api.anthropic.com/v1"
                case ModelProvider.TOGETHER:
                    url = "https://api.together.xyz/v1"
                case ModelProvider.GOOGLE:
                    url = "https://generativelanguage.googleapis.com/v1beta"
                case ModelProvider.XAI:
                    url = "https://api.x.ai/v1"
                case ModelProvider.MOONSHOT:
                    url = "https://api.moonshot.ai/v1"
                case _:
                    raise ValueError(f"Unknown model provider for disable-proxy mode: {model.provider}")

        # Configure OpenAI client with increased retries for transient errors
        if model.override_proxy:
            url = model.override_proxy
            client = openai.OpenAI(
                base_url=url,
                api_key=api_key,
                max_retries=MAX_RETRIES,
                timeout=openai.Timeout(connect=30.0, read=300.0, write=30.0, pool=30.0),
            )
        else:
            base_client = openai.OpenAI(
                base_url=url,
                api_key=api_key,
                max_retries=MAX_RETRIES,
                timeout=openai.Timeout(connect=30.0, read=300.0, write=30.0, pool=30.0),
            )
            client = base_client if disable_proxy else wrap_openai(base_client)
        self.client = client

    def generate(self, prompt: str):
        user_prompt = "".join(render_prompt(self.model.requires_chain_of_thought, prompt))
        
        # Use Responses API for models that require it (e.g., gpt-5.2-codex)
        if self.model.uses_responses_api:
            return self._generate_with_responses_api(user_prompt)
        
        if self.model.uses_system_prompt:
            system_message = {"role": "system", "content": SYSTEM_PROMPT}
        else:
            system_message = {"role": "user", "content": SYSTEM_PROMPT}
        # Build parameters, selecting the correct token limit key for newer models
        # Together AI models (DeepSeek, Llama) have a 12289 total context limit,
        # so we use a lower max_tokens to leave room for input tokens (~7000)
        if self.model.provider == ModelProvider.TOGETHER:
            max_token_limit = 4096
        elif self.model.name == "claude-3-5-sonnet-latest":
            max_token_limit = 8192
        else:
            max_token_limit = 16384
        create_params = {
            "model": self.model.name,
            "messages": [
                system_message,
                {"role": "user", "content": user_prompt},
            ],
        }
        # Only add temperature for models that support it (reasoning models like o1/o3/gpt-5 don't)
        if self.model.supports_temperature:
            temperature = float(os.getenv("EVAL_TEMPERATURE", "0.7"))
            create_params["temperature"] = temperature
        # Some newer models (e.g., GPT-5 family, o4) expect `max_completion_tokens` instead of `max_tokens`.
        if self.model.name.startswith("gpt-5") or self.model.name.startswith("o4"):
            create_params["max_completion_tokens"] = max_token_limit
        else:
            create_params["max_tokens"] = max_token_limit

        response = self._call_with_retry(create_params)
        return self._parse_response(response.choices[0].message.content)
    
    def _generate_with_responses_api(self, user_prompt: str):
        """
        Generate using the OpenAI Responses API for models like gpt-5.2-codex.
        
        The Responses API uses a different endpoint (/v1/responses) and request format:
        - 'instructions' for system-level guidance
        - 'input' for user content (can be a string or list of messages)
        - Response text is in response.output_text
        """
        max_token_limit = 16384
        
        create_params = {
            "model": self.model.name,
            "instructions": SYSTEM_PROMPT,
            "input": user_prompt,
            "max_output_tokens": max_token_limit,
            "store": False,  # Don't persist the response
        }
        
        response = self._call_responses_api_with_retry(create_params)
        return self._parse_response(response.output_text)

    def _call_with_retry(self, create_params: dict):
        """
        Call the API with additional retry logic for transient errors.
        
        The OpenAI client has built-in retries, but for very flaky providers
        (like Together.xyz which often returns 503), we add an outer retry loop
        with exponential backoff.
        """
        last_exception = None
        delay = INITIAL_RETRY_DELAY_SECONDS

        for attempt in range(MAX_RETRIES):
            try:
                return self.client.chat.completions.create(**create_params)
            except openai.APIStatusError as e:
                # Retry on 5xx server errors and 429 rate limits
                if e.status_code in (429, 500, 502, 503, 504):
                    last_exception = e
                    # Add jitter to prevent thundering herd
                    jitter = delay * RETRY_JITTER_FACTOR * random.random()
                    sleep_time = min(delay + jitter, MAX_RETRY_DELAY_SECONDS)
                    print(f"API error {e.status_code}, retrying in {sleep_time:.1f}s (attempt {attempt + 1}/{MAX_RETRIES})")
                    time.sleep(sleep_time)
                    delay *= 2  # Exponential backoff
                else:
                    raise
            except openai.APIConnectionError as e:
                # Retry on connection errors
                last_exception = e
                jitter = delay * RETRY_JITTER_FACTOR * random.random()
                sleep_time = min(delay + jitter, MAX_RETRY_DELAY_SECONDS)
                print(f"Connection error, retrying in {sleep_time:.1f}s (attempt {attempt + 1}/{MAX_RETRIES})")
                time.sleep(sleep_time)
                delay *= 2

        # If we've exhausted all retries, raise the last exception
        raise last_exception

    def _call_responses_api_with_retry(self, create_params: dict):
        """
        Call the OpenAI Responses API with retry logic for transient errors.
        
        Similar to _call_with_retry but uses the responses.create endpoint
        instead of chat.completions.create.
        """
        last_exception = None
        delay = INITIAL_RETRY_DELAY_SECONDS

        for attempt in range(MAX_RETRIES):
            try:
                return self.client.responses.create(**create_params)
            except openai.APIStatusError as e:
                # Retry on 5xx server errors and 429 rate limits
                if e.status_code in (429, 500, 502, 503, 504):
                    last_exception = e
                    jitter = delay * RETRY_JITTER_FACTOR * random.random()
                    sleep_time = min(delay + jitter, MAX_RETRY_DELAY_SECONDS)
                    print(f"Responses API error {e.status_code}, retrying in {sleep_time:.1f}s (attempt {attempt + 1}/{MAX_RETRIES})")
                    time.sleep(sleep_time)
                    delay *= 2
                else:
                    raise
            except openai.APIConnectionError as e:
                last_exception = e
                jitter = delay * RETRY_JITTER_FACTOR * random.random()
                sleep_time = min(delay + jitter, MAX_RETRY_DELAY_SECONDS)
                print(f"Connection error, retrying in {sleep_time:.1f}s (attempt {attempt + 1}/{MAX_RETRIES})")
                time.sleep(sleep_time)
                delay *= 2

        raise last_exception

    def _parse_response(self, response: str):
        md = MarkdownIt()
        tokens = md.parse(response)

        files = {}
        current_file = None
        in_files_section = False

        for i, token in enumerate(tokens):
            if token.type == "heading_open" and token.tag == "h1":
                title_token = tokens[i + 1]
                if title_token.content == "Files":
                    in_files_section = True
                    continue

            if not in_files_section:
                continue

            if token.type == "heading_open" and token.tag == "h2":
                title_token = tokens[i + 1]
                current_file = title_token.content.strip()
            elif token.type == "fence" and current_file:
                files[current_file] = token.content.strip()
                current_file = None

        return files


def render_prompt(chain_of_thought: bool, task_description: str):
    yield "Your task is to generate a Convex backend from a task description.\n"
    if chain_of_thought:
        yield "Before writing any code, analyze the task and think through your approach. Use the Analysis section to show your thought process, covering the following areas:\n"
        yield "1. Summarize the task requirements\n"
        yield "2. List out the main components needed for the backend\n"
        yield "3. Design the public API and internal functions:\n"
        yield "   - List each function with its file path, argument validators, and return validator, and purpose.\n"
        yield "4. Plan the schema design (if needed):\n"
        yield "   - List each table with its validator (excluding the included _id and _creationTime fields) and its indexes\n"
        yield "5. Outline background processing requirements (if any):\n"
        yield "After your analysis, output all files within an h1 Files section that has an h2 section for each necessary file for a Convex backend that implements the requested functionality.\n"
        yield "For example, correct output looks like\n"
        yield "# Analysis\n"
        yield "...\n"
        yield "# Files\n"
        yield "## package.json\n"
        yield "```\n"
        yield "...\n"
        yield "```\n"
        yield "## tsconfig.json\n"
        yield "```\n"
        yield "...\n"
        yield "```\n"
        yield "## convex/schema.ts\n"
        yield "```\n"
        yield "...\n"
        yield "```\n"
    else:
        yield "Output all files within an h1 Files section that has an h2 section for each necessary file for a Convex backend that implements the requested functionality.\n"
        yield "For example, correct output looks like\n"
        yield "# Files\n"
        yield "## package.json\n"
        yield "```\n"
        yield "...\n"
        yield "```\n"
        yield "## tsconfig.json\n"
        yield "```\n"
        yield "...\n"
        yield "```\n"
        yield "## convex/schema.ts\n"
        yield "```\n"
        yield "...\n"
        yield "```\n"

    yield from render_examples()
    yield "\n"

    yield "# General Coding Standards\n"
    yield "- Use 2 spaces for code indentation.\n"
    yield "- Ensure your code is clear, efficient, concise, and innovative.\n"
    yield "- Maintain a friendly and approachable tone in any comments or documentation.\n\n"

    guidelines_content = get_guidelines_content()
    if guidelines_content:
        yield guidelines_content
        yield "\n"

    yield "\n# File Structure\n"
    yield "- You can write to `package.json`, `tsconfig.json`, and any files within the `convex/` folder.\n"
    yield "- Do NOT write to the `convex/_generated` folder. You can assume that `npx convex dev` will populate this folder.\n"
    yield "- It's VERY IMPORTANT to output files to the correct paths, as specified in the task description.\n"
    yield "- Always start with `package.json` and `tsconfig.json` files.\n"
    yield '- Use Convex version "^1.31.2".\n\n'
    yield '- Use Typescript version "^5.7.3".\n\n'

    if chain_of_thought:
        yield "Begin your response with your thought process, then proceed to generate the necessary files for the Convex backend.\n"

    yield "Now, implement a Convex backend that satisfies the following task description:\n"
    yield f"```\n{task_description}\n```\n"


def render_examples():
    yield "# Examples:\n"
    for example in os.listdir("examples/"):
        example_path = os.path.join("examples/", example)
        if not os.path.isdir(example_path):
            continue

        task_description = open(os.path.join(example_path, "TASK.txt"), "r").read()
        analysis = open(os.path.join(example_path, "ANALYSIS.txt"), "r").read()

        file_paths = []
        for dirpath, _, file_names in os.walk(example_path, topdown=True):
            if "node_modules" in dirpath or "_generated" in dirpath:
                continue
            for file_name in file_names:
                if (
                    file_name == "package.json"
                    or file_name == "tsconfig.json"
                    or file_name.endswith(".ts")
                    or file_name.endswith(".tsx")
                ):
                    file_paths.append(os.path.join(dirpath, file_name))

        file_paths.sort(key=lambda x: (x.count("/"), x))

        yield f"## Example: {example}\n\n"
        yield "### Task\n"
        yield f"```\n{task_description}\n```\n\n"
        yield "### Analysis\n"
        yield f"{analysis}\n\n"
        yield "### Implementation\n\n"
        for file_path in file_paths:
            rel_path = os.path.relpath(file_path, example_path)
            file_content = open(file_path, "r").read()
            file_content = textwrap.dedent(file_content).strip()
            yield f"#### {rel_path}\n"
            yield f"```typescript\n{file_content}\n```\n\n"


def render_guidelines(node: Union[GuidelineSection, Guideline], header="#"):
    if isinstance(node, Guideline):
        yield "- "
        yield node.content
        yield "\n"
    else:
        words = node.name.split("_")
        words[0] = words[0].capitalize()
        yield f"{header} {' '.join(words)}\n"
        for child in node.children:
            yield from render_guidelines(child, header + "#")
        yield "\n"


# Used by the eval system
OPENAI_CONVEX_GUIDELINES = "".join(render_guidelines(CONVEX_GUIDELINES))


def build_release_rules() -> str:
    return "".join(render_guidelines(CONVEX_GUIDELINES)) + "".join(render_examples())
