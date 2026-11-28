# © Infinitum Corporation®. All rights reserved.
"""The export step every outbound batch goes through: redact, then verify quality.

    product data -> prepare_export(destination) -> analytics warehouse / AI agent / Exchange

A batch is released only when quality passes. For the Exchange, any record that still holds
personal data after redaction blocks the whole batch, because a partial export would hide
the problem from the publisher.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Mapping, Sequence

from .quality import QualityReport, run_suite
from .redaction import Destination, Redactor


@dataclass
class ExportResult:
    destination: str
    released: bool
    records: list[dict[str, Any]]
    rejected: list[dict[str, Any]]
    findings: dict[str, int]
    quality: QualityReport | None
    reasons: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "destination": self.destination,
            "released": self.released,
            "records": self.records if self.released else [],
            "rejected": self.rejected,
            "findings": self.findings,
            "quality": self.quality.to_dict() if self.quality else None,
            "reasons": self.reasons,
        }


def prepare_export(
    redactor: Redactor,
    records: Sequence[Mapping[str, Any]],
    destination: Destination | str,
    field_rules: Mapping[str, str] | None = None,
    suite: Mapping[str, Any] | None = None,
    history: Sequence[Mapping[str, float]] = (),
) -> ExportResult:
    destination = Destination(destination)
    red = redactor.redact_records(records, destination, field_rules)
    reasons: list[str] = []
    if destination is Destination.EXCHANGE and red.rejected:
        reasons.append(f"{len(red.rejected)} record(s) still held personal data after redaction")

    report = None
    if suite is not None:
        # Quality is measured on what would actually leave, i.e. after redaction.
        report = run_suite(suite, red.records, history)
        if not report.ok:
            failed = [f"{r.kind}({r.target}): {r.message}" for r in report.results if not r.ok]
            reasons.append("quality checks failed: " + "; ".join(failed))

    return ExportResult(
        destination=destination.value,
        released=not reasons,
        records=red.records,
        rejected=red.rejected,
        findings=red.findings,
        quality=report,
        reasons=reasons,
    )
