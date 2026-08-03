/**
 * Caller authentication for Echo's provider-proxy Edge Functions (ADR-0008).
 *
 * Why this exists: `verify_jwt` (Supabase's default) is NOT enough on its own.
 * The project's anon key is itself a valid JWT and it necessarily ships inside
 * the app bundle, so anyone who unpacks the .ipa could otherwise call these
 * functions and spend our OpenAI/Anthropic budget.
 *
 * `getUser(token)` resolves a *user*, which the anon key does not have (it
 * carries the `anon` Postgres role, not `authenticated`). So requiring a user
 * is exactly the gate we want: only real sessions — including the anonymous
 * sessions created by `signInAnonymously()` — get through.
 */
import { createClient } from '@supabase/supabase-js';

export interface Caller {
  userId: string;
  /** True for signInAnonymously() users; they are still `authenticated`. */
  isAnonymous: boolean;
}

/** Returns the calling user, or null when the request carries no real session. */
export async function resolveCaller(req: Request): Promise<Caller | null> {
  const header = req.headers.get('Authorization');
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  if (!token) return null;

  const client = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_ANON_KEY') ?? '',
  );

  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) return null;

  return {
    userId: data.user.id,
    isAnonymous: data.user.is_anonymous === true,
  };
}

/**
 * Per-user daily quota, enforced in Postgres (see migration 002).
 *
 * Auth alone does not cap spend: anonymous sign-up is open, so an attacker
 * could mint sessions (Supabase rate-limits this to 30/hour/IP) and still run
 * up a bill. This is the actual budget guard.
 *
 * Fails **closed** — if the quota check itself errors we deny the call rather
 * than hand out a free provider request.
 */
export async function consumeQuota(
  userId: string,
  kind: 'diagnose' | 'transcribe',
  limit: number,
): Promise<{ ok: boolean; used: number }> {
  const admin = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  );

  const { data, error } = await admin.rpc('consume_api_quota', {
    p_user_id: userId,
    p_kind: kind,
    p_limit: limit,
  });

  if (error) {
    console.error(`[quota] ${kind} check failed for ${userId}:`, error.message);
    return { ok: false, used: limit };
  }

  const row = Array.isArray(data) ? data[0] : data;
  return { ok: row?.allowed === true, used: row?.used ?? 0 };
}
