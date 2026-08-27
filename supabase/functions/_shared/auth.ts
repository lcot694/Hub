import type { SupabaseClient, User } from "npm:@supabase/supabase-js@2";
import { createServiceClient } from "./db.ts";
import { HttpError } from "./http.ts";

export interface UserContext {
  userId: string;
  accessToken: string;
}

interface AuthDependencies {
  supabase?: SupabaseClient;
}

function bearerToken(req: Request): string {
  const authorization = req.headers.get("Authorization") ?? "";
  const match = /^Bearer ([^\s]+)$/.exec(authorization);
  if (!match) throw new HttpError(401, "unauthorized", "Authentication required");
  return match[1];
}

export async function requireUser(
  req: Request,
  dependencies: AuthDependencies = {},
): Promise<UserContext> {
  const accessToken = bearerToken(req);
  const supabase = dependencies.supabase ?? createServiceClient();
  const { data, error } = await supabase.auth.getUser(accessToken);
  const user: User | null = data.user;

  if (error || !user) {
    throw new HttpError(401, "unauthorized", "Authentication required");
  }

  return { userId: user.id, accessToken };
}
