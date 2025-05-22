import os
from pydantic import BaseModel
from enum import Enum


class ModelProvider(Enum):
    ANTHROPIC = "anthropic"
    OPENAI = "openai"
    TOGETHER = "together"
    GOOGLE = "google"
    XAI = "xai"


class ModelTemplate(BaseModel):
    name: str
    formatted_name: str
    max_concurrency: int
    requires_chain_of_thought: bool
    uses_system_prompt: bool
    provider: ModelProvider
    override_proxy: str | None = None


ALL_MODELS = [
    ModelTemplate(
        name="claude-3-5-sonnet-latest",
        formatted_name="Claude 3.5 Sonnet",
        max_concurrency=int(os.getenv("ANTHROPIC_CONCURRENCY", "2")),
        requires_chain_of_thought=True,
        uses_system_prompt=True,
        provider=ModelProvider.ANTHROPIC,
    ),
    ModelTemplate(
        name="claude-3-7-sonnet-latest",
        formatted_name="Claude 3.7 Sonnet",
        max_concurrency=int(os.getenv("ANTHROPIC_CONCURRENCY", "2")),
        requires_chain_of_thought=True,
        uses_system_prompt=True,
        provider=ModelProvider.ANTHROPIC,
    ),
    ModelTemplate(
        name="claude-sonnet-4-0",
        formatted_name="Claude 4 Sonnet",
        max_concurrency=int(os.getenv("ANTHROPIC_CONCURRENCY", "2")),
        requires_chain_of_thought=True,
        uses_system_prompt=True,
        provider=ModelProvider.ANTHROPIC,
        override_proxy="https://api.anthropic.com/v1",
    ),
    ModelTemplate(
        name="gpt-4o",
        formatted_name="GPT-4o",
        max_concurrency=int(os.getenv("OPENAI_CONCURRENCY", "4")),
        requires_chain_of_thought=True,
        uses_system_prompt=True,
        provider=ModelProvider.OPENAI,
    ),
    ModelTemplate(
        name="gpt-4.5-preview",
        formatted_name="GPT 4.5 Preview",
        max_concurrency=int(os.getenv("OPENAI_CONCURRENCY", "4")),
        requires_chain_of_thought=True,
        uses_system_prompt=True,
        provider=ModelProvider.OPENAI,
    ),
    ModelTemplate(
        name="o1",
        formatted_name="o1",
        max_concurrency=int(os.getenv("OPENAI_CONCURRENCY", "4")),
        requires_chain_of_thought=False,
        uses_system_prompt=False,
        provider=ModelProvider.OPENAI,
    ),
    ModelTemplate(
        name="o1-mini",
        formatted_name="o1-mini",
        max_concurrency=int(os.getenv("OPENAI_CONCURRENCY", "4")),
        requires_chain_of_thought=False,
        uses_system_prompt=False,
        provider=ModelProvider.OPENAI,
    ),
    ModelTemplate(
        name="o3-mini",
        formatted_name="o3-mini",
        max_concurrency=int(os.getenv("OPENAI_CONCURRENCY", "4")),
        requires_chain_of_thought=False,
        uses_system_prompt=False,
        provider=ModelProvider.OPENAI,
    ),
    ModelTemplate(
        name="gpt-4.1",
        formatted_name="GPT-4.1",
        max_concurrency=int(os.getenv("OPENAI_CONCURRENCY", "4")),
        requires_chain_of_thought=True,
        uses_system_prompt=True,
        provider=ModelProvider.OPENAI,
    ),
    ModelTemplate(
        name="deepseek-ai/DeepSeek-V3",
        formatted_name="DeepSeek V3",
        max_concurrency=int(os.getenv("TOGETHER_CONCURRENCY", "4")),
        requires_chain_of_thought=True,
        uses_system_prompt=True,
        provider=ModelProvider.TOGETHER,
    ),
    ModelTemplate(
        name="deepseek-ai/DeepSeek-R1",
        formatted_name="DeepSeek R1",
        max_concurrency=int(os.getenv("TOGETHER_CONCURRENCY", "4")),
        requires_chain_of_thought=False,
        uses_system_prompt=False,
        provider=ModelProvider.TOGETHER,
    ),
    ModelTemplate(
        name="meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo",
        formatted_name="Meta Llama 3.1 405B",
        max_concurrency=int(os.getenv("TOGETHER_CONCURRENCY", "4")),
        requires_chain_of_thought=False,
        uses_system_prompt=False,
        provider=ModelProvider.TOGETHER,
    ),
    ModelTemplate(
        name="gemini-2.0-flash-lite",
        formatted_name="Gemini 2.0 Flash Lite",
        max_concurrency=int(os.getenv("GOOGLE_CONCURRENCY", "8")),
        requires_chain_of_thought=True,
        uses_system_prompt=False,
        provider=ModelProvider.GOOGLE,
    ),
    ModelTemplate(
        name="gemini-2.5-flash-preview-04-17",
        formatted_name="Gemini 2.5 Flash",
        max_concurrency=int(os.getenv("GOOGLE_CONCURRENCY", "8")),
        requires_chain_of_thought=True,
        uses_system_prompt=False,
        provider=ModelProvider.GOOGLE,
    ),
    ModelTemplate(
        name="gemini-1.5-flash",
        formatted_name="Gemini 1.5 Flash",
        max_concurrency=int(os.getenv("GOOGLE_CONCURRENCY", "8")),
        requires_chain_of_thought=False,
        uses_system_prompt=False,
        provider=ModelProvider.GOOGLE,
    ),
    ModelTemplate(
        name="gemini-2.0-pro-exp-02-05",
        formatted_name="Gemini 2.0 Pro (Experimental)",
        max_concurrency=int(os.getenv("GOOGLE_CONCURRENCY", "4")),
        requires_chain_of_thought=False,
        uses_system_prompt=False,
        provider=ModelProvider.GOOGLE,
    ),
    ModelTemplate(
        name="gemini-2.5-pro-preview-05-06",
        formatted_name="Gemini 2.5 Pro",
        max_concurrency=int(os.getenv("GOOGLE_CONCURRENCY", "4")),
        requires_chain_of_thought=False,
        uses_system_prompt=False,
        provider=ModelProvider.GOOGLE,
        override_proxy="https://generativelanguage.googleapis.com/v1beta",
    ),
    ModelTemplate(
        name="grok-3-beta",
        formatted_name="Grok 3 (Beta)",
        max_concurrency=int(os.getenv("XAI_CONCURRENCY", "4")),
        requires_chain_of_thought=False,
        uses_system_prompt=False,
        provider=ModelProvider.XAI,
        override_proxy="https://api.x.ai/v1",
    ),
    ModelTemplate(
        name="grok-3-mini-beta",
        formatted_name="Grok 3 Mini (Beta)",
        max_concurrency=int(os.getenv("XAI_CONCURRENCY", "4")),
        requires_chain_of_thought=False,
        uses_system_prompt=False,
        provider=ModelProvider.XAI,
        override_proxy="https://api.x.ai/v1",
    ),
]
MODELS_BY_NAME = {model.name: model for model in ALL_MODELS}


class ConvexCodegenModel:
    def generate(self, user_prompt: str) -> dict[str, str]:
        raise NotImplementedError()


SYSTEM_PROMPT = "You are convexbot, a highly advanced software engineer specialized in creating applications using Convex and TypeScript."
