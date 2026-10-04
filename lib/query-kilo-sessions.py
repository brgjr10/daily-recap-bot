#!/usr/bin/env python3
"""
Query the Kilo SQLite DB for sessions active on a given day.
Outputs JSON to stdout for the Node standup script to consume.

Usage:
  python lib/query-kilo-sessions.py --date 2026-10-02 [--db PATH]
"""
import argparse
import json
import os
import sqlite3
import sys
from datetime import datetime, timezone

DEFAULT_DB = os.path.join(os.path.expanduser('~'), '.local', 'share', 'kilo', 'kilo.db')


def day_bounds(date_str):
    d = datetime.strptime(date_str, '%Y-%m-%d')
    start = int(datetime(d.year, d.month, d.day, tzinfo=timezone.utc).timestamp() * 1000)
    end = int(datetime(d.year, d.month, d.day + 1, tzinfo=timezone.utc).timestamp() * 1000)
    return start, end


def get_text(msg_data):
    """Extract human-readable text from a Kilo message/part payload."""
    if not isinstance(msg_data, dict):
        return None
    role = msg_data.get('role')
    if role == 'user':
        summary = msg_data.get('summary') or {}
        text = summary.get('text') or msg_data.get('text') or ''
        if isinstance(text, list):
            return ' '.join(str(x) for x in text).strip() or None
        return str(text).strip() or None
    if role == 'assistant':
        parts = msg_data.get('parts') or []
        texts = []
        for p in parts:
            if not isinstance(p, dict):
                continue
            if p.get('type') == 'text':
                t = p.get('text') or ''
                if isinstance(t, list):
                    t = ' '.join(str(x) for x in t)
                texts.append(str(t).strip())
        return '\n'.join(texts).strip() or None
    return None


def get_file_edits(parts):
    """Return file paths touched by write/edit tool calls in this message."""
    edits = []
    if not isinstance(parts, list):
        return edits
    for p in parts:
        if not isinstance(p, dict):
            continue
        if p.get('type') != 'tool':
            continue
        state = p.get('state') or {}
        inp = state.get('input') or {}
        tool = p.get('tool') or ''
        if tool.lower() in ('write', 'edit', 'notebookedit', 'multiedit'):
            fp = inp.get('filePath') or inp.get('file_path') or inp.get('path')
            if fp:
                edits.append(str(fp))
        elif tool.lower() == 'bash':
            cmd = str(inp.get('command', ''))
            for token in cmd.split():
                if token.startswith('~') or '/' in token or '\\' in token:
                    if any(token.endswith(ext) for ext in ('.py', '.js', '.ts', '.md', '.json', '.css', '.html', '.mjs')):
                        edits.append(token)
    return edits


