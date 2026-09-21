"""Mask the PII that must not be sent to an external LLM."""

import re


EMAIL = re.compile(r"\b[A-Z0-9._%+-]+@(?:(?:[^\W_]|-)+\.)+[^\W\d_]{2,}\b", re.IGNORECASE)
CARD = re.compile(r"(?<!\d)(?:\d[ .-]?){12,18}\d(?!\d)")
PHONE = re.compile(r"(?<![\w])\+?\(?\d(?:[\s().-]*\d){7,17}(?![\w])")


def _valid_card(digits: str) -> bool:
    total = 0
    for index, character in enumerate(reversed(digits)):
        value = int(character)
        if index % 2:
            value *= 2
            if value > 9:
                value -= 9
        total += value
    return total % 10 == 0


def sanitize_pii(text: str) -> str:
    """Replace email, international phone, and valid card numbers with labels."""
    if not isinstance(text, str):
        raise TypeError("text must be a string")

    result = EMAIL.sub("[REDACTED_EMAIL]", text)

    def mask_card(match: re.Match[str]) -> str:
        digits = re.sub(r"\D", "", match.group())
        return "[REDACTED_CARD]" if _valid_card(digits) else match.group()

    result = CARD.sub(mask_card, result)

    def mask_phone(match: re.Match[str]) -> str:
        candidate = match.group()
        digits = re.sub(r"\D", "", candidate)
        minimum_digits = 8 if candidate.startswith("+") else 10
        return "[REDACTED_PHONE]" if minimum_digits <= len(digits) <= 15 else candidate

    return PHONE.sub(mask_phone, result)
