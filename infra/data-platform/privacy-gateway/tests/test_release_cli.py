"""release_cli against the real gateway over HTTP (exact DP backend, so figures are checkable)."""
import json
import threading
from http.server import ThreadingHTTPServer

import pytest

from cumulus_privacy import release_cli
from cumulus_privacy.server import Gateway, make_handler, parse_product_tokens

from .test_event_release import DEALS, req, setup  # noqa: F401  (fixture)

TOKEN = "s" * 40


@pytest.fixture()
def gateway(setup, redactor):  # noqa: F811
    releases, budget, index = setup
    gw = Gateway(redactor, budget, "g" * 40, releases.catalog, None, None,
                 parse_product_tokens(f"spectre={TOKEN}"), None, releases=releases)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(gw))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}", budget, index
    httpd.shutdown()


def spec_file(tmp_path, **over):
    p = tmp_path / "release.json"
    p.write_text(json.dumps({"dataset": DEALS["name"], "request": req(**over)}))
    return str(p)


def test_release_writes_a_traceable_report(gateway, tmp_path, monkeypatch, capsys):
    url, budget, _ = gateway
    monkeypatch.setenv("DATA_API_URL", url)
    monkeypatch.setenv("DATA_API_TOKEN", TOKEN)
    out = tmp_path / "report.json"
    assert release_cli.main([spec_file(tmp_path, epsilon=0.5), "--out", str(out)]) == 0
    report = json.loads(out.read_text())
    assert report["release"]["groups"] == {"won": 2.0, "lost": 1.0}
    assert report["budgetBefore"]["remainingEpsilon"] == 2.0 and report["release"]["remainingEpsilon"] == 1.5
    assert report["figuresSha256"] == release_cli.figures_sha256(report["release"])
    assert TOKEN not in out.read_text() and TOKEN not in capsys.readouterr().out
    assert budget.spent(DEALS["name"]) == pytest.approx(0.5)


def test_dry_run_spends_nothing(gateway, tmp_path, monkeypatch, capsys):
    url, budget, index = gateway
    monkeypatch.setenv("DATA_API_URL", url)
    monkeypatch.setenv("DATA_API_TOKEN", TOKEN)
    assert release_cli.main([spec_file(tmp_path, epsilon=0.5), "--dry-run"]) == 0
    plan = json.loads(capsys.readouterr().out)
    assert plan["remainingAfter"] == 1.5
    assert budget.spent(DEALS["name"]) == 0 and index.calls == 0


@pytest.mark.parametrize("epsilon, message", [(1.5, "per-release cap"), (-1, "positive")])
def test_refuses_before_spending(gateway, tmp_path, epsilon, message):
    url, budget, index = gateway
    call = release_cli.http_transport(url, TOKEN)
    with pytest.raises(release_cli.ReleaseRefused, match=message):
        release_cli.run(call, json.loads(open(spec_file(tmp_path, epsilon=epsilon)).read()))
    assert budget.spent(DEALS["name"]) == 0 and index.calls == 0


def test_refuses_when_the_budget_is_nearly_spent(gateway, tmp_path, monkeypatch, capsys):
    url, budget, index = gateway
    call = release_cli.http_transport(url, TOKEN)
    for _ in range(2):
        release_cli.run(call, json.loads(open(spec_file(tmp_path, epsilon=0.9)).read()))
    calls = index.calls
    with pytest.raises(release_cli.ReleaseRefused, match="remaining budget"):
        release_cli.run(call, json.loads(open(spec_file(tmp_path, epsilon=0.5)).read()))
    assert index.calls == calls  # refused by the CLI, no events read
    monkeypatch.setenv("DATA_API_URL", url)
    monkeypatch.setenv("DATA_API_TOKEN", TOKEN)
    assert release_cli.main([spec_file(tmp_path, epsilon=0.5), "--out", str(tmp_path / "r.json")]) == 3
    assert "refused" in capsys.readouterr().err and not (tmp_path / "r.json").exists()


def test_gateway_errors_and_configuration(gateway, tmp_path, monkeypatch, capsys):
    url, _, _ = gateway
    with pytest.raises(release_cli.ReleaseRefused, match="DatasetNotFound"):
        release_cli.plan(release_cli.http_transport(url, TOKEN), {"dataset": "spectre.nope", "request": req()})
    with pytest.raises(release_cli.ReleaseRefused, match="401|Unauthorized|HTTP"):
        release_cli.plan(release_cli.http_transport(url, "x" * 40), {"dataset": DEALS["name"], "request": req()})
    with pytest.raises(ValueError):
        release_cli.http_transport("http://data-api.example.com", TOKEN)
    monkeypatch.delenv("DATA_API_URL", raising=False)
    assert release_cli.main([spec_file(tmp_path), "--dry-run"]) == 2
