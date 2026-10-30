-- Sign-in links for the public product. Only a hash of the token is stored, so
-- a copy of the database can't be used to sign in. Each link works once and
-- expires; old rows are kept briefly for the per-address rate limit.
CREATE TABLE login_links (
  token_hash TEXT PRIMARY KEY,
  email_norm TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER
);
CREATE INDEX idx_login_links_email ON login_links(email_norm, created_at);
