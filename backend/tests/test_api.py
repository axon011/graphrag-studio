"""End-to-end API tests — run fully offline (heuristic extractor)."""
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)

SAMPLE = (
    "Perinet builds industrial IoT devices. The MessageSense module publishes "
    "telemetry over MQTT. MQTT is a lightweight messaging protocol. Perinet uses "
    "MQTT for device communication."
)


def setup_function() -> None:
    client.post("/api/reset")


def test_health() -> None:
    r = client.get("/api/health")
    assert r.status_code == 200
    assert "nodes" in r.json()


def test_build_then_graph() -> None:
    r = client.post("/api/build", json={"text": SAMPLE, "reset": True})
    assert r.status_code == 200
    body = r.json()
    assert body["stats"]["nodes"] > 0
    assert body["stats"]["documents"] == 1
    # graph endpoint returns the same populated graph
    g = client.get("/api/graph").json()
    assert len(g["nodes"]) == body["stats"]["nodes"]


def test_build_rejects_empty() -> None:
    r = client.post("/api/build", json={"text": "   "})
    assert r.status_code == 400


def test_ask_returns_answer_and_subgraph() -> None:
    client.post("/api/build", json={"text": SAMPLE, "reset": True})
    r = client.post("/api/ask", json={"question": "How is Perinet connected to MQTT?"})
    assert r.status_code == 200
    body = r.json()
    assert body["answer"]
    assert isinstance(body["subgraph_node_ids"], list)
    assert isinstance(body["citations"], list)


def test_upload() -> None:
    files = {"file": ("doc.txt", SAMPLE.encode("utf-8"), "text/plain")}
    r = client.post("/api/upload?reset=true", files=files)
    assert r.status_code == 200
    assert r.json()["stats"]["nodes"] > 0


def test_reset_clears() -> None:
    client.post("/api/build", json={"text": SAMPLE, "reset": True})
    r = client.post("/api/reset")
    assert r.json()["stats"]["nodes"] == 0
