import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { AppState } from 'react-native';

/**
 * Supabase client + anonymous session.
 *
 * Reads EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY (see
 * .env.example). If either is missing, exports `null` and the app runs in
 * local-only mode: replay events stay in component state and sync is a no-op.
 *
 * Every install signs in **anonymously** (`signInAnonymously`) rather than
 * running on the bare anon key. Three things depend on having a real user:
 *
 *   1. RLS — migration 002 scopes every row to `auth.uid() = user_id`, so
 *      beta users cannot read each other's captures and diagnoses.
 *   2. The Edge Functions (ADR-0008) reject callers with no user. The anon key
 *      is itself a valid JWT and necessarily ships in the bundle, so requiring
 *      a *user* is what actually gates the provider budget.
 *   3. Per-user metrics. The north star is completed daily sessions per active
 *      user — with a null user_id the beta produces unattributable data.
 *
 * An anonymous user is permanent-but-unrecoverable: it survives restarts (the
 * session is persisted to AsyncStorage) but is lost if the app is deleted or
 * the user switches device. That is the right trade for a beta — no signup
 * friction — and it can be upgraded in place later by linking an email.
 *
 * ⚠️ Requires **Anonymous sign-ins** to be enabled in the Supabase dashboard
 *    (Authentication → Providers).
 */
const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

export const supabase: SupabaseClient | null =
  url && anonKey
    ? createClient(url, anonKey, {
        auth: {
          storage: AsyncStorage,
          persistSession: true,
          autoRefreshToken: true,
          // No deep-link auth callback in a native app.
          detectSessionInUrl: false,
        },
      })
    : null;

export const isSupabaseConfigured = supabase !== null;

/**
 * Token refresh only makes sense while the app is in the foreground; left
 * running in the background it retries on a dead network and burns battery.
 */
if (supabase) {
  AppState.addEventListener('change', (state) => {
    if (state === 'active') {
      supabase.auth.startAutoRefresh();
    } else {
      supabase.auth.stopAutoRefresh();
    }
  });
}

let sessionPromise: Promise<string | null> | null = null;

async function resolveSession(client: SupabaseClient): Promise<string | null> {
  const { data } = await client.auth.getSession();
  if (data.session?.user) return data.session.user.id;

  const { data: created, error } = await client.auth.signInAnonymously();
  if (error) {
    console.warn('[supabase] anonymous sign-in failed:', error.message);
    return null;
  }
  return created.user?.id ?? null;
}

/**
 * Ensure this install has a session, creating an anonymous one on first run.
 * Call once on app start, before anything that syncs or calls an Edge Function.
 *
 * Memoised: concurrent callers share one sign-in rather than racing to mint
 * several anonymous users for the same install. Never throws — a null return
 * means "carry on local-only".
 */
export function ensureSession(): Promise<string | null> {
  if (!supabase) return Promise.resolve(null);
  if (!sessionPromise) {
    sessionPromise = resolveSession(supabase).catch((err) => {
      console.warn('[supabase] session bootstrap failed:', err);
      return null;
    });
  }
  return sessionPromise;
}

/** Current user id, or null when signed out / not configured. */
export async function getUserId(): Promise<string | null> {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.user?.id ?? null;
}
