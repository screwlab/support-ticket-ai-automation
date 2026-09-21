"""Minimal OpenAI v1+ RAG example; tests inject a fake client and retriever."""

import os
from collections.abc import Callable
from typing import Any

from src.pii import sanitize_pii


class QueryProcessingError(RuntimeError):
    """A retrieval or OpenAI request could not produce a safe answer."""


def process_customer_query(
    query: str,
    client: Any,
    retrieve_context: Callable[[list[float]], str],
) -> str:
    """Embed a sanitized query, retrieve context, and generate a grounded answer."""
    if not isinstance(query, str) or not query.strip():
        raise ValueError("query must be non-empty text")

    safe_query = sanitize_pii(query.strip())
    try:
        embedding = client.embeddings.create(
            model="text-embedding-3-small", input=safe_query
        )
        vector = embedding.data[0].embedding
        context = retrieve_context(vector)
        if not isinstance(context, str) or not context.strip():
            raise QueryProcessingError("No relevant context found")

        completion = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {
                    "role": "system",
                    "content": "Answer only from the supplied context. Say when it is insufficient.",
                },
                {
                    "role": "user",
                    "content": f"Context: {sanitize_pii(context)}\nQuestion: {safe_query}",
                },
            ],
        )
        answer = completion.choices[0].message.content
        if not isinstance(answer, str) or not answer.strip():
            raise QueryProcessingError("The model returned no answer")
        return answer.strip()
    except QueryProcessingError:
        raise
    except Exception as exc:
        # Keep API/internal errors (which can include request details) out of user output.
        raise QueryProcessingError("Could not generate an answer") from exc


def demo_retrieve_context(_vector: list[float]) -> str:
    """Assignment stub: replace with a vector DB search in a real system."""
    return "Our API rate limit is 100 req/min for Free tier, 5000 req/min for Enterprise."


if __name__ == "__main__":
    if not os.getenv("OPENAI_API_KEY"):
        raise SystemExit("No OPENAI_API_KEY configured; run the offline tests instead.")

    from openai import OpenAI

    try:
        print(
            process_customer_query(
                "What is the rate limit for Enterprise?",
                OpenAI(),
                demo_retrieve_context,
            )
        )
    except QueryProcessingError as exc:
        raise SystemExit(str(exc)) from None
