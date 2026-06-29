#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import shutil
import sqlite3
import subprocess
import tempfile
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
HELPER = ROOT / "scripts" / "codex_state.py"


def run(codex_home: Path, organizer_home: Path, *args: str) -> dict:
    env = {**os.environ, "CODEX_CHAT_ORGANIZER_HOME": str(organizer_home)}
    completed = subprocess.run(
        ["python3", str(HELPER), "--codex-home", str(codex_home), *args],
        check=True,
        capture_output=True,
        env=env,
        text=True,
    )
    payload = json.loads(completed.stdout)
    if not payload.get("ok"):
        raise AssertionError(payload)
    return payload


def create_fake_codex_home(root: Path) -> None:
    db_path = root / "state_1.sqlite"
    rollout_path = root / "sessions" / "2026" / "06" / "26" / "rollout-2026-06-26T00-00-00-thread-1.jsonl"
    rollout_path.parent.mkdir(parents=True)
    rollout_path.write_text(
        json.dumps({"type": "response_item", "payload": {"role": "user", "content": "hello searchable transcript"}})
        + "\n"
        + json.dumps({"type": "response_item", "payload": {"role": "assistant", "content": "assistant reply"}})
        + "\n",
        encoding="utf-8",
    )

    now = int(time.time())
    con = sqlite3.connect(db_path)
    con.execute(
        """
        create table threads (
            id text primary key,
            rollout_path text not null,
            created_at integer not null,
            updated_at integer not null,
            source text not null default '',
            model_provider text not null default '',
            cwd text not null,
            title text not null,
            sandbox_policy text not null default '',
            approval_mode text not null default '',
            tokens_used integer not null default 0,
            has_user_event integer not null default 0,
            archived integer not null default 0,
            archived_at integer,
            first_user_message text not null default '',
            preview text not null default '',
            git_branch text not null default '',
            updated_at_ms integer,
            recency_at integer not null default 0,
            recency_at_ms integer not null default 0
        )
        """
    )
    con.execute(
        """
        insert into threads (
            id,
            rollout_path,
            created_at,
            updated_at,
            cwd,
            title,
            first_user_message,
            preview,
            git_branch,
            updated_at_ms,
            recency_at,
            recency_at_ms
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            "thread-1",
            str(rollout_path),
            now,
            now,
            "/tmp/project",
            "first message",
            "first message",
            "preview",
            "main",
            now * 1000,
            now,
            now * 1000,
        ),
    )
    con.commit()
    con.close()

    (root / "session_index.jsonl").write_text(
        json.dumps({"id": "thread-1", "thread_name": "Old title", "updated_at": "old"}) + "\n",
        encoding="utf-8",
    )


def main() -> int:
    root = Path(tempfile.mkdtemp(prefix="codex-chat-organizer-smoke-"))
    organizer_root = root / "organizer"
    try:
        create_fake_codex_home(root)
        active_rollout_path = root / "sessions" / "2026" / "06" / "26" / "rollout-2026-06-26T00-00-00-thread-1.jsonl"
        archived_rollout_path = root / "archived_sessions" / active_rollout_path.name

        schema = run(root, organizer_root, "schema")
        assert schema["thread_count"] == 1, schema

        search = run(root, organizer_root, "list", "--query", "searchable", "--search-content", "--limit", "5")
        assert search["threads"][0]["id"] == "thread-1", search

        title_search = run(root, organizer_root, "list", "--query", "Old title", "--limit", "5")
        assert title_search["threads"][0]["id"] == "thread-1", title_search

        listed_before = run(root, organizer_root, "list", "--limit", "5")
        assert listed_before["projects"][0]["id"] == "__no_project__", listed_before
        assert listed_before["threads"][0]["project_id"] == "__no_project__", listed_before
        assert listed_before["threads"][0]["title"] == "Old title", listed_before
        assert listed_before["threads"][0]["cwd_label"] == "project", listed_before
        assert listed_before["threads"][0]["git_branch"] == "main", listed_before
        assert listed_before["threads"][0]["starred"] is False, listed_before
        assert isinstance(listed_before["threads"][0]["size_bytes"], int), listed_before

        project = run(root, organizer_root, "create-project", "--name", "Client Work")["project"]
        assert project["name"] == "Client Work", project

        moved = run(root, organizer_root, "move-threads", "--thread-ids", "thread-1", "--project-id", project["id"])
        assert moved["moved"] == 1, moved
        assert moved["project_id"] == project["id"], moved

        listed_moved = run(root, organizer_root, "list", "--limit", "5")
        assert listed_moved["threads"][0]["project_id"] == project["id"], listed_moved
        assert listed_moved["threads"][0]["project_name"] == "Client Work", listed_moved

        renamed_project = run(
            root,
            organizer_root,
            "rename-project",
            "--project-id",
            project["id"],
            "--name",
            "Client Work Renamed",
        )
        assert renamed_project["project"]["name"] == "Client Work Renamed", renamed_project

        deleted_project = run(root, organizer_root, "delete-project", "--project-id", project["id"])
        assert deleted_project["moved_to_no_project"] == 1, deleted_project

        listed_deleted = run(root, organizer_root, "list", "--limit", "5")
        assert listed_deleted["threads"][0]["project_id"] == "__no_project__", listed_deleted

        rename = run(root, organizer_root, "rename", "--thread-id", "thread-1", "--title", "New title")
        assert rename["session_index_updated"] is True, rename

        tags = run(root, organizer_root, "set-tags", "--thread-id", "thread-1", "--tags", "alpha, beta")
        assert tags["tags"] == ["alpha", "beta"], tags

        starred = run(root, organizer_root, "set-star", "--thread-id", "thread-1", "--starred", "true")
        assert starred["starred"] is True, starred

        archive = run(root, organizer_root, "archive", "--thread-id", "thread-1", "--archived", "true")
        assert archive["archived"] is True, archive
        assert archive["rollout_path"] == str(archived_rollout_path), archive
        assert archived_rollout_path.exists(), archive
        assert not active_rollout_path.exists(), archive

        listed = run(root, organizer_root, "list", "--include-archived", "--limit", "5")
        thread = listed["threads"][0]
        assert thread["title"] == "New title", thread
        assert thread["archived"] is True, thread
        assert thread["tags"] == ["alpha", "beta"], thread
        assert thread["starred"] is True, thread

        index = json.loads((root / "session_index.jsonl").read_text(encoding="utf-8"))
        assert index["thread_name"] == "New title", index

        transcript = run(root, organizer_root, "transcript", "--thread-id", "thread-1")
        assert "# New title" in transcript["markdown"], transcript
        assert "hello searchable transcript" in transcript["markdown"], transcript

        deleted_thread = run(root, organizer_root, "delete-thread", "--thread-id", "thread-1")
        assert deleted_thread["session_index_updated"] is True, deleted_thread
        assert not archived_rollout_path.exists(), deleted_thread
        listed_after_delete = run(root, organizer_root, "list", "--include-archived", "--limit", "5")
        assert listed_after_delete["threads"] == [], listed_after_delete
        assert (root / "session_index.jsonl").read_text(encoding="utf-8") == ""

        print("smoke ok")
        return 0
    finally:
        shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
