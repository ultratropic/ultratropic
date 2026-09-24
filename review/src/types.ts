export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  ASSETS: Fetcher;
  ADMIN_PASSWORD: string;
  COOKIE_SECRET: string;
  /** Default display name for the owner's selects, e.g. the studio name. */
  ADMIN_NAME: string;
}

export interface AdminSession {
  admin: true;
  exp: number;
}

/**
 * One per project, in its own cookie, so reviewing two shoots in the same
 * browser doesn't sign you out of the first.
 */
export interface ReviewerSession {
  rid: string; // reviewer id
  pid: string; // project id
  /** Joined through the project link: every album is visible. */
  all: boolean;
  /** Albums unlocked through client album links. Ignored when `all` is set. */
  albums: string[];
  exp: number;
}

export type Vars = {
  admin?: AdminSession;
};
