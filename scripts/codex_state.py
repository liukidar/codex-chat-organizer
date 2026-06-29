#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sqlite3
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


NO_PROJECT_ID = "__no_project__"

REQUIRED_THREAD_COLUMNS = {
    "id",
    "title",
    "archived",
    "archived_at",
    "updated_at",
    "updated_at_ms",
    "recency_at",
    "recency_at_ms",
    "rollout_path",
    "cwd",
    "first_user_message",
    "preview",
}


def json_out(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False))


def utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


def now_parts() -> tuple[int, int, str]:
    now = time.time()
    return int(now), int(now * 1000), utc_iso()


def codex_home_from_arg(value: str | None) -> Path:
    if value:
        return Path(value).expanduser()
    env_value = Path.home()
    if "CODEX_HOME" in os.environ:
        return Path(os.environ["CODEX_HOME"]).expanduser()
    return env_value / ".codex"


def connect(path: Path, *, readonly: bool) -> sqlite3.Connection:
    if readonly:
        return sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    return sqlite3.connect(path)


def has_threads_table(path: Path) -> bool:
    try:
        with connect(path, readonly=True) as con:
            row = con.execute("select 1 from sqlite_master where type='table' and name='threads'").fetchone()
            return row is not None
    except sqlite3.Error:
        return False


def find_state_db(codex_home: Path) -> Path | None:
    candidates = sorted(
        codex_home.glob("state_*.sqlite"),
        key=lambda p: (int(p.stem.split("_", 1)[1]) if p.stem.split("_", 1)[1].isdigit() else -1, p.stat().st_mtime),
        reverse=True,
    )
    for candidate in candidates:
        if has_threads_table(candidate):
            return candidate
    return None


def organizer_home() -> Path:
    if "CODEX_CHAT_ORGANIZER_HOME" in os.environ:
        return Path(os.environ["CODEX_CHAT_ORGANIZER_HOME"]).expanduser()
    return Path.home() / ".codex-chat-organizer"


def metadata_path() -> Path:
    return organizer_home() / "metadata.json"


def load_metadata() -> dict[str, Any]:
    path = metadata_path()
    if not path.exists():
        return normalize_metadata({})
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return normalize_metadata({})
    if not isinstance(payload, dict):
        return normalize_metadata({})
    return normalize_metadata(payload)


def normalize_metadata(payload: dict[str, Any]) -> dict[str, Any]:
    payload.setdefault("version", 2)
    payload.setdefault("threads", {})
    payload.setdefault("projects", {})
    payload["version"] = max(int(payload.get("version") or 1), 2)
    if not isinstance(payload["threads"], dict):
        payload["threads"] = {}
    if not isinstance(payload["projects"], dict):
        payload["projects"] = {}
    return payload


def save_metadata(payload: dict[str, Any]) -> None:
    payload = normalize_metadata(payload)
    path = metadata_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def no_project_record() -> dict[str, Any]:
    return {
        "id": NO_PROJECT_ID,
        "name": "No Project",
        "created_at": None,
        "updated_at": None,
        "builtin": True,
    }


def project_records(metadata: dict[str, Any]) -> list[dict[str, Any]]:
    projects = metadata.get("projects", {})
    records = [no_project_record()]
    if isinstance(projects, dict):
        for project_id, project in projects.items():
            if not isinstance(project, dict):
                continue
            name = str(project.get("name") or "").strip()
            if not name:
                continue
            records.append(
                {
                    "id": str(project_id),
                    "name": name,
                    "created_at": project.get("created_at"),
                    "updated_at": project.get("updated_at"),
                    "builtin": False,
                }
            )
    return [records[0], *sorted(records[1:], key=lambda item: item["name"].lower())]


def known_project_ids(metadata: dict[str, Any]) -> set[str]:
    projects = metadata.get("projects", {})
    ids = {NO_PROJECT_ID}
    if isinstance(projects, dict):
        ids.update(str(project_id) for project_id in projects)
    return ids


def project_id_for_thread(thread_id: str, metadata: dict[str, Any]) -> str:
    threads = metadata.get("threads", {})
    if not isinstance(threads, dict):
        return NO_PROJECT_ID
    entry = threads.get(thread_id)
    if not isinstance(entry, dict):
        return NO_PROJECT_ID
    project_id = str(entry.get("project_id") or NO_PROJECT_ID)
    return project_id if project_id in known_project_ids(metadata) else NO_PROJECT_ID


