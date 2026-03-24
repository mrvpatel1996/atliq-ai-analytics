// ─── Shared Hono App Environment Types ──────────────────────

import type { UserRole } from "../auth/permissions.js";

export type AppVariables = {
  userId: string;
  userRole: UserRole;
};

export type AppEnv = {
  Variables: AppVariables;
};
