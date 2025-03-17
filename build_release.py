#!/usr/bin/env python3

import os
from runner.models.model_codegen import build_release_rules

MDC_FRONTMATTER = """---
description: Guidelines and best practices for building Convex projects, including database schema design, queries, mutations, and real-world examples
globs: **/*.ts,**/*.tsx,**/*.js,**/*.jsx
---

"""


def main():
    os.makedirs("dist", exist_ok=True)

    with open("dist/anthropic_convex_rules.txt", "w") as f:
        f.write(build_release_rules())

    with open("dist/openai_convex_rules.txt", "w") as f:
        f.write(build_release_rules())

    # Generate MDC files with frontmatter
    with open("dist/anthropic_convex_rules.mdc", "w") as f:
        f.write(MDC_FRONTMATTER)
        f.write(build_release_rules())

    with open("dist/openai_convex_rules.mdc", "w") as f:
        f.write(MDC_FRONTMATTER)
        f.write(build_release_rules())

    # Generic rules for all models
    with open("dist/convex_rules.txt", "w") as f:
        f.write(build_release_rules())

    with open("dist/convex_rules.mdc", "w") as f:
        f.write(MDC_FRONTMATTER)
        f.write(build_release_rules())


if __name__ == "__main__":
    main()
