"""SQLite schema, transactional connections, and append-only audit events.

Each request/worker gets its own connection. Transactions commit together with
associated audit events and roll back if a use case fails.
"""
from __future__ import annotations

from contextlib import contextmanager
import json
import sqlite3
from .common import now


class Repository:
    def __init__(self, db_path):
        self.db_path = db_path

    @contextmanager
    def db(self):
        db = sqlite3.connect(self.db_path, timeout=15)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        db.execute("PRAGMA busy_timeout=15000")
        try:
            with db:
                yield db
        finally:
            db.close()

    def setup(self):
        with self.db() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.executescript("""
                CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY,name TEXT,path TEXT,duration REAL,width INTEGER,height INTEGER,has_audio INTEGER,segments TEXT,sha256 TEXT,created_at TEXT);
                CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY,asset_id TEXT,title TEXT,clips TEXT,format TEXT,burn_subtitles INTEGER,status TEXT,gates TEXT,error TEXT,output_path TEXT,created_at TEXT,updated_at TEXT);
                CREATE TABLE IF NOT EXISTS campaigns (id TEXT PRIMARY KEY,data TEXT,created_at TEXT,updated_at TEXT);
                CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT,event TEXT,entity_id TEXT,detail TEXT,created_at TEXT);
            """)

    def audit(self, event, entity_id=None, detail=None, db=None):
        if db is None:
            with self.db() as db:
                self.audit(event, entity_id, detail, db)
            return
        db.execute("INSERT INTO audit(event,entity_id,detail,created_at) VALUES(?,?,?,?)",
                   (event, entity_id, json.dumps(detail or {}, ensure_ascii=False), now()))
