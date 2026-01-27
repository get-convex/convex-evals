import os
from pydantic import BaseModel
from enum import Enum
from typing import Literal


class ModelProvider(Enum):
    ANTHROPIC = "anthropic"
    OPENAI = "openai"
    TOGETHER = "together"
    GOOGLE = "google"
    XAI = "xai"


CIRunFrequency = Literal["daily", "weekly", "monthly", "never"]


class ModelTemplate(BaseModel):
    name: str
    formatted_name: str
    max_concurrency: int
    requires_chain_of_thought: bool
    uses_system_prompt: bool
    provider: ModelProvider
    override_proxy: str | None = None
    supports_temperature: bool = True  # Some reasoning models (o1, o3, gpt-5) don't support temperature
    ci_run_frequency: CIRunFrequency = "weekly"


ALL_MODELS = [
    # Anthropic models
    ModelTemplate(
        name="claude-3-5-sonnet-latest",
        formatted_name="Claude 3.5 Sonnet",
        max_concurrency=int(os.getenv("ANTHROPIC_CONCURRENCY", "2")),
        requires_chain_of_thought=True,
        uses_system_prompt=True,
        provider=ModelProvider.ANTHROPIC,
        ci_run_frequency="monthly",
    ),
    ModelTemplate(
        name="claude-3-7-sonnet-latest",
        formatted_name="Claude 3.7 Sonnet",
        max_concurrency=int(os.getenv("ANTHROPIC_CONCURRENCY", "2")),
        requires_chain_of_thought=True,
        uses_system_prompt=True,
        provider=ModelProvider.ANTHROPIC,
        ci_run_frequency="monthly",
    ),
    ModelTemplate(
        name="claude-sonnet-4-0",
        formatted_name="Claude 4 Sonnet",
        max_concurrency=int(os.getenv("ANTHROPIC_CONCURRENCY", "2")),
        requires_chain_of_thought=True,
        uses_system_prompt=True,
        provider=ModelProvider.ANTHROPIC,
        override_proxy="https://api.anthropic.com/v1",
        ci_run_frequency="weekly",
    ),
    ModelTemplate(
        name="claude-sonnet-4-5",
        formatted_name="Claude 4.5 Sonnet",
        max_concurrency=int(os.getenv("ANTHROPIC_CONCURRENCY", "2")),
        requires_chain_of_thought=True,
        uses_system_prompt=True,
        provider=ModelProvider.ANTHROPIC,
        override_proxy="https://api.anthropic.com/v1",
        ci_run_frequency="daily",
    ),
    ModelTemplate(
        name="claude-haiku-4-5",
        formatted_name="Claude 4.5 Haiku",
        max_concurrency=int(os.getenv("ANTHROPIC_CONCURRENCY", "2")),
        requires_chain_of_thought=True,
        uses_system_prompt=True,
        provider=ModelProvider.ANTHROPIC,
        override_proxy="https://api.anthropic.com/v1",
        ci_run_frequency="daily",
    ),
    ModelTemplate(
        name="claude-opus-4-5",
        formatted_name="Claude 4.5 Opus",
        max_concurrency=int(os.getenv("ANTHROPIC_CONCURRENCY", "2")),
        requires_chain_of_thought=True,
        uses_system_prompt=True,
        provider=ModelProvider.ANTHROPIC,
        override_proxy="https://api.anthropic.com/v1",
        ci_run_frequency="daily",
    ),
    # OpenAI models
    ModelTemplate(
        name="o4-mini",
        formatted_name="o4-mini",
        max_concurrency=int(os.getenv("OPENAI_CONCURRENCY", "4")),
        requires_chain_of_thought=False,
        uses_system_prompt=False,
        provider=ModelProvider.OPENAI,
        supports_temperature=False,
        ci_run_frequency="monthly",
    ),
    ModelTemplate(
        name="gpt-4.1",
        formatted_name="GPT-4.1",
        max_concurrency=int(os.getenv("OPENAI_CONCURRENCY", "4")),
        requires_chain_of_thought=True,
        uses_system_prompt=True,
        provider=ModelProvider.OPENAI,
        ci_run_frequency="monthly",
    ),
    ModelTemplate(
        name="gpt-5.1",
        formatted_name="GPT-5.1",
        max_concurrency=int(os.getenv("OPENAI_CONCURRENCY", "4")),
        requires_chain_of_thought=False,
        uses_system_prompt=False,
        provider=ModelProvider.OPENAI,
        supports_temperature=False,
        ci_run_frequency="weekly",
    ),
    ModelTemplate(
        name="gpt-5.2",
        formatted_name="GPT-5.2",
        max_concurrency=int(os.getenv("OPENAI_CONCURRENCY", "4")),
        requires_chain_of_thought=False,
        uses_system_prompt=False,
        provider=ModelProvider.OPENAI,
        supports_temperature=False,
        ci_run_frequency="daily",
    ),
    ModelTemplate(
        name="gpt-5",
        formatted_name="GPT-5",
        max_concurrency=int(os.getenv("OPENAI_CONCURRENCY", "4")),
        requires_chain_of_thought=False,
        uses_system_prompt=False,
        provider=ModelProvider.OPENAI,
        supports_temperature=False,
        ci_run_frequency="daily",
    ),
    ModelTemplate(
        name="gpt-5-mini",
        formatted_name="GPT-5 mini",
        max_concurrency=int(os.getenv("OPENAI_CONCURRENCY", "4")),
        requires_chain_of_thought=False,
        uses_system_prompt=False,
        provider=ModelProvider.OPENAI,
        supports_temperature=False,
        ci_run_frequency="weekly",
    ),
    ModelTemplate(
        name="gpt-5-nano",
        formatted_name="GPT-5 nano",
        max_concurrency=int(os.getenv("OPENAI_CONCURRENCY", "4")),
        requires_chain_of_thought=False,
        uses_system_prompt=False,
        provider=ModelProvider.OPENAI,
        supports_temperature=False,
        ci_run_frequency="weekly",
    ),
    # Together AI (open source) models
    ModelTemplate(
        name="deepseek-ai/DeepSeek-V3",
        formatted_name="DeepSeek V3",
        max_concurrency=int(os.getenv("TOGETHER_CONCURRENCY", "4")),
        requires_chain_of_thought=True,
        uses_system_prompt=True,
        provider=ModelProvider.TOGETHER,
        override_proxy="https://api.together.xyz/v1",
        ci_run_frequency="daily",
    ),
    ModelTemplate(
        name="deepseek-ai/DeepSeek-R1",
        formatted_name="DeepSeek R1",
        max_concurrency=int(os.getenv("TOGETHER_CONCURRENCY", "4")),
        requires_chain_of_thought=False,
        uses_system_prompt=False,
        provider=ModelProvider.TOGETHER,
        override_proxy="https://api.together.xyz/v1",
        supports_temperature=False,
        ci_run_frequency="daily",
    ),
    ModelTemplate(
        name="meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8",
        formatted_name="Llama 4 Maverick",
        max_concurrency=int(os.getenv("TOGETHER_CONCURRENCY", "4")),
        requires_chain_of_thought=False,
        uses_system_prompt=True,
        provider=ModelProvider.TOGETHER,
        override_proxy="https://api.together.xyz/v1",
        ci_run_frequency="daily",
    ),
    ModelTemplate(
        name="zai-org/GLM-4.7",
        formatted_name="GLM 4.7",
        max_concurrency=int(os.getenv("TOGETHER_CONCURRENCY", "4")),
        requires_chain_of_thought=False,
        uses_system_prompt=True,
        provider=ModelProvider.TOGETHER,
        override_proxy="https://api.together.xyz/v1",
        ci_run_frequency="daily",
    ),
    ModelTemplate(
        name="moonshotai/Kimi-K2-Instruct-0905",
        formatted_name="Kimi K2",
        max_concurrency=int(os.getenv("TOGETHER_CONCURRENCY", "4")),
        requires_chain_of_thought=False,
        uses_system_prompt=True,
        provider=ModelProvider.TOGETHER,
        override_proxy="https://api.together.xyz/v1",
        ci_run_frequency="daily",
    ),
    ModelTemplate(
        name="Qwen/Qwen3-235B-A22B-Instruct-2507-tput",
        formatted_name="Qwen3 235B",
        max_concurrency=int(os.getenv("TOGETHER_CONCURRENCY", "4")),
        requires_chain_of_thought=False,
        uses_system_prompt=True,
        provider=ModelProvider.TOGETHER,
        override_proxy="https://api.together.xyz/v1",
        ci_run_frequency="daily",
    ),
    # Google models
    ModelTemplate(
        name="gemini-2.5-flash",
        formatted_name="Gemini 2.5 Flash",
        max_concurrency=int(os.getenv("GOOGLE_CONCURRENCY", "8")),
        requires_chain_of_thought=True,
        uses_system_prompt=False,
        provider=ModelProvider.GOOGLE,
        ci_run_frequency="daily",
    ),
    ModelTemplate(
        name="gemini-2.5-pro",
        formatted_name="Gemini 2.5 Pro",
        max_concurrency=int(os.getenv("GOOGLE_CONCURRENCY", "4")),
        requires_chain_of_thought=False,
        uses_system_prompt=False,
        provider=ModelProvider.GOOGLE,
        override_proxy="https://generativelanguage.googleapis.com/v1beta",
        ci_run_frequency="weekly",
    ),
    ModelTemplate(
        name="gemini-3-pro-preview",
        formatted_name="Gemini 3 Pro",
        max_concurrency=int(os.getenv("GOOGLE_CONCURRENCY", "4")),
        requires_chain_of_thought=False,
        uses_system_prompt=False,
        provider=ModelProvider.GOOGLE,
        override_proxy="https://generativelanguage.googleapis.com/v1beta",
        ci_run_frequency="daily",
    ),
    # xAI models
    ModelTemplate(
        name="grok-4",
        formatted_name="Grok 4",
        max_concurrency=int(os.getenv("XAI_CONCURRENCY", "4")),
        requires_chain_of_thought=False,
        uses_system_prompt=False,
        provider=ModelProvider.XAI,
        override_proxy="https://api.x.ai/v1",
        ci_run_frequency="daily",
    ),
    ModelTemplate(
        name="grok-3-mini-beta",
        formatted_name="Grok 3 Mini (Beta)",
        max_concurrency=int(os.getenv("XAI_CONCURRENCY", "4")),
        requires_chain_of_thought=False,
        uses_system_prompt=False,
        provider=ModelProvider.XAI,
        override_proxy="https://api.x.ai/v1",
        ci_run_frequency="weekly",
    ),
]
MODELS_BY_NAME = {model.name: model for model in ALL_MODELS}


class ConvexCodegenModel:
    def generate(self, user_prompt: str) -> dict[str, str]:
        raise NotImplementedError()


SYSTEM_PROMPT = "You are convexbot, a highly advanced software engineer specialized in creating applications using Convex and TypeScript."
