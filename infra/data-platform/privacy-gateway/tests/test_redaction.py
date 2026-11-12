import pytest

from cumulus_privacy.pipeline import prepare_export
from cumulus_privacy.redaction import Destination, Redactor

TICKET = "Customer John Smith (john.smith@example.com, +1 212-555-0187) asked about invoice 42."


def test_ai_gets_type_tags_and_no_personal_data(redactor):
    out, found = redactor.redact_record({"body": TICKET}, Destination.AI)
    body = out["body"]
    assert "john.smith@example.com" not in body
    assert "555-0187" not in body
    assert "John Smith" not in body
    assert "<EMAIL_ADDRESS>" in body and "<PERSON>" in body and "<PHONE_NUMBER>" in body
    assert "invoice 42" in body  # non-personal content survives
    assert {"EMAIL_ADDRESS", "PERSON", "PHONE_NUMBER"} <= set(found)


def test_analytics_pseudonyms_are_stable_and_keyed(redactor):
    a, _ = redactor.redact_record({"note": "mail ana@example.org"}, Destination.ANALYTICS)
    b, _ = redactor.redact_record({"note": "again ana@example.org"}, Destination.ANALYTICS)
    tag_a = a["note"].split()[-1]
    tag_b = b["note"].split()[-1]
    assert tag_a == tag_b and tag_a.startswith("<EMAIL_ADDRESS:")
    other = Redactor(pseudonym_key=b"another-key-another-key-another-key-00")
    c, _ = other.redact_record({"note": "again ana@example.org"}, Destination.ANALYTICS)
    assert c["note"].split()[-1] != tag_a


def test_analytics_never_pseudonymizes_card_numbers(redactor):
    out, _ = redactor.redact_record({"t": "card 4111 1111 1111 1111 on file"}, Destination.ANALYTICS)
    assert "4111" not in out["t"]
    assert "<CREDIT_CARD>" in out["t"]


def test_secrets_are_removed_for_ai(redactor):
    out, found = redactor.redact_record(
        {"log": "deploy failed with key AKIAABCDEFGHIJKLMNOP"}, Destination.AI
    )
    assert "AKIA" not in out["log"]
    assert "SECRET" in found


def test_cumulus_ids_are_recognized(redactor):
    out, found = redactor.redact_record({"t": "owner cid_7Hq2xLm9Pz"}, Destination.AI)
    assert "cid_7Hq2xLm9Pz" not in out["t"]
    assert "CUMULUS_ID" in found


def test_field_rules(redactor):
    rec = {"cid": "cid_abc12345", "token": "x", "stage": "won", "amount": 120}
    rules = {"cid": "pseudonymize", "token": "drop", "stage": "keep"}
    a = redactor.redact_records([rec], "analytics", rules).records[0]
    assert "token" not in a
    assert a["cid"].startswith("<cid:") and a["stage"] == "won" and a["amount"] == 120
    e = redactor.redact_records([rec], "exchange", rules).records[0]
    assert "cid" not in e  # no cross-tenant linkage
    ai = redactor.redact_records([rec], "ai", rules).records[0]
    assert ai["cid"] == "<CID>"


def test_nested_values_and_lists(redactor):
    out, _ = redactor.redact_record(
        {"meta": {"to": "bob@example.com"}, "cc": ["eve@example.com", 3]}, Destination.AI
    )
    assert out["meta"]["to"] == "<EMAIL_ADDRESS>"
    assert out["cc"] == ["<EMAIL_ADDRESS>", 3]


def test_clean_text_is_untouched(redactor):
    out, found = redactor.redact_record({"t": "Quarterly revenue grew in the north region."}, Destination.EXCHANGE)
    assert found == [] or "LOCATION" in found
    assert "Quarterly revenue grew" in out["t"]


def test_exchange_fails_closed_when_pii_survives(redactor, monkeypatch):
    # Simulate an anonymizer gap: redaction returns text unchanged, so the re-scan finds PII.
    monkeypatch.setattr(redactor, "redact_text", lambda text, dest: (text, ["EMAIL_ADDRESS"]))
    res = redactor.redact_records([{"t": "write to zed@example.com"}], "exchange")
    assert res.records == []
    assert res.rejected == [{"index": 0, "reason": "personal data remained after redaction"}]


def test_export_blocked_when_exchange_rejects(redactor, monkeypatch):
    monkeypatch.setattr(redactor, "redact_text", lambda text, dest: (text, ["EMAIL_ADDRESS"]))
    res = prepare_export(redactor, [{"t": "zed@example.com"}], "exchange")
    assert not res.released
    assert res.to_dict()["records"] == []


def test_export_runs_quality_on_redacted_rows(redactor):
    rows = [{"deal_id": 1, "note": "call bob@example.com"}, {"deal_id": 1, "note": "ok"}]
    suite = {"dataset": "spectre.deals", "checks": [{"kind": "uniqueness", "columns": ["deal_id"]}]}
    res = prepare_export(redactor, rows, "analytics", suite=suite)
    assert not res.released
    assert "uniqueness" in res.reasons[0]
    ok = prepare_export(redactor, rows[:1], "analytics", suite=suite)
    assert ok.released and "bob@example.com" not in ok.records[0]["note"]


def test_phone_numbers_without_context_words(redactor):
    for text in ["call +7 916 123-45-67 tonight", "reach me at +44 20 7946 0958"]:
        out, found = redactor.redact_record({"t": text}, Destination.AI)
        assert "PHONE_NUMBER" in found, text
        assert "45-67" not in out["t"] and "0958" not in out["t"]


def test_requires_a_long_key():
    with pytest.raises(ValueError):
        Redactor(pseudonym_key=b"short")
