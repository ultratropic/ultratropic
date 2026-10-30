-- Accounts. Every project belongs to a workspace, and the owner's routes only
-- reach projects in the signed-in person's workspace. The internal deployment
-- has exactly one workspace ('internal') that its admin password signs into;
-- the public deployment has one per customer.
CREATE TABLE workspaces (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  plan       TEXT NOT NULL DEFAULT 'free',
  created_at INTEGER NOT NULL
);

-- People who own or help run projects (reviewers stay per project, no account).
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email_norm    TEXT NOT NULL UNIQUE,
  name          TEXT,
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE TABLE members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         TEXT NOT NULL DEFAULT 'owner',
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX idx_members_user ON members(user_id);

ALTER TABLE projects ADD COLUMN workspace_id TEXT REFERENCES workspaces(id);
CREATE INDEX idx_projects_workspace ON projects(workspace_id, created_at);

-- A team member's own picks in a project: the reviewer row that is them.
-- Replaces the single shared '__admin__' identity, so two people running a
-- project no longer merge their picks.
ALTER TABLE reviewers ADD COLUMN user_id TEXT REFERENCES users(id);

-- Uploaded derivatives, recorded at upload so a commit can only use keys its
-- own workspace uploaded, and so storage can be counted per workspace.
CREATE TABLE blobs (
  key          TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  bytes        INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_blobs_workspace ON blobs(workspace_id);

-- Everything that exists today is the internal workspace's, run by its owner.
INSERT INTO workspaces (id, name, plan, created_at) VALUES ('internal', 'Ultratropic', 'internal', 0);
INSERT INTO users (id, email_norm, name, created_at) VALUES ('owner', '__owner__', 'Ultratropic', 0);
INSERT INTO members (workspace_id, user_id, role, created_at) VALUES ('internal', 'owner', 'owner', 0);
UPDATE projects SET workspace_id = 'internal';
UPDATE reviewers SET user_id = 'owner' WHERE email_norm = '__admin__';
