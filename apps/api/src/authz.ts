/**
 * Per-user authentication adapter (R2 stream F).
 *
 * Users authenticate with API keys (presented as Bearer tokens). Keys are
 * stored hashed (SHA-256); the plaintext is shown exactly once at creation.
 * A user may hold any number of project memberships with roles:
 *   owner  — manage project, keys, members
 *   member — create captures/proposals/plans, read everything
 *   viewer — read-only
 *
 * The dev operator token remains a valid principal (role: owner on every
 * project) so local flows and the preview editor keep working without
 * provisioning users.
 */
import { createHash, randomBytes } from "node:crypto";
import type Database from "better-sqlite3";

export type Role = "owner" | "member" | "viewer";

export type Principal = {
  userId: string;
  displayName: string;
  /** Dev operator principal (no DB user row). */
  operator: boolean;
  roleFor: (projectId: string) => Role | null;
};

export type ApiKeyRow = {
  id: string;
  user_id: string;
  key_hash: string;
  label: string;
  created_at: string;
  last_used_at: string | null;
};

export const AUTH_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  key_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE TABLE IF NOT EXISTS project_members (
  project_id TEXT NOT NULL REFERENCES projects(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('owner','member','viewer')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, user_id)
);
`;

export function hashApiKey(plaintext: string): string {
  return createHash("sha256").update(plaintext, "utf8").digest("hex");
}

export function generateApiKey(): string {
  return `uik_${randomBytes(24).toString("base64url")}`;
}

/** Provisioning: create a user, optionally with memberships, and one API key. */
export function createUserWithKey(
  db: Database,
  input: { userId?: string; displayName: string; keyLabel: string; memberships?: Array<{ projectId: string; role: Role }> }
): { userId: string; apiKey: string; keyId: string } {
  const userId = input.userId ?? `user_${randomBytes(12).toString("hex")}`;
  const now = new Date().toISOString();
  db.prepare("INSERT INTO users (id, display_name, created_at) VALUES (?, ?, ?)").run(userId, input.displayName, now);
  const apiKey = generateApiKey();
  const keyId = `key_${randomBytes(12).toString("hex")}`;
  db.prepare("INSERT INTO api_keys (id, user_id, key_hash, label, created_at) VALUES (?, ?, ?, ?, ?)").run(
    keyId,
    userId,
    hashApiKey(apiKey),
    input.keyLabel,
    now
  );
  for (const m of input.memberships ?? []) {
    db.prepare("INSERT OR REPLACE INTO project_members (project_id, user_id, role, created_at) VALUES (?, ?, ?, ?)").run(
      m.projectId,
      userId,
      m.role,
      now
    );
  }
  return { userId, apiKey, keyId };
}

/** Resolve a presented bearer token to a principal, or null when unknown. */
export function authenticate(
  db: Database,
  operatorToken: string,
  presentedToken: string
): Principal | null {
  // Dev operator token: owner on every project.
  if (presentedToken === operatorToken) {
    return {
      userId: "operator",
      displayName: "Dev Operator",
      operator: true,
      roleFor: () => "owner",
    };
  }
  const row = db
    .prepare(
      `SELECT ak.id AS key_id, ak.user_id, u.display_name
       FROM api_keys ak JOIN users u ON u.id = ak.user_id
       WHERE ak.key_hash = ?`
    )
    .get(hashApiKey(presentedToken)) as { key_id: string; user_id: string; display_name: string } | undefined;
  if (!row) return null;
  db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(new Date().toISOString(), row.key_id);
  const memberships = db
    .prepare("SELECT project_id, role FROM project_members WHERE user_id = ?")
    .all(row.user_id) as Array<{ project_id: string; role: Role }>;
  const roleMap = new Map(memberships.map((m) => [m.project_id, m.role]));
  return {
    userId: row.user_id,
    displayName: row.display_name,
    operator: false,
    roleFor: (projectId: string) => roleMap.get(projectId) ?? null,
  };
}

export const ROLE_RANK: Record<Role, number> = { viewer: 0, member: 1, owner: 2 };

/** Throws (structured) when the principal lacks the required role on a project. */
export function requireRole(principal: Principal, projectId: string, minimum: Role): { ok: true } | { ok: false; reason: string } {
  const role = principal.roleFor(projectId);
  if (!role) return { ok: false, reason: `no membership in project ${projectId}` };
  if (ROLE_RANK[role] < ROLE_RANK[minimum]) {
    return { ok: false, reason: `role ${role} is below required ${minimum} for project ${projectId}` };
  }
  return { ok: true };
}
