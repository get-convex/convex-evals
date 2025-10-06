import openai
import os
import textwrap
from . import ConvexCodegenModel, SYSTEM_PROMPT, ModelTemplate, ModelProvider
from markdown_it import MarkdownIt
from typing import Union
from .guidelines import Guideline, GuidelineSection, CONVEX_GUIDELINES
from braintrust import wrap_openai


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
                case _:
                    raise ValueError(f"Unknown model provider for disable-proxy mode: {model.provider}")

        if model.override_proxy:
            url = model.override_proxy
            client = openai.OpenAI(base_url=url, api_key=api_key)
        else:
            base_client = openai.OpenAI(base_url=url, api_key=api_key)
            client = base_client if disable_proxy else wrap_openai(base_client)
        self.client = client

    def generate(self, prompt: str):
        user_prompt = "".join(render_prompt(self.model.requires_chain_of_thought, prompt))
        if self.model.uses_system_prompt:
            system_message = {"role": "system", "content": SYSTEM_PROMPT}
        else:
            system_message = {"role": "user", "content": SYSTEM_PROMPT}
        # Build parameters, selecting the correct token limit key for newer models
        max_token_limit = 8192 if self.model.name == "claude-3-5-sonnet-latest" else 16384
        create_params = {
            "model": self.model.name,
            "messages": [
                system_message,
                {"role": "user", "content": user_prompt},
            ],
        }
        # Some newer models (e.g., GPT-5 family) expect `max_completion_tokens` instead of `max_tokens`.
        if self.model.name.startswith("gpt-5"):
            create_params["max_completion_tokens"] = max_token_limit
        else:
            create_params["max_tokens"] = max_token_limit

        response = self.client.chat.completions.create(**create_params)
        return self._parse_response(response.choices[0].message.content)

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

    yield from render_guidelines(CONVEX_GUIDELINES)
    yield "\n"

    yield "\n# File Structure\n"
    yield "- You can write to `package.json`, `tsconfig.json`, and any files within the `convex/` folder.\n"
    yield "- Do NOT write to the `convex/_generated` folder. You can assume that `npx convex dev` will populate this folder.\n"
    yield "- It's VERY IMPORTANT to output files to the correct paths, as specified in the task description.\n"
    yield "- Always start with `package.json` and `tsconfig.json` files.\n"
    yield '- Use Convex version "^1.17.4".\n\n'
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