def set_thread_project(metadata: dict[str, Any], thread_id: str, project_id: str) -> None:
    threads = metadata.setdefault("threads", {})
    entry = threads.setdefault(thread_id, {})
    if project_id == NO_PROJECT_ID:
        entry.pop("project_id", None)
    else:
        entry["project_id"] = project_id
    entry["updated_at"] = utc_iso()


def set_thread_starred(metadata: dict[str, Any], thread_id: str, starred: bool) -> None:
    threads = metadata.setdefault("threads", {})
    entry = threads.setdefault(thread_id, {})
    if starred:
        entry["starred"] = True
    else:
        entry.pop("starred", None)
    entry["updated_at"] = utc_iso()


def path_label(value: str) -> str:
    if not value:
        return "(no folder)"
    base = Path(value).name
    return base or value


def path_color(value: str) -> str:
    digest = hashlib.sha256(value.encode("utf-8", errors="replace")).hexdigest()
    hue = int(digest[:8], 16) % 360
    return f"hsl({hue} 58% 42%)"


def file_size(path_value: str) -> int | None:
    if not path_value:
        return None
    try:
        return Path(path_value).stat().st_size
    except OSError:
        return None


def session_index_titles(codex_home: Path) -> dict[str, str]:
    path = codex_home / "session_index.jsonl"
    if not path.exists():
        return {}

    titles: dict[str, str] = {}
    with path.open(encoding="utf-8", errors="replace") as fh:
        for line in fh:
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            thread_id = obj.get("id")
            title = obj.get("thread_name")
            if isinstance(thread_id, str) and isinstance(title, str) and title:
                titles[thread_id] = title
    return titles


def thread_columns(con: sqlite3.Connection) -> set[str]:
    return {row[1] for row in con.execute("pragma table_info(threads)").fetchall()}


def schema_payload(codex_home: Path) -> dict[str, Any]:
    db_path = find_state_db(codex_home)
    problems: list[str] = []
    details: dict[str, Any] = {
        "ok": False,
        "codex_home": str(codex_home),
        "db_path": str(db_path) if db_path else None,
        "session_index_path": str(codex_home / "session_index.jsonl"),
        "metadata_path": str(metadata_path()),
        "problems": problems,
    }

    if not codex_home.exists():
        problems.append(f"CODEX_HOME does not exist: {codex_home}")
    if db_path is None:
        problems.append("Could not find a usable state_*.sqlite database with a threads table.")
        return details

    with connect(db_path, readonly=True) as con:
        columns = thread_columns(con)
        missing = sorted(REQUIRED_THREAD_COLUMNS - columns)
        if missing:
            problems.append(f"threads table is missing required columns: {', '.join(missing)}")
        count = con.execute("select count(*) from threads").fetchone()[0]
        sample = con.execute("select id, rollout_path from threads order by updated_at_ms desc limit 1").fetchone()
        details["thread_count"] = count
        details["columns"] = sorted(columns)
        if sample:
            rollout = Path(sample[1])
            details["sample_thread_id"] = sample[0]
            details["sample_rollout_path"] = str(rollout)
            if not rollout.exists():
                problems.append(f"sample rollout path does not exist: {rollout}")

    details["ok"] = not problems
    return details


def assert_schema(codex_home: Path) -> Path:
    schema = schema_payload(codex_home)
    if not schema["ok"]:
        raise RuntimeError("; ".join(schema["problems"]))
    return Path(schema["db_path"])


def backup_state(codex_home: Path, db_path: Path, reason: str, extra_paths: list[Path] | None = None) -> str:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    safe_reason = "".join(ch if ch.isalnum() or ch in ("-", "_") else "-" for ch in reason).strip("-") or "state-change"
    backup_dir = organizer_home() / "backups" / f"{stamp}-{safe_reason}"
    backup_dir.mkdir(parents=True, exist_ok=False)

    candidates = [
        db_path,
        Path(str(db_path) + "-wal"),
        Path(str(db_path) + "-shm"),
        codex_home / "session_index.jsonl",
        *(extra_paths or []),
    ]
    for candidate in candidates:
        if candidate.exists():
            shutil.copy2(candidate, backup_dir / candidate.name)

    return str(backup_dir)


def archived_rollout_path(codex_home: Path, rollout_path: Path) -> Path:
    return codex_home / "archived_sessions" / rollout_path.name


