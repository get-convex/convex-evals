#!/usr/bin/env python3

import os
from runner.models.anthropic_codegen import build_release_rules as build_anthropic_rules
from runner.models.openai_codegen import build_release_rules as build_openai_rules

MDC_FRONTMATTER = """---
description: Guidelines and best practices for building Convex projects, including database schema design, queries, mutations, and real-world examples
globs: **/*.{ts,tsx,js,jsx}
---

"""

def main():    
    os.makedirs("dist", exist_ok=True)
    
    # Generate rules (we could do more model-specific ones in the future)
    # Using a very specific filename here to make it clear for AI usage what this is.

    with open("dist/anthropic_convex_rules.txt", "w") as f:
        f.write(build_anthropic_rules())
    
    with open("dist/openai_convex_rules.txt", "w") as f:
        f.write(build_openai_rules())

    # Generate MDC files with frontmatter
    with open("dist/anthropic_convex_rules.mdc", "w") as f:
        f.write(MDC_FRONTMATTER)
        f.write(build_anthropic_rules())
    
    with open("dist/openai_convex_rules.mdc", "w") as f:
        f.write(MDC_FRONTMATTER)
        f.write(build_openai_rules())

if __name__ == "__main__":
    main() 