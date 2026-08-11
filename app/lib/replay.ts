import { supabase } from './supabase';

/**
 * Replay-event pipeline (W1 heart of the product).
 *
 * Every backward seek — Back-15s button today; headphone remote / lock-screen
 * in the dev-build phase — becomes one row in `replay_events`. Phase 2's
 * real-life mode reuses this exact pipeline with a different trigger_source.
 *
 * `'select'`（逐字稿裡親手框出難點）是**唯一不伴隨播放位置變動**的來源：框選
 * 不 seek、不暫停，它記錄的是「學習者在第 X 秒指著第 Y 句說我不懂這幾個字」。
 * 之所以還是走同一條管線而不另開一種事件，是因為它與倒帶講的是同一件事——
 * 學習者在這個時間點卡住了——只是精確度高一級（見 migration 006 的強度分層）。
 */
export type TriggerSource = 'screen' | 'headphone' | 'lockscreen' | 'select';

export interface ReplayEvent {
  /** Client-side id for list keys / dedupe (not the DB pk). */
  local_id: string;
  episode_id: string;
  from_pos: number;
  to_pos: number;
  playback_rate: number;
  trigger_source: TriggerSource;
  created_at: string; // ISO 8601
  /** True once the row has been accepted by Supabase. */
  synced: boolean;
}

export function makeReplayEvent(params: {
  episodeId: string;
  fromPos: number;
  toPos: number;
  playbackRate: number;
  triggerSource?: TriggerSource;
}): ReplayEvent {
  return {
    local_id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    episode_id: params.episodeId,
    from_pos: Math.round(params.fromPos * 10) / 10,
    to_pos: Math.round(params.toPos * 10) / 10,
    playback_rate: params.playbackRate,
    trigger_source: params.triggerSource ?? 'screen',
    created_at: new Date().toISOString(),
    synced: false,
  };
}

/**
 * Best-effort insert into Supabase `replay_events`.
 * Never throws; returns true only when the row was persisted remotely.
 * Without Supabase env vars this silently no-ops (local-only mode).
 */
export async function syncReplayEvent(event: ReplayEvent): Promise<boolean> {
  if (!supabase) {
    console.log(
      '[replay] Supabase not configured — event kept local only:',
      event.local_id,
    );
    return false;
  }
  try {
    const { error } = await supabase.from('replay_events').insert({
      episode_id: event.episode_id,
      from_pos: event.from_pos,
      to_pos: event.to_pos,
      playback_rate: event.playback_rate,
      trigger_source: event.trigger_source,
      created_at: event.created_at,
    });
    if (error) {
      console.warn('[replay] Supabase insert failed:', error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('[replay] Supabase sync error:', err);
    return false;
  }
}