def active_rollout_path(codex_home: Path, rollout_path: Path) -> Path:
    prefix = "rollout-"
    if not rollout_path.name.startswith(prefix):
        raise RuntimeError(f"Could not infer session date from rollout path: {rollout_path}")
    date_parts = rollout_path.name[len(prefix) :].split("T", 1)[0].split("-")
    if len(date_parts) != 3:
        raise RuntimeError(f"Could not infer session date from rollout path: {rollout_path}")
    year, month, day = date_parts
    return codex_home / "sessions" / year / month / day / rollout_path.name


def move_rollout_file(source: Path, target: Path) -> Path:
    if not source.exists():
        raise RuntimeError(f"Rollout file does not exist: {source}")
    if source == target:
        return target
    if target.exists():
        raise RuntimeError(f"Target rollout file already exists: {target}")
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(source), str(target))
    return target


def read_threads(codex_home: Path, *, include_archived: bool) -> list[dict[str, Any]]:
    db_path = assert_schema(codex_home)
    metadata = load_metadata()
    tag_map = metadata.get("threads", {})
    projects_by_id = {project["id"]: project for project in project_records(metadata)}
    titles_by_id = session_index_titles(codex_home)
    archived_clause = "" if include_archived else "where archived = 0"
    with connect(db_path, readonly=True) as con:
        columns = thread_columns(con)
        git_branch_select = "git_branch" if "git_branch" in columns else "'' as git_branch"
        query = f"""
            select
                id,
                title,
                cwd,
                rollout_path,
                archived,
                archived_at,
                updated_at,
                updated_at_ms,
                recency_at,
                recency_at_ms,
                first_user_message,
                preview,
                {git_branch_select}
            from threads
            {archived_clause}
            order by coalesce(nullif(recency_at_ms, 0), updated_at_ms, updated_at * 1000) desc
        """
        rows = con.execute(query).fetchall()

    threads: list[dict[str, Any]] = []
    for row in rows:
        thread_id = row[0]
        extra = tag_map.get(thread_id, {}) if isinstance(tag_map, dict) else {}
        tags = extra.get("tags", []) if isinstance(extra, dict) else []
        starred = bool(extra.get("starred")) if isinstance(extra, dict) else False
        project_id = project_id_for_thread(thread_id, metadata)
        project = projects_by_id.get(project_id) or projects_by_id[NO_PROJECT_ID]
        rollout_path = row[3]
        cwd = row[2]
        git_branch = str(row[12] or "").strip()
        threads.append(
            {
                "id": thread_id,
                "title": titles_by_id.get(thread_id) or row[1],
                "cwd": cwd,
                "cwd_label": path_label(cwd),
                "cwd_color": path_color(cwd),
                "rollout_path": rollout_path,
                "size_bytes": file_size(rollout_path),
                "archived": bool(row[4]),
                "archived_at": row[5],
                "updated_at": row[6],
                "updated_at_ms": row[7],
                "recency_at": row[8],
                "recency_at_ms": row[9],
                "first_user_message": row[10],
                "preview": row[11],
                "git_branch": git_branch,
                "git_branch_color": path_color(f"branch:{git_branch}") if git_branch else "",
                "tags": tags if isinstance(tags, list) else [],
                "starred": starred,
                "project_id": project_id,
                "project_name": project["name"],
            }
        )
    return threads


def text_from_value(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, (int, float, bool)):
        return str(value)
    if isinstance(value, list):
        return "\n".join(part for item in value if (part := text_from_value(item)))
    if isinstance(value, dict):
        parts: list[str] = []
        for key in ("text", "content", "message", "output", "summary", "name", "cmd"):
            if key in value:
                part = text_from_value(value[key])
                if part:
                    parts.append(part)
        if parts:
            return "\n".join(parts)
        return ""
    return ""


def text_from_event(obj: dict[str, Any]) -> str:
    if obj.get("type") == "session_meta":
        return ""
    payload = obj.get("payload")
    if isinstance(payload, dict):
        return text_from_value(payload)
    return text_from_value(payload)


def snippet(text: str, query: str) -> str:
    compact = " ".join(text.split())
    if not compact:
        return ""
    lower = compact.lower()
    index = lower.find(query.lower())
    if index == -1:
        return compact[:420]
    start = max(0, index - 150)
    end = min(len(compact), index + len(query) + 260)
    prefix = "..." if start > 0 else ""
    suffix = "..." if end < len(compact) else ""
    return prefix + compact[start:end] + suffix


