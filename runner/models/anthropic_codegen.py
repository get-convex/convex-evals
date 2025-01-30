import os
from bs4 import BeautifulSoup
from typing import Union
from . import ConvexCodegenModel, SYSTEM_PROMPT
from .guidelines import Guideline, GuidelineSection, CONVEX_GUIDELINES
from braintrust import wrap_openai
from openai import OpenAI


class AnthropicModel(ConvexCodegenModel):
    def __init__(self, api_key: str, model: str):
        assert model in ["claude-3-5-sonnet-latest"]
        # Use OpenAI's client + Braintrust's caching proxy.
        self.client = wrap_openai(
            OpenAI(
                base_url="https://api.braintrust.dev/v1/proxy",
                api_key=api_key,
            )
        )
        self.model = model

    def generate(self, prompt: str):
        response = self.client.chat.completions.create(
            model=self.model,
            messages=[
                {
                    "role": "system",
                    "content": SYSTEM_PROMPT,
                },
                {
                    "role": "user",
                    "content": [{"type": "text", "text": "".join(render_prompt(prompt))}],
                },
                {"role": "assistant", "content": [{"type": "text", "text": "<analysis>"}]},
            ],
            max_tokens=8192,
            seed=1,
        )
        text = response.choices[0].message.content
        soup = BeautifulSoup("<analysis>" + text, "html.parser")
        out = {}

        for file_tag in soup.find_all("file"):
            path = file_tag.attrs["path"]
            if not path:
                raise ValueError("File path is not set")

            out[path.strip()] = file_tag.text.strip()

        return out


def render_prompt(task_description: str):
    yield "Your task is to generate a Convex backend from a task description.\n"
    yield """Before writing any code, analyze the task and think through your approach. Use <analysis> tags to show your thought process, covering the following areas:

1. Summarize the task requirements
2. List out the main components needed for the backend
3. Design the public API and internal functions:
   - List each function with its file path, argument validators, and return validator, and purpose.
4. Plan the schema design (if needed):
   - List each table with its validator (excluding the included _id and _creationTime fields) and its indexes
5. Outline background processing requirements (if any):

After your analysis, generate the necessary files for a Convex backend that implements the requested functionality.
"""
    yield "\n"
    yield "Here are some examples:\n"
    yield from render_examples()
    yield "\n"
    yield "Here are some guidelines for authoring a Convex backend:\n"
    yield from render_guidelines()
    yield "\n"
    yield "Begin your response with your thought process, then proceed to generate the necessary files for the Convex backend.\n\n"
    yield "Now, implement a Convex backend that satisfies the following task description:\n"
    yield "<task_description>\n"
    yield task_description
    yield "</task_description>\n\n"


def render_examples():
    yield "<examples>\n"
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
                if file_name == "package.json" or file_name.endswith(".ts"):
                    file_paths.append(os.path.join(dirpath, file_name))

        file_paths.sort(key=lambda x: (x.count("/"), x))

        yield f'<example name="{example}">\n'
        yield "  <task>\n"
        yield f"    {task_description}\n"
        yield "  </task>\n"
        yield "  <response>\n"
        yield "    <analysis>\n"
        yield f"      {analysis}\n"
        yield "    </analysis>\n"
        for file_path in file_paths:
            rel_path = os.path.relpath(file_path, example_path)
            file_content = open(file_path, "r").read().strip()
            yield f'    <file path="{rel_path}">\n'
            yield f"      {file_content}\n"
            yield "    </file>\n"
        yield "  </response>\n"
        yield "</example>\n"

    yield "</examples>\n"


def render_guidelines():
    yield """<guidelines>
  <general_coding_standards>
    - Use 2 spaces for code indentation.
    - Ensure your code is clear, efficient, concise, and innovative.
    - Maintain a friendly and approachable tone in any comments or documentation.
  </general_coding_standards>
    """
    yield from render_convex_guidelines(CONVEX_GUIDELINES)
    yield """<file_structure>
   - You can write to `package.json` and any files within the `convex/` folder.
   - Do NOT write to the `convex/_generated` folder. You can assume that `npx convex dev` will populate this folder.
   - Use <file path="file_path" /> syntax to output each file.
   - It's VERY IMPORTANT to output files to the correct paths, as specified in the task description.
   - Always start with a `package.json` file.
   - Use Convex version "^1.17.4".
  </file_structure>
    """
    yield "</guidelines>"


def render_convex_guidelines(node: Union[GuidelineSection, Guideline], indentation=""):
    if isinstance(node, Guideline):
        yield indentation + "- "
        yield node.content
        yield "\n"
    else:
        yield indentation + f"<{node.name}>\n"
        for child in node.children:
            yield from render_convex_guidelines(child, indentation + "  ")
        yield indentation + f"</{node.name}>\n"


# Used by the eval system
ANTHROPIC_CONVEX_GUIDELINES = "".join(render_convex_guidelines(CONVEX_GUIDELINES))

def build_release_rules() -> str:
    return (
        "".join(render_convex_guidelines(CONVEX_GUIDELINES)) +
        "\n\n" +
        "".join(render_examples())
    )
