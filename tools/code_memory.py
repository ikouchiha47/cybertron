#!/usr/bin/env python3
"""
code_memory.py — layered code knowledge base for Claude Code hooks.

Hook modes (read stdin JSON from Claude Code):
  PreToolUse  on Read:      serve cached tree if hash matches → blocks file read
  PostToolUse on Read:      detect hash change → emit systemMessage asking Claude
                            to update the tree
  PostToolUse on Write/Edit: mark file as dirty (hash will mismatch on next read)

CLI modes:
  python3 tools/code_memory.py init <file>         create skeleton entry
  python3 tools/code_memory.py init-all            scan project and init all source files
  python3 tools/code_memory.py status              show stale/fresh/missing entries
  python3 tools/code_memory.py diff <file>         show last stored diff for a file
"""

import sys
import json
import os
import re
import hashlib
import subprocess
from pathlib import Path
from datetime import datetime, timezone

# ── Paths ─────────────────────────────────────────────────────────────────────

SCRIPT_DIR   = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent
MEMORY_DIR   = PROJECT_ROOT / ".claude" / "code-memory"
DIFF_DIR     = MEMORY_DIR / "diffs"

SOURCE_EXTENSIONS = {".ts", ".tsx", ".cpp", ".h", ".c", ".ino", ".py", ".md"}
IGNORE_DIRS = {"node_modules", "android", "ios", ".git", "__pycache__", "build", "dist",
               ".claude", ".kilo", "tmp", "docs"}

# ── Hashing ───────────────────────────────────────────────────────────────────

def file_hash(path: Path) -> str:
    h = hashlib.sha256()
    try:
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(65536), b""):
                h.update(chunk)
        return h.hexdigest()[:16]
    except OSError:
        return ""

# ── Cache path ────────────────────────────────────────────────────────────────

def cache_path(file_path: Path) -> Path:
    try:
        rel = file_path.relative_to(PROJECT_ROOT)
    except ValueError:
        rel = file_path
    slug = str(rel).replace("/", "__").replace("\\", "__").replace(" ", "_")
    return MEMORY_DIR / f"{slug}.md"

def diff_dir(file_path: Path) -> Path:
    try:
        rel = file_path.relative_to(PROJECT_ROOT)
    except ValueError:
        rel = file_path
    slug = str(rel).replace("/", "__").replace("\\", "__").replace(" ", "_")
    return DIFF_DIR / slug

# ── Cache read/write ──────────────────────────────────────────────────────────

def read_cache(cache: Path) -> dict:
    """Return dict with at least {hash, summary_text} from cache file."""
    if not cache.exists():
        return {}
    text = cache.read_text(encoding="utf-8")
    result = {"raw": text}
    m = re.search(r"^hash:\s*(\S+)", text, re.MULTILINE)
    if m:
        result["hash"] = m.group(1)
    return result

def write_skeleton(file_path: Path, current_hash: str, git_commit: str) -> None:
    """Create a skeleton entry — Claude fills in the summary later."""
    cache = cache_path(file_path)
    cache.parent.mkdir(parents=True, exist_ok=True)
    try:
        rel = str(file_path.relative_to(PROJECT_ROOT))
    except ValueError:
        rel = str(file_path)
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    content = f"""---
file: {rel}
hash: {current_hash}
last_indexed: {now}
last_git_commit: {git_commit}
---

## File Summary
<!-- Claude: replace this with a 2-3 sentence description of what this file does -->
(not yet summarized)

## Symbol Tree
<!-- Claude: replace with a structured tree of classes/functions/constants with line numbers -->
(not yet indexed)

## Change Log
- {now} | {git_commit} | skeleton created
"""
    cache.write_text(content, encoding="utf-8")

# ── Git helpers ───────────────────────────────────────────────────────────────

def git_last_commit(file_path: Path) -> str:
    try:
        result = subprocess.run(
            ["git", "log", "--oneline", "-1", "--", str(file_path)],
            capture_output=True, text=True, cwd=PROJECT_ROOT, timeout=5
        )
        return result.stdout.strip() or "unknown"
    except Exception:
        return "unknown"

