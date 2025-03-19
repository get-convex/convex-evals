class Guideline:
    def __init__(self, content: str):
        self.content = content.strip()


class GuidelineSection:
    def __init__(self, name: str, children: list):
        self.name = name
        self.children = children


CONVEX_GUIDELINES = GuidelineSection(
    "convex_guidelines",
    [],
)

if __name__ == "__main__":
    import sys
    import os
    from .model_codegen import OPENAI_CONVEX_GUIDELINES, render_examples

    outdir = sys.argv[1]

    os.makedirs(outdir, exist_ok=True)

    with open(os.path.join(outdir, "guidelines.md"), "w") as f:
        f.write(OPENAI_CONVEX_GUIDELINES)

    with open(os.path.join(outdir, "examples.md"), "w") as f:
        f.write("".join(render_examples()))