def get_finish(msg_data):
    return msg_data.get('finish') or {}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--date', required=True)
    ap.add_argument('--db', default=DEFAULT_DB)
    args = ap.parse_args()

    if not os.path.exists(args.db):
        print(json.dumps({'error': f'db not found: {args.db}', 'sessions': []}))
        return

    start_ms, end_ms = day_bounds(args.date)
    con = sqlite3.connect(args.db)
    con.execute('PRAGMA journal_mode=WAL')
    con.execute('PRAGMA busy_timeout=5000')
    cur = con.cursor()

    # Candidate sessions: created/updated in the day, or with messages in the day.
    cur.execute(
        '''SELECT s.id, s.project_id, s.title, s.directory, s.time_created, s.time_updated,
                  p.name as project_name
           FROM session s
           LEFT JOIN project p ON p.id = s.project_id
           WHERE (s.time_created >= ? AND s.time_created < ?)
              OR (s.time_updated >= ? AND s.time_updated < ?)
              OR EXISTS (SELECT 1 FROM message m
                         WHERE m.session_id = s.id
                           AND m.time_created >= ? AND m.time_created < ?)
        ''',
        (start_ms, end_ms, start_ms, end_ms, start_ms, end_ms),
    )
    rows = cur.fetchall()
    session_ids = [r[0] for r in rows]
    meta = {r[0]: r for r in rows}

    sessions = []

    if session_ids:
        ph = ','.join('?' * len(session_ids))
        cur.execute(
            f'SELECT id, session_id, time_created, data FROM message '
            f'WHERE session_id IN ({ph}) AND time_created >= ? AND time_created < ? '
            f'ORDER BY session_id, time_created',
            (*session_ids, start_ms, end_ms),
        )
        msgs = cur.fetchall()

        # Fetch parts for all these messages in one query
        msg_ids = [m[0] for m in msgs]
        parts_by_msg = {}
        if msg_ids:
            ph2 = ','.join('?' * len(msg_ids))
            cur.execute(
                f'SELECT message_id, data FROM part WHERE message_id IN ({ph2}) ORDER BY time_created',
                msg_ids,
            )
            for msg_id, raw in cur.fetchall():
                parts_by_msg.setdefault(msg_id, []).append(
                    json.loads(raw) if isinstance(raw, str)
                    else json.loads(raw) if isinstance(raw, bytes)
                    else raw
                )

        # Fetch todos for candidate sessions
        cur.execute(
            f'SELECT session_id, content, status, priority, time_created '
            f'FROM todo WHERE session_id IN ({ph}) AND status != ? ORDER BY time_created',
            (*session_ids, 'completed'),
        )
        todos = cur.fetchall()
        todos_by_sid = {}
        for sid, content, status, priority, t in todos:
            todos_by_sid.setdefault(sid, []).append({
                'content': content, 'status': status, 'priority': priority, 'time_created': t
            })

        # Build per-session summary
        for sid, s in meta.items():
            session_msgs = [m for m in msgs if m[1] == sid]
            user_msgs = []
            assistant_msgs = []
            files_touched = set()
            first_ts = None
            last_ts = None
            topic = None
            last_turn_type = None
            last_user_text = None
            deferred = []
            interrupted = False

            for msg_id, _, ts, raw in session_msgs:
                data = json.loads(raw) if isinstance(raw, str) else json.loads(raw) if isinstance(raw, bytes) else raw
                role = data.get('role')
                parts = parts_by_msg.get(msg_id, [])

                if first_ts is None or ts < first_ts:
                    first_ts = ts
                if last_ts is None or ts > last_ts:
                    last_ts = ts

                if role == 'user':
                    text = get_text(data)
                    if text:
                        if not topic:
                            topic = text[:140]
                        last_user_text = text
                        last_turn_type = 'user'
                        for t in text.split('\n'):
                            if any(k in t.lower() for k in ['todo', 'next time', 'remember to', 'come back', 'not yet', 'still need', 'wip', 'in progress', 'unfinished', 'for later']):
                                deferred.append(t.strip())
                    # Interruption marker
                    if any('interrupted' in (p.get('text') or '').lower() for p in parts if isinstance(p, dict)):
                        interrupted = True
                        last_turn_type = 'user'

                elif role == 'assistant':
                    text = get_text(data)
                    if text:
                        assistant_msgs.append(text[:200])
                        last_turn_type = 'assistant'
                    for fp in get_file_edits(parts):
                        files_touched.add(fp)

            user_count = len(user_msgs)
            assistant_count = len(assistant_msgs)

            # Classify
            is_unfinished = last_turn_type == 'user' and (user_count > 0 or interrupted)
            is_discussed_only = (not is_unfinished) and len(files_touched) == 0 and (user_count + assistant_count) >= 4

            if not topic:
                topic = s[2] or '(untitled session)'

            sessions.append({
                'id': sid,
                'title': s[2],
                'directory': s[3],
                'project': s[6] or (os.path.basename(s[3].rstrip('/\\')) if s[3] else 'global'),
                'time_created': s[4],
                'time_updated': s[5],
                'topic': topic[:140],
                'user_msgs': user_count,
                'assistant_msgs': assistant_count,
                'files_touched': sorted(files_touched),
                'first_ts': first_ts,
                'last_ts': last_ts,
                'unfinished': is_unfinished,
                'discussed_only': is_discussed_only,
                'interrupted': interrupted,
                'last_user_text': (last_user_text or '')[:140] if last_user_text else None,
                'deferred': deferred[:5],
                'todos': todos_by_sid.get(sid, []),
            })

    result = {
        'date': args.date,
        'db': args.db,
        'count': len(sessions),
        'sessions': sessions,
    }
    json.dump(result, sys.stdout, ensure_ascii=False, indent=2)
    print()


if __name__ == '__main__':
    main()