def transcript_contains(path: Path, query: str) -> str | None:
    if not path.exists() or not query:
        return None
    lower_query = query.lower()
    try:
        with path.open(encoding="utf-8", errors="replace") as fh:
            for line in fh:
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    text = line
                else:
                    text = text_from_event(obj)
                if lower_query in text.lower():
                    return snippet(text, query)
    except OSError:
        return None
    return None


def filter_threads(threads: list[dict[str, Any]], query: str, *, search_content: bool) -> list[dict[str, Any]]:
    if not query:
        return threads
    lower_query = query.lower()
    matched: list[dict[str, Any]] = []
    for thread in threads:
        haystack_values = [
            thread.get("id", ""),
            thread.get("title", ""),
            thread.get("cwd", ""),
            thread.get("cwd_label", ""),
            thread.get("git_branch", ""),
            thread.get("project_name", ""),
            thread.get("first_user_message", ""),
            thread.get("preview", ""),
            " ".join(str(tag) for tag in thread.get("tags", [])),
        ]
        metadata_text = "\n".join(str(value) for value in haystack_values)
        match_snippet = ""
        if lower_query in metadata_text.lower():
            match_snippet = snippet(metadata_text, query)
        elif search_content:
            match_snippet = transcript_contains(Path(thread["rollout_path"]), query) or ""

        if match_snippet:
            copy = dict(thread)
            copy["match"] = match_snippet
            matched.append(copy)
    return matched


def list_command(args: argparse.Namespace) -> dict[str, Any]:
    codex_home = codex_home_from_arg(args.codex_home)
    schema = schema_payload(codex_home)
    metadata = load_metadata()
    if not schema["ok"]:
        return {"ok": False, "schema": schema, "projects": project_records(metadata), "threads": []}
    threads = read_threads(codex_home, include_archived=args.include_archived)
    threads = filter_threads(threads, args.query or "", search_content=args.search_content)
    if args.limit:
        threads = threads[: args.limit]
    return {
        "ok": True,
        "schema": schema,
        "projects": project_records(metadata),
        "threads": threads,
        "query": args.query or "",
    }


def rewrite_session_index(codex_home: Path, thread_id: str, title: str, updated_at: str) -> bool:
    path = codex_home / "session_index.jsonl"
    if not path.exists():
        return False

    changed = False
    lines: list[str] = []
    with path.open(encoding="utf-8") as fh:
        for line in fh:
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                lines.append(line)
                continue
            if obj.get("id") == thread_id:
                obj["thread_name"] = title
                obj["updated_at"] = updated_at
                changed = True
                lines.append(json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + "\n")
            else:
                lines.append(line)

    if changed:
        path.write_text("".join(lines), encoding="utf-8")
    return changed


def remove_from_session_index(codex_home: Path, thread_id: str) -> bool:
    path = codex_home / "session_index.jsonl"
    if not path.exists():
        return False

    changed = False
    lines: list[str] = []
    with path.open(encoding="utf-8") as fh:
        for line in fh:
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                lines.append(line)
                continue
            if obj.get("id") == thread_id:
                changed = True
                continue
            lines.append(line)

    if changed:
        path.write_text("".join(lines), encoding="utf-8")
    return changed


def rename_command(args: argparse.Namespace) -> dict[str, Any]:
    codex_home = codex_home_from_arg(args.codex_home)
    db_path = assert_schema(codex_home)
    title = args.title.strip()
    if not title:
        raise RuntimeError("Title cannot be empty.")
    backup_dir = backup_state(codex_home, db_path, "rename")
    now_s, now_ms, iso = now_parts()
    with connect(db_path, readonly=False) as con:
        con.execute("begin immediate")
        row = con.execute("select id from threads where id = ?", (args.thread_id,)).fetchone()
        if row is None:
            raise RuntimeError(f"Unknown thread id: {args.thread_id}")
        con.execute(
            """
            update threads
            set title = ?,
                updated_at = ?,
                updated_at_ms = ?,
                recency_at = ?,
                recency_at_ms = ?
            where id = ?
            """,
            (title, now_s, now_ms, now_s, now_ms, args.thread_id),
        )
        con.commit()
    index_updated = rewrite_session_index(codex_home, args.thread_id, title, iso)
    return {"ok": True, "backup_dir": backup_dir, "session_index_updated": index_updated}


