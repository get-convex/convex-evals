#!/usr/bin/env python3

import os
from runner.models.model_codegen import build_release_rules

MDC_FRONTMATTER = """---
description: Guidelines and best practices for building Convex projects, including database schema design, queries, mutations, and real-world examples
globs: **/*.{ts,tsx,js,jsx}
---

"""


def main():
    os.makedirs("dist", exist_ok=True)

    # Generate rules using a very specific filename here to make it clear for AI usage what this is.
    with open("dist/convex_rules.txt", "w") as f:
        f.write(build_release_rules())

    with open("dist/convex_rules.mdc", "w") as f:
        f.write(MDC_FRONTMATTER)
        f.write(build_release_rules())


if __name__ == "__main__":
    main()
