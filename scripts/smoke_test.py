#!/usr/bin/env python3
from __future__ import annotations

import json
import shutil
import sqlite3
import subprocess
import tempfile
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
HELPER = ROOT / "scripts" / "codex_state.py"


def run(codex_home: Path, *args: str) -> dict:
    completed = subprocess.run(
        ["python3", str(HELPER), "--codex-home", str(codex_home), *args],
        check=True,
        capture_output=True,
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
            updated_at_ms,
            recency_at,
            recency_at_ms
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            "thread-1",
            str(rollout_path),
            now,
            now,
            "/tmp/project",
            "Old title",
            "first message",
            "preview",
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
    try:
        create_fake_codex_home(root)

        schema = run(root, "schema")
        assert schema["thread_count"] == 1, schema

        search = run(root, "list", "--query", "searchable", "--search-content", "--limit", "5")
        assert search["threads"][0]["id"] == "thread-1", search

        rename = run(root, "rename", "--thread-id", "thread-1", "--title", "New title")
        assert rename["session_index_updated"] is True, rename

        tags = run(root, "set-tags", "--thread-id", "thread-1", "--tags", "alpha, beta")
        assert tags["tags"] == ["alpha", "beta"], tags

        archive = run(root, "archive", "--thread-id", "thread-1", "--archived", "true")
        assert archive["archived"] is True, archive

        listed = run(root, "list", "--include-archived", "--limit", "5")
        thread = listed["threads"][0]
        assert thread["title"] == "New title", thread
        assert thread["archived"] is True, thread
        assert thread["tags"] == ["alpha", "beta"], thread

        index = json.loads((root / "session_index.jsonl").read_text(encoding="utf-8"))
        assert index["thread_name"] == "New title", index

        transcript = run(root, "transcript", "--thread-id", "thread-1")
        assert "# New title" in transcript["markdown"], transcript
        assert "hello searchable transcript" in transcript["markdown"], transcript

        print("smoke ok")
        return 0
    finally:
        shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