def archive_command(args: argparse.Namespace) -> dict[str, Any]:
    codex_home = codex_home_from_arg(args.codex_home)
    db_path = assert_schema(codex_home)
    now_s, now_ms, _iso = now_parts()
    archived = 1 if args.archived else 0
    archived_at = now_s if args.archived else None
    with connect(db_path, readonly=False) as con:
        con.execute("begin immediate")
        row = con.execute("select id, rollout_path from threads where id = ?", (args.thread_id,)).fetchone()
        if row is None:
            raise RuntimeError(f"Unknown thread id: {args.thread_id}")
        current_rollout_path = Path(row[1])
        target_rollout_path = (
            archived_rollout_path(codex_home, current_rollout_path)
            if args.archived
            else active_rollout_path(codex_home, current_rollout_path)
        )
        backup_dir = backup_state(
            codex_home,
            db_path,
            "archive" if args.archived else "unarchive",
            extra_paths=[current_rollout_path],
        )
        move_rollout_file(current_rollout_path, target_rollout_path)
        con.execute(
            """
            update threads
            set archived = ?,
                archived_at = ?,
                updated_at = ?,
                updated_at_ms = ?,
                rollout_path = ?
            where id = ?
            """,
            (archived, archived_at, now_s, now_ms, str(target_rollout_path), args.thread_id),
        )
        con.commit()
    return {"ok": True, "backup_dir": backup_dir, "archived": bool(archived), "rollout_path": str(target_rollout_path)}


def delete_thread_command(args: argparse.Namespace) -> dict[str, Any]:
    codex_home = codex_home_from_arg(args.codex_home)
    db_path = assert_schema(codex_home)
    with connect(db_path, readonly=False) as con:
        con.execute("begin immediate")
        row = con.execute("select id, rollout_path from threads where id = ?", (args.thread_id,)).fetchone()
        if row is None:
            raise RuntimeError(f"Unknown thread id: {args.thread_id}")
        rollout_path = Path(row[1])
        backup_dir = backup_state(codex_home, db_path, "delete-thread", extra_paths=[rollout_path])
        con.execute("delete from threads where id = ?", (args.thread_id,))
        con.commit()
    if rollout_path.exists():
        rollout_path.unlink()

    metadata = load_metadata()
    threads = metadata.setdefault("threads", {})
    if isinstance(threads, dict):
        threads.pop(args.thread_id, None)
        save_metadata(metadata)

    index_updated = remove_from_session_index(codex_home, args.thread_id)
    return {"ok": True, "backup_dir": backup_dir, "session_index_updated": index_updated}


def set_tags_command(args: argparse.Namespace) -> dict[str, Any]:
    tags = sorted({tag.strip() for tag in args.tags.split(",") if tag.strip()})
    metadata = load_metadata()
    threads = metadata.setdefault("threads", {})
    entry = threads.setdefault(args.thread_id, {})
    entry["tags"] = tags
    entry["updated_at"] = utc_iso()
    save_metadata(metadata)
    return {"ok": True, "tags": tags, "metadata_path": str(metadata_path())}


def set_star_command(args: argparse.Namespace) -> dict[str, Any]:
    codex_home = codex_home_from_arg(args.codex_home)
    db_path = assert_schema(codex_home)
    with connect(db_path, readonly=True) as con:
        row = con.execute("select id from threads where id = ?", (args.thread_id,)).fetchone()
    if row is None:
        raise RuntimeError(f"Unknown thread id: {args.thread_id}")
    metadata = load_metadata()
    starred = args.starred == "true"
    set_thread_starred(metadata, args.thread_id, starred)
    save_metadata(metadata)
    return {"ok": True, "thread_id": args.thread_id, "starred": starred}


def create_project_command(args: argparse.Namespace) -> dict[str, Any]:
    name = args.name.strip()
    if not name:
        raise RuntimeError("Project name cannot be empty.")
    metadata = load_metadata()
    projects = metadata.setdefault("projects", {})
    project_id = f"project-{uuid.uuid4().hex}"
    now = utc_iso()
    projects[project_id] = {"name": name, "created_at": now, "updated_at": now}
    save_metadata(metadata)
    return {"ok": True, "project": {"id": project_id, "name": name, "created_at": now, "updated_at": now, "builtin": False}}


