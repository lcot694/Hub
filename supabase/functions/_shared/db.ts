import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

export function requiredServerEnv(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`Missing required server configuration: ${name}`);
  return value;
}

let serviceClient: SupabaseClient | undefined;

export function createServiceClient(): SupabaseClient {
  if (!serviceClient) {
    serviceClient = createClient(
      requiredServerEnv("SUPABASE_URL"),
      requiredServerEnv("SUPABASE_SERVICE_ROLE_KEY"),
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
      },
    );
  }

  return serviceClient;
}