def git_diff_for_file(file_path: Path, old_hash: str) -> str:
    """Get unified diff from git for this file vs HEAD."""
    try:
        result = subprocess.run(
            ["git", "diff", "HEAD", "--", str(file_path)],
            capture_output=True, text=True, cwd=PROJECT_ROOT, timeout=10
        )
        diff = result.stdout.strip()
        if not diff:
            result = subprocess.run(
                ["git", "diff", "HEAD~1", "HEAD", "--", str(file_path)],
                capture_output=True, text=True, cwd=PROJECT_ROOT, timeout=10
            )
            diff = result.stdout.strip()
        return diff or "(no git diff available — file may have uncommitted changes)"
    except Exception:
        return "(git diff failed)"

def store_diff(file_path: Path, diff_text: str, new_hash: str) -> Path:
    d = diff_dir(file_path)
    d.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
    diff_file = d / f"{ts}_{new_hash[:8]}.diff"
    diff_file.write_text(diff_text, encoding="utf-8")
    return diff_file

# ── Hook output helpers ───────────────────────────────────────────────────────

def hook_out(obj: dict) -> None:
    print(json.dumps(obj))

def allow() -> None:
    hook_out({"continue": True})

def hint_with_cache(summary: str) -> None:
    """Allow the Read but inject the cached tree as a system message hint."""
    hook_out({
        "continue": True,
        "systemMessage": summary,
    })

# ── Pre-tool-use handler ───────────────────────────────────────────────────────

def handle_pre(tool_input: dict) -> None:
    file_path_str = tool_input.get("file_path", "")
    if not file_path_str:
        allow()
        return

    path = Path(file_path_str).resolve()
    # Don't intercept reads of the memory cache itself or project tooling
    try:
        rel = path.relative_to(PROJECT_ROOT)
        if str(rel).startswith(".claude") or str(rel).startswith("tools/code_memory"):
            allow()
            return
    except ValueError:
        pass

    if not path.exists() or path.suffix not in SOURCE_EXTENSIONS:
        allow()
        return

    cache = cache_path(path)
    cached = read_cache(cache)
    if not cached or "hash" not in cached:
        allow()
        return

    current = file_hash(path)
    if cached["hash"] != current:
        allow()
        return

    # Fresh cache — let the read proceed, inject tree as context hint
    try:
        rel = str(path.relative_to(PROJECT_ROOT))
    except ValueError:
        rel = str(path)

    msg = (
        f"[CodeMemory] cache hit for {rel} (hash {current}). "
        f"Cached symbol tree below — use it to avoid re-reading if sufficient:\n\n"
        f"{cached['raw']}"
    )
    hint_with_cache(msg)

# ── Post-tool-use handler ─────────────────────────────────────────────────────

def handle_post(tool_input: dict, event: str) -> None:
    file_path_str = tool_input.get("file_path", "")
    if not file_path_str:
        allow()
        return

    # For Write/Edit, just invalidate by noting the file is dirty
    path = Path(file_path_str).resolve()
    if not path.exists():
        allow()
        return

    if path.suffix not in SOURCE_EXTENSIONS:
        allow()
        return

    cache = cache_path(path)
    cached = read_cache(cache)
    current_hash = file_hash(path)

    if cached.get("hash") == current_hash:
        # Nothing changed
        allow()
        return

    # Hash changed — compute diff, store it, ask Claude to update the tree
    old_hash = cached.get("hash", "none")
    diff_text = git_diff_for_file(path, old_hash)
    diff_file = store_diff(path, diff_text, current_hash)
    git_commit = git_last_commit(path)

    try:
        rel = str(path.relative_to(PROJECT_ROOT))
    except ValueError:
        rel = str(path)

    cache_exists = "hash" in cached
    cache_note = f"Existing tree: {cache}\n" if cache_exists else f"No existing tree (new file). Cache: {cache}\n"

    diff_preview = diff_text[:3000] + ("\n...(truncated)" if len(diff_text) > 3000 else "")

    msg = (
        f"[CodeMemory] FILE CHANGED: {rel}\n"
        f"Old hash: {old_hash}  →  New hash: {current_hash}\n"
        f"Last git commit: {git_commit}\n"
        f"Diff stored at: {diff_file}\n"
        f"{cache_note}\n"
        f"ACTION REQUIRED: After processing this file, update the code memory tree at:\n"
        f"  {cache}\n\n"
        f"Update instructions:\n"
        f"  1. Update `hash:` to {current_hash}\n"
        f"  2. Update `last_indexed:` to now\n"
        f"  3. Update `last_git_commit:` to: {git_commit}\n"
        f"  4. Revise `## File Summary` if overall purpose changed\n"
        f"  5. Update `## Symbol Tree` — add/modify/remove entries for symbols that changed\n"
        f"     Each function/class entry: name, line range, brief purpose (1 line)\n"
        f"  6. Append to `## Change Log`: date | commit | what changed and why\n\n"
        f"Git diff (for context):\n"
        f"```diff\n{diff_preview}\n```"
    )

    hook_out({"continue": True, "systemMessage": msg})

