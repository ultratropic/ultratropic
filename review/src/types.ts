export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  ASSETS: Fetcher;
  /**
   * 'internal': the studio's own deployment — one workspace, signed into with
   * ADMIN_PASSWORD, no billing. 'public': the product — one workspace per
   * customer, email sign-in. Same code either way.
   */
  MODE: 'internal' | 'public';
  ADMIN_PASSWORD: string;
  COOKIE_SECRET: string;
  /** Default display name for the owner's selects, e.g. the studio name. */
  ADMIN_NAME: string;
  LOGIN_LIMIT: RateLimit;
  UNLOCK_LIMIT: RateLimit;
  /** Public product: its name in the UI and emails (e.g. "Dumbox"). */
  PRODUCT_NAME?: string;
  /** Public product: transactional email (sign-in links). */
  EMAIL?: SendEmail;
  MAIL_FROM?: string;
  /**
   * Invite-only sign-up: comma-separated addresses (or "@domain.com") allowed
   * to create an account. Unset = anyone may sign up. Existing accounts can
   * always sign in.
   */
  SIGNUP_ALLOWLIST?: string;
}

/** A signed-in person running projects: who they are, and which workspace they're in. */
export interface OwnerSession {
  uid: string;
  wid: string;
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
  owner?: { uid: string; wid: string };
};

/** The internal deployment's one workspace and its owner (seeded by migration 0011). */
export const INTERNAL_WORKSPACE = 'internal';
export const INTERNAL_OWNER = 'owner';
