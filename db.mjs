import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDb(path = process.env.DB_PATH || './data/teamtime.sqlite') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;');
  db.exec(`
  CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',goal_date TEXT,timezone TEXT NOT NULL DEFAULT 'Asia/Seoul',invite_hash TEXT NOT NULL,invite_open INTEGER NOT NULL DEFAULT 1,version INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS members(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),nickname TEXT NOT NULL COLLATE NOCASE,role TEXT NOT NULL CHECK(role IN ('owner','member')),recovery_hash TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,UNIQUE(project_id,nickname));
  CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,member_id TEXT NOT NULL REFERENCES members(id),expires_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS schedules(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),member_id TEXT NOT NULL REFERENCES members(id),kind TEXT NOT NULL CHECK(kind IN ('weekly','date','sleep','avoid')),day INTEGER,date TEXT,start_min INTEGER NOT NULL,end_min INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN ('available','unavailable','avoid')),title TEXT NOT NULL DEFAULT '',color TEXT NOT NULL DEFAULT '#6b7280',share_title INTEGER NOT NULL DEFAULT 0,version INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS date_exceptions(member_id TEXT NOT NULL REFERENCES members(id),date TEXT NOT NULL,PRIMARY KEY(member_id,date));
  CREATE TABLE IF NOT EXISTS availability_confirmations(id TEXT PRIMARY KEY,member_id TEXT NOT NULL REFERENCES members(id),start_date TEXT NOT NULL,end_date TEXT NOT NULL,created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),parent_id TEXT REFERENCES tasks(id),creator_id TEXT NOT NULL REFERENCES members(id),lead_id TEXT REFERENCES members(id),title TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',priority TEXT NOT NULL DEFAULT 'normal',start_date TEXT,target_date TEXT,due_date TEXT,estimate REAL,link TEXT NOT NULL DEFAULT '',position INTEGER NOT NULL DEFAULT 0,version INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS roles(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),member_id TEXT REFERENCES members(id),description TEXT NOT NULL DEFAULT '',estimate REAL,status TEXT NOT NULL DEFAULT 'todo',version INTEGER NOT NULL DEFAULT 1,updated_at TEXT NOT NULL,updated_by TEXT REFERENCES members(id));
  CREATE TABLE IF NOT EXISTS meetings(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),title TEXT NOT NULL,agenda TEXT NOT NULL DEFAULT '',start_at TEXT NOT NULL,end_at TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'confirmed',version INTEGER NOT NULL DEFAULT 1,created_by TEXT NOT NULL REFERENCES members(id),updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS meeting_attendees(meeting_id TEXT NOT NULL REFERENCES meetings(id),member_id TEXT NOT NULL REFERENCES members(id),PRIMARY KEY(meeting_id,member_id));
  CREATE TABLE IF NOT EXISTS comments(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),member_id TEXT NOT NULL REFERENCES members(id),body TEXT NOT NULL,created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS notifications(id TEXT PRIMARY KEY,member_id TEXT NOT NULL REFERENCES members(id),event_key TEXT NOT NULL,body TEXT NOT NULL,created_at TEXT NOT NULL,read_at TEXT,UNIQUE(member_id,event_key));
  CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),member_id TEXT REFERENCES members(id),entity TEXT NOT NULL,entity_id TEXT NOT NULL,action TEXT NOT NULL,detail TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS preferences(member_id TEXT PRIMARY KEY REFERENCES members(id),data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS idempotency(scope TEXT NOT NULL,key TEXT NOT NULL,response TEXT NOT NULL,cookie TEXT,status INTEGER NOT NULL,PRIMARY KEY(scope,key));
  CREATE INDEX IF NOT EXISTS schedules_member ON schedules(member_id);
  CREATE INDEX IF NOT EXISTS tasks_project ON tasks(project_id);
  CREATE INDEX IF NOT EXISTS notifications_member ON notifications(member_id);
  `);
  db.exec("DELETE FROM idempotency WHERE scope='create'");
  return db;
}
