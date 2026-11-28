# © Infinitum Corporation®. All rights reserved.
"""PII redaction in front of analytics, AI agents and Exchange exports, using Microsoft Presidio.

Every record bound for one of those destinations passes through `Redactor.redact_records`.
Each destination has its own policy:

* ``analytics``: identifiers become keyed pseudonyms (HMAC-SHA256), so dashboards can still
  count distinct people and join on them, but nobody can read them back.
* ``ai``: personal data is replaced with a type tag such as ``<PERSON>``. Models get the shape
  of the text without the people in it. Secrets (API keys, tokens) are always removed.
* ``exchange``: data leaves the tenant. Personal data is replaced, pseudonymized fields are
  dropped (no cross-tenant linkage), and the result is scanned again. A record that still
  contains personal data is rejected rather than exported (fail closed).

Field rules come from the dataset contract:
``keep`` (scanned, value kept unless PII is found), ``text`` (scanned and redacted),
``pseudonymize`` (whole value replaced), ``drop`` (removed). Fields without a rule are ``text``.
"""
from __future__ import annotations

import hashlib
import hmac
import os
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Iterable, Mapping

from presidio_analyzer import AnalyzerEngine, Pattern, PatternRecognizer, RecognizerResult
from presidio_analyzer.nlp_engine import NlpEngineProvider
from presidio_anonymizer import AnonymizerEngine
from presidio_anonymizer.entities import OperatorConfig


class _CaseInsensitive(str, Enum):
    """Accepts Conjure's UPPER_CASE enum values as well as lower case."""

    @classmethod
    def _missing_(cls, value: object):
        if isinstance(value, str):
            for m in cls:
                if m.value == value.lower():
                    return m
        return None


class Destination(_CaseInsensitive):
    ANALYTICS = "analytics"
    AI = "ai"
    EXCHANGE = "exchange"


class FieldRule(_CaseInsensitive):
    KEEP = "keep"
    TEXT = "text"
    PSEUDONYMIZE = "pseudonymize"
    DROP = "drop"


# Entities we act on. Presidio's built-ins plus the Infinitum recognizers below.
ENTITIES = [
    "PERSON",
    "EMAIL_ADDRESS",
    "PHONE_NUMBER",
    "CREDIT_CARD",
    "IBAN_CODE",
    "US_SSN",
    "IP_ADDRESS",
    "CRYPTO",
    "LOCATION",
    "CUMULUS_ID",
    "SECRET",
]

# Values that must never be pseudonymized (a keyed hash of a card number or key is still
# sensitive), only removed.
ALWAYS_REMOVE = {"CREDIT_CARD", "IBAN_CODE", "US_SSN", "SECRET", "CRYPTO"}

# Presidio scores a phone number 0.4 unless a context word ("phone", "tel") is nearby. Its
# phone recognizer only matches strings libphonenumber can parse, so a lower bar costs few
# false positives, and missing a number is the worse error here.
ENTITY_THRESHOLDS = {"PHONE_NUMBER": 0.35}