def rename_project_command(args: argparse.Namespace) -> dict[str, Any]:
    if args.project_id == NO_PROJECT_ID:
        raise RuntimeError("The No Project section cannot be renamed.")
    name = args.name.strip()
    if not name:
        raise RuntimeError("Project name cannot be empty.")
    metadata = load_metadata()
    projects = metadata.setdefault("projects", {})
    project = projects.get(args.project_id)
    if not isinstance(project, dict):
        raise RuntimeError(f"Unknown project id: {args.project_id}")
    project["name"] = name
    project["updated_at"] = utc_iso()
    save_metadata(metadata)
    return {"ok": True, "project": {"id": args.project_id, "name": name, **project, "builtin": False}}


def delete_project_command(args: argparse.Namespace) -> dict[str, Any]:
    if args.project_id == NO_PROJECT_ID:
        raise RuntimeError("The No Project section cannot be deleted.")
    metadata = load_metadata()
    projects = metadata.setdefault("projects", {})
    if args.project_id not in projects:
        raise RuntimeError(f"Unknown project id: {args.project_id}")
    del projects[args.project_id]
    moved = 0
    threads = metadata.setdefault("threads", {})
    if isinstance(threads, dict):
        for entry in threads.values():
            if isinstance(entry, dict) and entry.get("project_id") == args.project_id:
                entry.pop("project_id", None)
                entry["updated_at"] = utc_iso()
                moved += 1
    save_metadata(metadata)
    return {"ok": True, "deleted_project_id": args.project_id, "moved_to_no_project": moved}


def move_thread_command(args: argparse.Namespace) -> dict[str, Any]:
    codex_home = codex_home_from_arg(args.codex_home)
    db_path = assert_schema(codex_home)
    metadata = load_metadata()
    project_id = args.project_id or NO_PROJECT_ID
    if project_id not in known_project_ids(metadata):
        raise RuntimeError(f"Unknown project id: {project_id}")
    with connect(db_path, readonly=True) as con:
        row = con.execute("select id from threads where id = ?", (args.thread_id,)).fetchone()
    if row is None:
        raise RuntimeError(f"Unknown thread id: {args.thread_id}")
    set_thread_project(metadata, args.thread_id, project_id)
    save_metadata(metadata)
    return {"ok": True, "thread_id": args.thread_id, "project_id": project_id}


def move_threads_command(args: argparse.Namespace) -> dict[str, Any]:
    codex_home = codex_home_from_arg(args.codex_home)
    db_path = assert_schema(codex_home)
    metadata = load_metadata()
    project_id = args.project_id or NO_PROJECT_ID
    if project_id not in known_project_ids(metadata):
        raise RuntimeError(f"Unknown project id: {project_id}")
    thread_ids = [thread_id.strip() for thread_id in args.thread_ids.split(",") if thread_id.strip()]
    if not thread_ids:
        return {"ok": True, "moved": 0, "project_id": project_id}
    placeholders = ",".join("?" for _ in thread_ids)
    with connect(db_path, readonly=True) as con:
        rows = con.execute(f"select id from threads where id in ({placeholders})", thread_ids).fetchall()
    known_thread_ids = {row[0] for row in rows}
    missing = sorted(set(thread_ids) - known_thread_ids)
    if missing:
        raise RuntimeError(f"Unknown thread id(s): {', '.join(missing)}")
    for thread_id in thread_ids:
        set_thread_project(metadata, thread_id, project_id)
    save_metadata(metadata)
    return {"ok": True, "moved": len(thread_ids), "project_id": project_id}


def role_heading(role: str) -> str:
    labels = {
        "user": "User",
        "assistant": "Assistant",
        "system": "System",
        "tool": "Tool",
    }
    return labels.get(role, role.title() if role else "Event")


