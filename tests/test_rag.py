from types import SimpleNamespace
import unittest

from src.rag import QueryProcessingError, process_customer_query


class FakeEmbeddings:
    def __init__(self):
        self.calls = []
        self.error = None

    def create(self, **kwargs):
        self.calls.append(kwargs)
        if self.error:
            raise self.error
        return SimpleNamespace(data=[SimpleNamespace(embedding=[0.1, 0.2])])


class FakeCompletions:
    def __init__(self, answer="5000 req/min"):
        self.calls = []
        self.answer = answer

    def create(self, **kwargs):
        self.calls.append(kwargs)
        return SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content=self.answer))]
        )


class RagTests(unittest.TestCase):
    def setUp(self):
        self.embeddings = FakeEmbeddings()
        self.completions = FakeCompletions()
        self.client = SimpleNamespace(
            embeddings=self.embeddings,
            chat=SimpleNamespace(completions=self.completions),
        )

    def test_sanitizes_before_both_external_requests_and_reads_v1_response(self):
        retrieved_vectors = []

        def retrieve(vector):
            retrieved_vectors.append(vector)
            return "Contact admin@example.com. Enterprise limit: 5000 req/min."

        answer = process_customer_query(
            "Email john@example.com or call +1-202-555-0143 about our limit",
            self.client,
            retrieve,
        )
        self.assertEqual(answer, "5000 req/min")
        self.assertEqual(retrieved_vectors, [[0.1, 0.2]])
        self.assertEqual(self.embeddings.calls[0]["model"], "text-embedding-3-small")
        self.assertNotIn("john@example.com", self.embeddings.calls[0]["input"])
        content = self.completions.calls[0]["messages"][1]["content"]
        self.assertIn("[REDACTED_EMAIL]", content)
        self.assertIn("[REDACTED_PHONE]", content)
        self.assertNotIn("admin@example.com", content)

    def test_no_context_stops_before_answer_request(self):
        with self.assertRaisesRegex(QueryProcessingError, "No relevant context"):
            process_customer_query("Question", self.client, lambda _vector: "")
        self.assertEqual(self.completions.calls, [])

    def test_api_error_is_wrapped_without_exposing_details(self):
        self.embeddings.error = RuntimeError("secret request details")
        with self.assertRaises(QueryProcessingError) as caught:
            process_customer_query("Question", self.client, lambda _vector: "context")
        self.assertEqual(str(caught.exception), "Could not generate an answer")

    def test_empty_model_answer_is_rejected(self):
        self.completions.answer = " "
        with self.assertRaisesRegex(QueryProcessingError, "no answer"):
            process_customer_query("Question", self.client, lambda _vector: "context")

    def test_blank_query_is_rejected(self):
        with self.assertRaises(ValueError):
            process_customer_query("  ", self.client, lambda _vector: "context")


if __name__ == "__main__":
    unittest.main()
