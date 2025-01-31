import os
from pydantic import BaseModel
from enum import Enum

class ModelProvider(Enum):
    ANTHROPIC = "anthropic"
    OPENAI = "openai"
    TOGETHER = "together"

class ModelTemplate(BaseModel):
    name: str
    max_concurrency: int
    requires_chain_of_thought: bool
    uses_system_prompt: bool
    provider: ModelProvider

ALL_MODELS = [
    ModelTemplate(
        name="claude-3-5-sonnet-latest",
        max_concurrency=int(os.getenv("ANTHROPIC_CONCURRENCY", "2")),
        requires_chain_of_thought=True,
        uses_system_prompt=True,
        provider=ModelProvider.ANTHROPIC,
    ),
    ModelTemplate(
        name="gpt-4o",
        max_concurrency=int(os.getenv("OPENAI_CONCURRENCY", "4")),
        requires_chain_of_thought=True,
        uses_system_prompt=True,
        provider=ModelProvider.OPENAI,
    ),
    ModelTemplate(
        name="o1",
        max_concurrency=int(os.getenv("OPENAI_CONCURRENCY", "4")),
        requires_chain_of_thought=False,
        uses_system_prompt=False,
        provider=ModelProvider.OPENAI,
    ),
    ModelTemplate(
        name="o1-mini",
        max_concurrency=int(os.getenv("OPENAI_CONCURRENCY", "4")),
        requires_chain_of_thought=False,
        uses_system_prompt=False,
        provider=ModelProvider.OPENAI,
    ),
    ModelTemplate(
        name="deepseek-ai/DeepSeek-V3",
        max_concurrency=int(os.getenv("TOGETHER_CONCURRENCY", "4")),
        requires_chain_of_thought=True,
        uses_system_prompt=True,
        provider=ModelProvider.TOGETHER,
    ),
    ModelTemplate(
        name="deepseek-ai/DeepSeek-R1",
        max_concurrency=int(os.getenv("TOGETHER_CONCURRENCY", "4")),
        requires_chain_of_thought=False,
        uses_system_prompt=False,
        provider=ModelProvider.TOGETHER,
    ),
]
MODELS_BY_NAME = {model.name: model for model in ALL_MODELS}

class ConvexCodegenModel:
    def generate(self, user_prompt: str) -> dict[str, str]:
        raise NotImplementedError()


SYSTEM_PROMPT = "You are convexbot, a highly advanced AI programmer specialized in creating backend systems using Convex."
