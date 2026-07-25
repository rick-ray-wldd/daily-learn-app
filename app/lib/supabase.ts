import 'react-native-url-polyfill/auto';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

/**
 * Supabase client — optional in W1.
 *
 * Reads EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY (see
 * .env.example). If either is missing, exports `null` and the app runs in
 * local-only mode: replay events stay in component state and sync is a no-op.
 */
const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

export const supabase: SupabaseClient | null =
  url && anonKey
    ? createClient(url, anonKey, {
        auth: {
          // No auth in the W1 prototype; skip session persistence so we
          // don't need AsyncStorage yet.
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
      })
    : null;

export const isSupabaseConfigured = supabase !== null;