def transcript_markdown(codex_home: Path, thread_id: str) -> str:
    matches = [thread for thread in read_threads(codex_home, include_archived=True) if thread["id"] == thread_id]
    if not matches:
        raise RuntimeError(f"Unknown thread id: {thread_id}")
    thread = matches[0]
    path = Path(thread["rollout_path"])
    lines = [
        f"# {thread['title']}",
        "",
        f"- Session: `{thread['id']}`",
        f"- CWD: `{thread['cwd']}`",
        f"- Archived: `{thread['archived']}`",
        f"- Rollout: `{thread['rollout_path']}`",
        "",
    ]

    if not path.exists():
        lines.append("_Transcript file is missing._")
        return "\n".join(lines) + "\n"

    with path.open(encoding="utf-8", errors="replace") as fh:
        for line in fh:
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if obj.get("type") == "session_meta":
                continue
            payload = obj.get("payload")
            if not isinstance(payload, dict):
                continue
            role = str(payload.get("role") or payload.get("type") or obj.get("type") or "event")
            text = text_from_value(payload.get("content"))
            if not text and payload.get("type") in {"function_call", "function_call_output"}:
                text = json.dumps(payload, ensure_ascii=False, indent=2)
            if not text:
                continue
            lines.extend([f"## {role_heading(role)}", "", text.rstrip(), ""])

    return "\n".join(lines).rstrip() + "\n"


def transcript_command(args: argparse.Namespace) -> dict[str, Any]:
    codex_home = codex_home_from_arg(args.codex_home)
    assert_schema(codex_home)
    return {"ok": True, "markdown": transcript_markdown(codex_home, args.thread_id)}


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--codex-home", default=None)
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("schema")

    list_parser = subparsers.add_parser("list")
    list_parser.add_argument("--include-archived", action="store_true")
    list_parser.add_argument("--query", default="")
    list_parser.add_argument("--search-content", action="store_true")
    list_parser.add_argument("--limit", type=int, default=250)

    rename_parser = subparsers.add_parser("rename")
    rename_parser.add_argument("--thread-id", required=True)
    rename_parser.add_argument("--title", required=True)

    archive_parser = subparsers.add_parser("archive")
    archive_parser.add_argument("--thread-id", required=True)
    archive_parser.add_argument("--archived", choices=("true", "false"), required=True)

    delete_thread_parser = subparsers.add_parser("delete-thread")
    delete_thread_parser.add_argument("--thread-id", required=True)

    tags_parser = subparsers.add_parser("set-tags")
    tags_parser.add_argument("--thread-id", required=True)
    tags_parser.add_argument("--tags", default="")

    star_parser = subparsers.add_parser("set-star")
    star_parser.add_argument("--thread-id", required=True)
    star_parser.add_argument("--starred", choices=("true", "false"), required=True)

    create_project_parser = subparsers.add_parser("create-project")
    create_project_parser.add_argument("--name", required=True)

    rename_project_parser = subparsers.add_parser("rename-project")
    rename_project_parser.add_argument("--project-id", required=True)
    rename_project_parser.add_argument("--name", required=True)

    delete_project_parser = subparsers.add_parser("delete-project")
    delete_project_parser.add_argument("--project-id", required=True)

    move_thread_parser = subparsers.add_parser("move-thread")
    move_thread_parser.add_argument("--thread-id", required=True)
    move_thread_parser.add_argument("--project-id", default=NO_PROJECT_ID)

    move_threads_parser = subparsers.add_parser("move-threads")
    move_threads_parser.add_argument("--thread-ids", required=True)
    move_threads_parser.add_argument("--project-id", default=NO_PROJECT_ID)

    transcript_parser = subparsers.add_parser("transcript")
    transcript_parser.add_argument("--thread-id", required=True)

    args = parser.parse_args(argv)
    try:
        codex_home = codex_home_from_arg(args.codex_home)
        if args.command == "schema":
            payload = schema_payload(codex_home)
        elif args.command == "list":
            payload = list_command(args)
        elif args.command == "rename":
            payload = rename_command(args)
        elif args.command == "archive":
            args.archived = args.archived == "true"
            payload = archive_command(args)
        elif args.command == "delete-thread":
            payload = delete_thread_command(args)
        elif args.command == "set-tags":
            payload = set_tags_command(args)
        elif args.command == "set-star":
            payload = set_star_command(args)
        elif args.command == "create-project":
            payload = create_project_command(args)
        elif args.command == "rename-project":
            payload = rename_project_command(args)
        elif args.command == "delete-project":
            payload = delete_project_command(args)
        elif args.command == "move-thread":
            payload = move_thread_command(args)
        elif args.command == "move-threads":
            payload = move_threads_command(args)
        elif args.command == "transcript":
            payload = transcript_command(args)
        else:
            raise RuntimeError(f"Unsupported command: {args.command}")
    except Exception as exc:
        json_out({"ok": False, "error": str(exc)})
        return 1

    json_out(payload)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