# ── CLI: init ─────────────────────────────────────────────────────────────────

def cmd_init(file_path_str: str) -> None:
    path = Path(file_path_str).resolve()
    if not path.exists():
        print(f"ERROR: {file_path_str} not found", file=sys.stderr)
        sys.exit(1)
    h = file_hash(path)
    commit = git_last_commit(path)
    write_skeleton(path, h, commit)
    print(f"Created skeleton: {cache_path(path)}")

def cmd_init_all() -> None:
    count = 0
    for root, dirs, files in os.walk(PROJECT_ROOT):
        dirs[:] = [d for d in dirs if d not in IGNORE_DIRS]
        for name in files:
            p = Path(root) / name
            if p.suffix in SOURCE_EXTENSIONS:
                cache = cache_path(p)
                if not cache.exists():
                    h = file_hash(p)
                    commit = git_last_commit(p)
                    write_skeleton(p, h, commit)
                    print(f"  init: {p.relative_to(PROJECT_ROOT)}")
                    count += 1
    print(f"\nInitialized {count} new skeleton entries.")

def cmd_status() -> None:
    print(f"{'Status':<8} {'File':<60} {'Cached Hash':<18} {'Current Hash':<18}")
    print("-" * 106)
    for root, dirs, files in os.walk(PROJECT_ROOT):
        dirs[:] = [d for d in dirs if d not in IGNORE_DIRS]
        for name in files:
            p = Path(root) / name
            if p.suffix not in SOURCE_EXTENSIONS:
                continue
            cache = cache_path(p)
            cached = read_cache(cache)
            current = file_hash(p)
            if not cached:
                status = "MISSING"
                cached_h = "-"
            elif cached.get("hash") == current:
                status = "FRESH"
                cached_h = cached["hash"]
            else:
                status = "STALE"
                cached_h = cached.get("hash", "-")
            try:
                rel = str(p.relative_to(PROJECT_ROOT))
            except ValueError:
                rel = str(p)
            print(f"{status:<8} {rel:<60} {cached_h:<18} {current:<18}")

def cmd_diff(file_path_str: str) -> None:
    path = Path(file_path_str).resolve()
    d = diff_dir(path)
    if not d.exists():
        print("No diffs stored for this file.")
        return
    diffs = sorted(d.iterdir(), reverse=True)
    if not diffs:
        print("No diffs stored for this file.")
        return
    latest = diffs[0]
    print(f"Latest diff: {latest}\n")
    print(latest.read_text(encoding="utf-8"))

# ── Entry point ───────────────────────────────────────────────────────────────

def main() -> None:
    if len(sys.argv) >= 2 and sys.argv[1] in ("init", "init-all", "status", "diff"):
        cmd = sys.argv[1]
        if cmd == "init":
            if len(sys.argv) < 3:
                print("Usage: code_memory.py init <file>", file=sys.stderr)
                sys.exit(1)
            cmd_init(sys.argv[2])
        elif cmd == "init-all":
            cmd_init_all()
        elif cmd == "status":
            cmd_status()
        elif cmd == "diff":
            if len(sys.argv) < 3:
                print("Usage: code_memory.py diff <file>", file=sys.stderr)
                sys.exit(1)
            cmd_diff(sys.argv[2])
        return

    # Hook mode — read JSON from stdin
    try:
        data = json.load(sys.stdin)
    except (json.JSONDecodeError, EOFError):
        allow()
        return

    event      = data.get("hook_event_name", "")
    tool_name  = data.get("tool_name", "")
    tool_input = data.get("tool_input", {})

    if event == "PreToolUse" and tool_name == "Read":
        handle_pre(tool_input)
    elif event == "PostToolUse" and tool_name in ("Read", "Write", "Edit", "MultiEdit"):
        handle_post(tool_input, event)
    else:
        allow()


if __name__ == "__main__":
    main()
