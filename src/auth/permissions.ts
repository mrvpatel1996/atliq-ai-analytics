// ─── Role Permission Matrix ───────────────────────────────────

export type Permission =
  // Providers
  | "providers.read"
  | "providers.create"
  | "providers.update"
  | "providers.delete"
  | "providers.test"
  // Videos
  | "videos.read"
  | "videos.create"
  | "videos.update"
  | "videos.delete"
  // Sync
  | "sync.read"
  | "sync.start"
  | "sync.cancel"
  // Webhooks
  | "webhooks.read"
  | "webhooks.create"
  // Users
  | "users.read"
  | "users.create"
  | "users.update"
  | "users.delete"
  | "users.apikey"
  // Import
  | "import.read"
  | "import.start"
  // Audit
  | "audit.read";

export type UserRole = "SUPER_ADMIN" | "ADMIN" | "OPERATOR" | "VIEWER";

const ROLE_PERMISSIONS: Record<UserRole, Permission[]> = {
  SUPER_ADMIN: [
    "providers.read", "providers.create", "providers.update", "providers.delete", "providers.test",
    "videos.read", "videos.create", "videos.update", "videos.delete",
    "sync.read", "sync.start", "sync.cancel",
    "webhooks.read", "webhooks.create",
    "users.read", "users.create", "users.update", "users.delete", "users.apikey",
    "import.read", "import.start",
    "audit.read",
  ],
  ADMIN: [
    "providers.read", "providers.create", "providers.update", "providers.delete", "providers.test",
    "videos.read", "videos.create", "videos.update", "videos.delete",
    "sync.read", "sync.start", "sync.cancel",
    "webhooks.read",
    "users.read", "users.create", "users.update", "users.apikey",
    "import.read", "import.start",
    "audit.read",
  ],
  OPERATOR: [
    "providers.read", "providers.test",
    "videos.read", "videos.create", "videos.update", "videos.delete",
    "sync.read", "sync.start", "sync.cancel",
    "webhooks.read",
    "import.read", "import.start",
  ],
  VIEWER: [
    "providers.read",
    "videos.read",
    "sync.read",
    "import.read",
  ],
};

// Role hierarchy for numeric comparison
const ROLE_LEVEL: Record<UserRole, number> = {
  VIEWER: 0,
  OPERATOR: 1,
  ADMIN: 2,
  SUPER_ADMIN: 3,
};

export function hasPermission(role: UserRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}

export function hasMinRole(role: UserRole, minRole: UserRole): boolean {
  return (ROLE_LEVEL[role] ?? -1) >= (ROLE_LEVEL[minRole] ?? 99);
}
