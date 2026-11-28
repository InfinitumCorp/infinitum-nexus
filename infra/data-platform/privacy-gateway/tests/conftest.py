import pytest

from cumulus_privacy.redaction import Redactor

TEST_KEY = b"test-only-pseudonym-key-0123456789abcdef"


@pytest.fixture(scope="session")
def redactor() -> Redactor:
    return Redactor(pseudonym_key=TEST_KEY)
