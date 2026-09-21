import unittest

from src.pii import sanitize_pii


class SanitizePiiTests(unittest.TestCase):
    def test_assignment_example(self):
        text = (
            "Please contact John at john.smith@company.com or call "
            "+1-202-555-0143 regarding order #4412."
        )
        self.assertEqual(
            sanitize_pii(text),
            "Please contact John at [REDACTED_EMAIL] or call "
            "[REDACTED_PHONE] regarding order #4412.",
        )

    def test_assignment_phone_examples(self):
        self.assertEqual(sanitize_pii("Call +1-555-0199"), "Call [REDACTED_PHONE]")
        self.assertEqual(sanitize_pii("Call 88005553535"), "Call [REDACTED_PHONE]")

    def test_phone_writing_styles(self):
        styles = [
            "+1 202 555 0143",
            "+12025550143",
            "+1 (202) 555-0143",
            "(202) 555-0143",
            "202.555.0143",
            "202-555-0143",
            "+7 (800) 555-35-35",
            "8-800-555-35-35",
            "8 800 555 35 35",
            "+44 20 7946 0958",
            "+49 30 123456",
            "+91-98765-43210",
        ]
        for phone in styles:
            with self.subTest(phone=phone):
                self.assertEqual(sanitize_pii(f"Call {phone} today"), "Call [REDACTED_PHONE] today")

    def test_email_writing_styles(self):
        emails = [
            "john.smith@company.com",
            "John.Smith@Company.COM",
            "first.last+tag@sub.example.co.uk",
            "user_name-1@example.io",
            "ivan@example.рф",
            "a@b.co",
        ]
        for email in emails:
            with self.subTest(email=email):
                self.assertEqual(sanitize_pii(f"Mail {email} now"), "Mail [REDACTED_EMAIL] now")
        self.assertEqual(sanitize_pii("Two: a@x.com, b@y.org").count("[REDACTED_EMAIL]"), 2)

    def test_card_writing_styles(self):
        cards = [
            "4111111111111111",
            "4111-1111-1111-1111",
            "4111 1111 1111 1111",
            "4111.1111.1111.1111",
            "5500 0000 0000 0004",
            "3400 0000 0000 009",
        ]
        for card in cards:
            with self.subTest(card=card):
                self.assertEqual(sanitize_pii(f"card {card} ok"), "card [REDACTED_CARD] ok")

    def test_luhn_invalid_digit_runs_are_not_cards(self):
        # 16 digits that fail Luhn: not a card, and too long for a phone number
        self.assertEqual(sanitize_pii("ref 1234 5678 9012 3456"), "ref 1234 5678 9012 3456")

    def test_non_pii_numbers_are_preserved(self):
        texts = [
            "Hi, your API returns 500 error on /v1/billing endpoint. Fix this ASAP!",
            "Order #4412, ticket TK-9082, HTTP 429, port 5678",
            "Rate limit is 100 req/min for Free, 5000 req/min for Enterprise",
            "Version v2.0.1 released on 2024-01-15",
            "ID 12345678 ok",
        ]
        for text in texts:
            with self.subTest(text=text):
                self.assertEqual(sanitize_pii(text), text)

    def test_non_email_at_signs_are_preserved(self):
        self.assertEqual(sanitize_pii("ping @support or a@b"), "ping @support or a@b")

    def test_mixed_message_masks_every_kind_once(self):
        text = (
            "Hi, I am jane.doe@example.com (+1-202-555-0143). "
            "I paid with 4111 1111 1111 1111 for order #4412 and got a 500 error."
        )
        self.assertEqual(
            sanitize_pii(text),
            "Hi, I am [REDACTED_EMAIL] ([REDACTED_PHONE]). "
            "I paid with [REDACTED_CARD] for order #4412 and got a 500 error.",
        )

    def test_masking_is_idempotent(self):
        text = "Mail a@b.co, call +1-555-0199, card 4111 1111 1111 1111"
        once = sanitize_pii(text)
        self.assertEqual(sanitize_pii(once), once)

    def test_no_digits_of_masked_values_survive(self):
        result = sanitize_pii("Call +1-202-555-0143 or use 4111 1111 1111 1111")
        for fragment in ("202", "555", "0143", "4111"):
            self.assertNotIn(fragment, result)

    def test_empty_and_whitespace_text(self):
        self.assertEqual(sanitize_pii(""), "")
        self.assertEqual(sanitize_pii("   "), "   ")

    def test_non_string_rejected(self):
        for value in (None, 123, ["a@b.co"]):
            with self.subTest(value=value):
                with self.assertRaises(TypeError):
                    sanitize_pii(value)


if __name__ == "__main__":
    unittest.main()