def _infinitum_recognizers() -> list[PatternRecognizer]:
    cid = PatternRecognizer(
        supported_entity="CUMULUS_ID",
        patterns=[Pattern("cid", r"\bcid_[A-Za-z0-9_-]{6,64}\b", 0.85)],
        context=["cid", "cumulus"],
    )
    secret = PatternRecognizer(
        supported_entity="SECRET",
        patterns=[
            Pattern("aws_access_key", r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b", 0.95),
            Pattern("github_token", r"\bgh[pousr]_[A-Za-z0-9]{36,255}\b", 0.95),
            Pattern("stripe_key", r"\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b", 0.95),
            Pattern("slack_token", r"\bxox[abprs]-[A-Za-z0-9-]{10,}\b", 0.95),
            Pattern("jwt", r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b", 0.9),
            Pattern("private_key", r"-----BEGIN [A-Z ]*PRIVATE KEY-----", 1.0),
        ],
    )
    return [cid, secret]


def build_analyzer(model: str | None = None) -> AnalyzerEngine:
    """Presidio analyzer on spaCy. The small English model keeps the container light; set
    PRESIDIO_SPACY_MODEL=en_core_web_lg for better PERSON/LOCATION recall in production."""
    model = model or os.environ.get("PRESIDIO_SPACY_MODEL", "en_core_web_sm")
    provider = NlpEngineProvider(
        nlp_configuration={
            "nlp_engine_name": "spacy",
            "models": [{"lang_code": "en", "model_name": model}],
        }
    )
    analyzer = AnalyzerEngine(nlp_engine=provider.create_engine(), supported_languages=["en"])
    for r in _infinitum_recognizers():
        analyzer.registry.add_recognizer(r)
    return analyzer


@dataclass
class RedactionResult:
    records: list[dict[str, Any]]
    rejected: list[dict[str, Any]] = field(default_factory=list)
    findings: dict[str, int] = field(default_factory=dict)


class Redactor:
    def __init__(
        self,
        pseudonym_key: bytes | None = None,
        analyzer: AnalyzerEngine | None = None,
        score_threshold: float = 0.5,
    ) -> None:
        key = pseudonym_key
        if key is None:
            env = os.environ.get("PRIVACY_PSEUDONYM_KEY")
            if not env:
                raise ValueError("PRIVACY_PSEUDONYM_KEY is required (32+ random bytes, hex or text)")
            key = env.encode()
        if len(key) < 32:
            raise ValueError("pseudonym key must be at least 32 bytes")
        self._key = key
        self._analyzer = analyzer or build_analyzer()
        self._anonymizer = AnonymizerEngine()
        self._threshold = score_threshold

    # -- primitives -------------------------------------------------------------------

    def pseudonym(self, entity: str, value: str, destination: Destination) -> str:
        """Stable keyed pseudonym. Keyed per destination so analytics pseudonyms cannot be
        matched against any other release."""
        mac = hmac.new(self._key, f"{destination.value}\x00{entity}\x00{value}".encode(), hashlib.sha256)
        return f"<{entity}:{mac.hexdigest()[:16]}>"

    def analyze(self, text: str) -> list[RecognizerResult]:
        floor = min([self._threshold, *ENTITY_THRESHOLDS.values()])
        results = self._analyzer.analyze(text=text, language="en", entities=ENTITIES, score_threshold=floor)
        return [r for r in results if r.score >= ENTITY_THRESHOLDS.get(r.entity_type, self._threshold)]

    def _operators(self, destination: Destination) -> dict[str, OperatorConfig]:
        ops: dict[str, OperatorConfig] = {
            "DEFAULT": OperatorConfig("replace", {"new_value": "<PII>"}),
        }
        for ent in ENTITIES:
            if ent in ALWAYS_REMOVE or destination is not Destination.ANALYTICS:
                ops[ent] = OperatorConfig("replace", {"new_value": f"<{ent}>"})
            else:
                ops[ent] = OperatorConfig(
                    "custom",
                    {"lambda": (lambda e: lambda v: self.pseudonym(e, v, destination))(ent)},
                )
        return ops

    def redact_text(self, text: str, destination: Destination) -> tuple[str, list[str]]:
        results = self.analyze(text)
        if not results:
            return text, []
        out = self._anonymizer.anonymize(
            text=text, analyzer_results=results, operators=self._operators(destination)
        )
        return out.text, [r.entity_type for r in results]

    # -- records ----------------------------------------------------------------------

    def redact_record(
        self,
        record: Mapping[str, Any],
        destination: Destination,
        rules: Mapping[str, FieldRule] | None = None,
    ) -> tuple[dict[str, Any] | None, list[str]]:
        """Returns (redacted record, entity types found). The record is None when the
        Exchange re-scan still finds personal data."""
        rules = rules or {}
        out: dict[str, Any] = {}
        found: list[str] = []
        for name, value in record.items():
            rule = FieldRule(rules.get(name, FieldRule.TEXT))
            if rule is FieldRule.DROP:
                continue
            if rule is FieldRule.PSEUDONYMIZE:
                if destination is Destination.EXCHANGE:
                    continue  # no cross-tenant linkage
                if destination is Destination.AI:
                    out[name] = f"<{name.upper()}>"
                    continue
                out[name] = None if value is None else self.pseudonym(name, str(value), destination)
                continue
            if isinstance(value, str):
                red, ents = self.redact_text(value, destination)
                out[name] = red
                found.extend(ents)
            elif isinstance(value, Mapping):
                sub, ents = self.redact_record(value, destination, {})
                out[name] = sub
                found.extend(ents)
                if sub is None:
                    return None, found
            elif isinstance(value, list):
                items = []
                for v in value:
                    if isinstance(v, str):
                        red, ents = self.redact_text(v, destination)
                        items.append(red)
                        found.extend(ents)
                    else:
                        items.append(v)
                out[name] = items
            else:
                out[name] = value

        if destination is Destination.EXCHANGE and self._still_contains_pii(out):
            return None, found
        return out, found

    def _still_contains_pii(self, record: Mapping[str, Any]) -> bool:
        for value in record.values():
            if isinstance(value, str) and self.analyze(value):
                return True
            if isinstance(value, Mapping) and self._still_contains_pii(value):
                return True
            if isinstance(value, list) and any(isinstance(v, str) and self.analyze(v) for v in value):
                return True
        return False

    def redact_records(
        self,
        records: Iterable[Mapping[str, Any]],
        destination: Destination | str,
        rules: Mapping[str, FieldRule | str] | None = None,
    ) -> RedactionResult:
        destination = Destination(destination)
        typed = {k: FieldRule(v) for k, v in (rules or {}).items()}
        result = RedactionResult(records=[])
        for i, rec in enumerate(records):
            red, found = self.redact_record(rec, destination, typed)
            for ent in found:
                result.findings[ent] = result.findings.get(ent, 0) + 1
            if red is None:
                # Report the position only: the rejected record itself may hold PII.
                result.rejected.append({"index": i, "reason": "personal data remained after redaction"})
            else:
                result.records.append(red)
        return result
