"""Phase 1 tests: health check and project CRUD lifecycle."""

from __future__ import annotations


def test_health(client):
    resp = client.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["app"]


def test_create_and_list_project(client):
    resp = client.post("/api/projects", json={"name": "My First Project"})
    assert resp.status_code == 201
    created = resp.json()
    assert created["name"] == "My First Project"
    assert created["status"] == "empty"
    assert created["storage_mode"] == "local_only"
    assert created["id"]

    resp = client.get("/api/projects")
    assert resp.status_code == 200
    projects = resp.json()
    assert len(projects) == 1
    assert projects[0]["id"] == created["id"]


def test_get_single_project(client):
    created = client.post("/api/projects", json={"name": "Alpha"}).json()
    resp = client.get(f"/api/projects/{created['id']}")
    assert resp.status_code == 200
    assert resp.json()["name"] == "Alpha"


def test_get_missing_project_returns_404(client):
    resp = client.get("/api/projects/does-not-exist")
    assert resp.status_code == 404


def test_update_project(client):
    created = client.post("/api/projects", json={"name": "Old Name"}).json()
    resp = client.patch(
        f"/api/projects/{created['id']}",
        json={"name": "New Name", "status": "imported"},
    )
    assert resp.status_code == 200
    updated = resp.json()
    assert updated["name"] == "New Name"
    assert updated["status"] == "imported"


def test_create_rejects_empty_name(client):
    resp = client.post("/api/projects", json={"name": ""})
    assert resp.status_code == 422


def test_delete_is_soft_and_keeps_files(client):
    created = client.post("/api/projects", json={"name": "To Delete"}).json()
    resp = client.delete(f"/api/projects/{created['id']}")
    assert resp.status_code == 200
    body = resp.json()
    assert body["deleted"] is True
    # Safety guarantee for this phase: no media files are ever removed.
    assert body["files_removed"] is False

    # Soft-deleted projects disappear from listings and single fetches.
    assert client.get("/api/projects").json() == []
    assert client.get(f"/api/projects/{created['id']}").status_code == 404
