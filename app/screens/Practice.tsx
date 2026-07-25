/**
 * PracticeScreen — 每日練習（mvp-spec.md P0「Daily session」）。
 *
 * Queue = 所有 pending captures（strong 排前）＋ 到期的 SRS 複習項目。
 * 每張卡的流程（signal-design.md §3：把雜訊過濾變成複習的第一步）：
 *   a. 確認：「真的沒聽懂」→ confirmed／「只是分心」→ dismissed（雜訊標註）
 *   b. 重聽 context 窗口（1x / 0.7x，到 context_end 自動停）
 *   c. 逐字稿（先遮住）＋ Claude 診斷卡（皆可選，無 key 時降級）
 *   d. 跟讀錄音（expo-audio recorder），可與原音對照
 *   e. 評分 再來一次/記住了/太簡單 → 簡化 SM-2 → 下一張
 */
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioPlayer,
  useAudioPlayerStatus,
  useAudioRecorder,
  useAudioRecorderState,
} from 'expo-audio';

import {
  addPracticeRecord,
  findEpisodeById,
  getCapture,
  getCaptures,
  getPracticeLog,
  getSrsItem,
  getSrsItems,
  initStore,
  subscribe,
  updateCapture,
  upsertSrsItem,
} from '../lib/store';
import {
  DIAGNOSIS_LABELS_ZH,
  diagnoseCapture,
  isDiagnosisConfigured,
} from '../lib/diagnose';
import {
  canTranscribe,
  ensureTranscript,
  preloadTranscript,
  sentencesInWindow,
  WindowSentences,
} from '../lib/transcript';
import {
  gradeSrsItem,
  isDue,
  isDueTomorrow,
  newSrsItem,
  SrsGrade,
  toDateStr,
  todayStr,
} from '../lib/srs';
import { computeStreak, computeWeaknessStats } from '../lib/stats';
import { syncDailyReminder } from '../lib/notifications';
import { Capture } from '../lib/types';

interface QueueItem {
  capture: Capture;
  mode: 'new' | 'review';
}

type TranscriptPhase =
  | { phase: 'none' } // no OpenAI key and no RSS transcript
  | { phase: 'loading' }
  | { phase: 'failed'; reason: string }
  | { phase: 'ready'; sentences: WindowSentences | null };

function formatTime(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '0:00';
  const s = Math.floor(totalSeconds);
  const m = Math.floor(s / 60);
  return `${m}:${(s % 60).toString().padStart(2, '0')}`;
}

/** Restore the app-wide playback audio mode (recording off). */
function restorePlaybackMode(): Promise<void> {
  return setAudioModeAsync({
    playsInSilentMode: true,
    interruptionMode: 'doNotMix',
    shouldPlayInBackground: true,
    allowsRecording: false,
  });
}

export default function PracticeScreen() {
  const [queue, setQueue] = useState<QueueItem[] | null>(null);
  const [index, setIndex] = useState(0);
  const [step, setStep] = useState<'confirm' | 'practice'>('confirm');
  const [fresh, setFresh] = useState<QueueItem[]>([]); // 今天剛抓的 pending（搶先練）
  const [freshExpanded, setFreshExpanded] = useState(false);

  // Session stats
  const [practicedStrong, setPracticedStrong] = useState(0);
  const [practicedWeak, setPracticedWeak] = useState(0);
  const [dismissed, setDismissed] = useState(0);
  const sessionStartRef = useRef(Date.now());
  const recordedSessionRef = useRef(false);

  // Per-card state
  const [transcript, setTranscript] = useState<TranscriptPhase>({
    phase: 'none',
  });
  const [revealed, setRevealed] = useState(false);
  const [diagnosing, setDiagnosing] = useState(false);
  const [recordingUri, setRecordingUri] = useState<string | null>(null);
  const [recordError, setRecordError] = useState<string | null>(null);
  const [stopAt, setStopAt] = useState<number | null>(null);

  // Re-render on any store change so we always show live capture data
  // (diagnosis written back async, strength upgrades, ...).
  const [, setStoreVersion] = useState(0);
  useEffect(() => subscribe(() => setStoreVersion((v) => v + 1)), []);

  // Dedicated practice player (separate from the main podcast player).
  const player = useAudioPlayer(null, { updateInterval: 250 });
  const playerStatus = useAudioPlayerStatus(player);
  const loadedSourceRef = useRef<string | null>(null);

  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recorderState = useAudioRecorderState(recorder);

  // Build the queue once（日切）: 正式佇列 = 昨天以前的 pending（strong 排前）
  // + confirmed 但沒評分過的孤兒卡（上次按了「真的沒聽懂」就離開）
  // + 今日到期 SRS 複習；今天剛抓的獨立成 fresh（搶先練）。
  // App.tsx 的 computeBadge 用同一套規則。
  useEffect(() => {
    let cancelled = false;
    void initStore().then(() => {
      if (cancelled) return;
      const today = todayStr(); // 裝置當地日界線
      const byPriority = (a: Capture, b: Capture) => {
        if (a.strength !== b.strength) return a.strength === 'strong' ? -1 : 1;
        return a.created_at.localeCompare(b.created_at);
      };
      const allCaptures = getCaptures();
      const pendingAll = allCaptures.filter((c) => c.status === 'pending');
      // confirmed 且無對應 SRS item = 孤兒卡：mode 'new'、跳過 confirm 步
      // 直接 practice（見卡片切換 effect 的 setStep）。
      const srsIds = new Set(getSrsItems().map((i) => i.capture_id));
      const orphanConfirmed = allCaptures.filter(
        (c) => c.status === 'confirmed' && !srsIds.has(c.id),
      );
      // created_at 是 ISO(UTC)，new Date() 轉當地時區後取 YYYY-MM-DD
      const official = [
        ...pendingAll.filter((c) => toDateStr(new Date(c.created_at)) < today),
        ...orphanConfirmed,
      ].sort(byPriority);
      const freshToday = pendingAll
        .filter((c) => toDateStr(new Date(c.created_at)) === today)
        .sort(byPriority);
      const pendingIds = new Set(pendingAll.map((c) => c.id)); // 排除「還在 pending」的所有 capture，避免重複入列
      const reviews = getSrsItems()
        .filter((i) => isDue(i) && !pendingIds.has(i.capture_id))
        .map((i) => getCapture(i.capture_id))
        .filter(
          (c): c is Capture =>
            Boolean(c) &&
            (c!.status === 'practiced' || c!.status === 'confirmed'),
        );
      setQueue([
        ...official.map((c) => ({ capture: c, mode: 'new' as const })),
        ...reviews.map((c) => ({ capture: c, mode: 'review' as const })),
      ]);
      setFresh(freshToday.map((c) => ({ capture: c, mode: 'new' as const })));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const current = queue && index < queue.length ? queue[index] : null;
  const liveCapture = current
    ? getCapture(current.capture.id) ?? current.capture
    : null;

  // Auto-stop playback at context_end.
  useEffect(() => {
    if (
      stopAt !== null &&
      playerStatus.playing &&
      (playerStatus.currentTime ?? 0) >= stopAt
    ) {
      player.pause();
      setStopAt(null);
    }
  }, [playerStatus.currentTime, playerStatus.playing, stopAt, player]);

  // Reset per-card state + kick off transcript loading when the card changes.
  useEffect(() => {
    // review 卡與孤兒 confirmed 卡（已確認過「真的沒聽懂」）都跳過 confirm 步。
    setStep(
      current?.mode === 'review' || current?.capture.status === 'confirmed'
        ? 'practice'
        : 'confirm',
    );
    setRevealed(false);
    setDiagnosing(false);
    setRecordingUri(null);
    setRecordError(null);
    setStopAt(null);
    player.pause();

    if (!current) return;
    const ep = findEpisodeById(current.capture.episode_id);
    if (!ep) {
      setTranscript({ phase: 'none' });
      return;
    }
    if (!canTranscribe(ep)) {
      setTranscript({ phase: 'none' });
      return;
    }
    let cancelled = false;
    setTranscript({ phase: 'loading' });
    (async () => {
      await preloadTranscript(ep.id);
      const result = await ensureTranscript(ep);
      if (cancelled) return;
      if (!result) {
        setTranscript({ phase: 'none' });
        return;
      }
      if (result.status === 'failed') {
        setTranscript({ phase: 'failed', reason: result.reason });
        return;
      }
      const sentences = sentencesInWindow(
        ep.id,
        current.capture.window_start,
        current.capture.window_end,
      );
      setTranscript({ phase: 'ready', sentences });
      const text = sentences?.inWindow.map((s) => s.text).join(' ') ?? '';
      const live = getCapture(current.capture.id);
      if (text && live && !live.transcript_text) {
        updateCapture(current.capture.id, { transcript_text: text });
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, queue]);

  // Record the daily session summary once everything is done.
  useEffect(() => {
    if (!queue || queue.length === 0 || index < queue.length) return;
    if (recordedSessionRef.current) return;
    recordedSessionRef.current = true;
    addPracticeRecord({
      date: todayStr(),
      // 「再來一次」會把同一張卡 push 回佇列尾 → 以去重後的卡數為準，
      // 避免 items_total 被 again 灌水。
      items_total: new Set(queue.map((q) => q.capture.id)).size,
      items_completed: practicedStrong + practicedWeak,
      strong_count: practicedStrong,
      weak_count: practicedWeak,
      dismissed_count: dismissed,
      created_at: new Date().toISOString(),
    });
    void syncDailyReminder(); // 練完立即刷新明早通知文案（此時 pending 通常歸零）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, queue]);

  const playSegment = async (rate: number) => {
    if (!liveCapture) return;
    const ep = findEpisodeById(liveCapture.episode_id);
    if (!ep) return;
    try {
      if (loadedSourceRef.current !== ep.audioUrl) {
        player.replace({ uri: ep.audioUrl });
        loadedSourceRef.current = ep.audioUrl;
      }
      player.setPlaybackRate(rate, 'high');
      await player.seekTo(liveCapture.context_start);
      setStopAt(liveCapture.context_end);
      player.play();
    } catch (err) {
      console.warn('[practice] playSegment failed:', err);
    }
  };

  const stopPlayback = () => {
    player.pause();
    setStopAt(null);
  };

  const startRecording = async () => {
    try {
      const perm = await requestRecordingPermissionsAsync();
      if (!perm.granted) {
        setRecordError('需要麥克風權限才能跟讀，請到系統設定開啟。');
        return;
      }
      setRecordError(null);
      stopPlayback();
      await setAudioModeAsync({
        playsInSilentMode: true,
        interruptionMode: 'doNotMix',
        allowsRecording: true,
      });
      await recorder.prepareToRecordAsync();
      recorder.record();
      setRecordingUri(null);
    } catch (err) {
      console.warn('[practice] startRecording failed:', err);
      setRecordError('錄音啟動失敗，再試一次。');
      void restorePlaybackMode();
    }
  };

  const stopRecording = async () => {
    try {
      await recorder.stop();
      setRecordingUri(recorder.uri);
    } catch (err) {
      console.warn('[practice] stopRecording failed:', err);
    } finally {
      void restorePlaybackMode();
    }
  };

  const playRecording = async () => {
    if (!recordingUri) return;
    try {
      if (loadedSourceRef.current !== recordingUri) {
        player.replace({ uri: recordingUri });
        loadedSourceRef.current = recordingUri;
      }
      player.setPlaybackRate(1, 'high');
      setStopAt(null);
      await player.seekTo(0);
      player.play();
    } catch (err) {
      console.warn('[practice] playRecording failed:', err);
    }
  };

  const advance = () => {
    stopPlayback();
    setIndex((i) => i + 1);
  };

  const onConfirm = () => {
    if (!liveCapture) return;
    updateCapture(liveCapture.id, { status: 'confirmed' });
    setStep('practice');
  };

  const onDismiss = () => {
    if (!liveCapture) return;
    // Dismissals are logged too — free labeled noise data (§3).
    updateCapture(liveCapture.id, { status: 'dismissed' });
    setDismissed((n) => n + 1);
    advance();
  };

  const onReveal = () => {
    setRevealed(true);
    if (!liveCapture || liveCapture.diagnosis || !isDiagnosisConfigured()) {
      return;
    }
    if (transcript.phase !== 'ready' || !transcript.sentences) return;
    const sentence = transcript.sentences.inWindow
      .map((s) => s.text)
      .join(' ');
    if (!sentence) return;
    const context = [
      transcript.sentences.before?.text,
      transcript.sentences.after?.text,
    ]
      .filter(Boolean)
      .join(' … ');
    setDiagnosing(true);
    void diagnoseCapture({ sentence, context }).then((d) => {
      setDiagnosing(false);
      if (d) updateCapture(liveCapture.id, { diagnosis: d });
    });
  };

  const onGrade = (grade: SrsGrade) => {
    if (!liveCapture || !current) return;
    const item = getSrsItem(liveCapture.id) ?? newSrsItem(liveCapture.id);
    upsertSrsItem(gradeSrsItem(item, grade));
    updateCapture(liveCapture.id, { status: 'practiced' });
    if (grade === 'again') {
      // 今天再來：把這張卡排回今天佇列的最後。
      setQueue((q) =>
        q ? [...q, { capture: liveCapture, mode: 'review' }] : q,
      );
    } else if (liveCapture.strength === 'strong') {
      setPracticedStrong((n) => n + 1);
    } else {
      setPracticedWeak((n) => n + 1);
    }
    advance();
  };

  // 搶先練（founder dogfood）：整批替換 queue，讓第二筆 practice record
  // 的 items_total / 耗時乾淨；只會從空佇列或完成畫面觸發。
  const startFresh = () => {
    if (fresh.length === 0) return;
    setQueue(fresh);
    setIndex(0);
    setPracticedStrong(0);
    setPracticedWeak(0);
    setDismissed(0);
    recordedSessionRef.current = false; // 搶先練結束時再記一筆當日 record（streak 計算已對同日多筆去重）
    sessionStartRef.current = Date.now();
    setFresh([]);
    setFreshExpanded(false);
  };

  // Streak + 弱點統計（storeVersion 訂閱保證任何 store 變動後重算）。
  const streak = computeStreak(getPracticeLog());
  const weakness = computeWeaknessStats(getCaptures());

  // ---------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------

  const renderFreshBlock = () =>
    fresh.length > 0 ? (
      <View style={styles.freshBox}>
        <Pressable style={styles.freshHeader} onPress={() => setFreshExpanded((v) => !v)}>
          <Text style={styles.freshTitle}>⚡ 搶先練（{fresh.length}）</Text>
          <Text style={styles.freshChevron}>{freshExpanded ? '▾' : '▸'}</Text>
        </Pressable>
        {freshExpanded && (
          <View style={styles.freshBody}>
            <Text style={styles.freshHint}>
              這些是今天剛抓到的難點。正式節奏是明天早上練（隔夜複習效果更好）；等不及也可以現在清。
            </Text>
            <Pressable
              onPress={startFresh}
              style={({ pressed }) => [styles.primaryBtn, pressed && styles.pressed]}
            >
              <Text style={styles.primaryBtnText}>開始搶先練 {fresh.length} 張</Text>
            </Pressable>
          </View>
        )}
      </View>
    ) : null;

  const renderStatsCard = () =>
    weakness.totalCaptures > 0 ? (
      <View style={styles.statsBox}>
        <Text style={styles.statLine}>
          {weakness.topType ? (
            <>
              你的難點 <Text style={styles.statNum}>{weakness.topType.pct}%</Text> 是
              {DIAGNOSIS_LABELS_ZH[weakness.topType.type]}
            </>
          ) : (
            '累積更多診斷後，這裡會顯示你的難點分佈'
          )}
        </Text>
        <Text style={styles.statLine}>
          累計捕捉 <Text style={styles.statNum}>{weakness.totalCaptures}</Text> 個難點
        </Text>
        {weakness.confirmRate !== null && (
          <Text style={styles.statLine}>
            確認率 <Text style={styles.statNum}>{Math.round(weakness.confirmRate * 100)}%</Text>
            （滑掉的是誤報）
          </Text>
        )}
      </View>
    ) : null;

  if (!queue) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={C.accent} />
        <Text style={styles.dimText}>載入練習佇列…</Text>
      </View>
    );
  }

  if (queue.length === 0) {
    return (
      <ScrollView style={styles.root} contentContainerStyle={styles.centeredScroll}>
        <Text style={styles.bigEmoji}>🎧</Text>
        <Text style={styles.title}>目前沒有待練項目</Text>
        {streak > 0 && <Text style={styles.dimText}>🔥 連續練習 {streak} 天</Text>}
        {renderStatsCard()}
        {renderFreshBlock()}
        <Text style={styles.dimText}>
          去「播放器」聽 podcast，按 ↺15 —— 每一次重聽都會被接住，
          {'\n'}明天早上回來清掉它們。
        </Text>
      </ScrollView>
    );
  }

  if (!current || !liveCapture) {
    // Done screen
    const dueTomorrow = getSrsItems().filter((i) => isDueTomorrow(i)).length;
    const sessionMin = Math.max(
      1,
      Math.round((Date.now() - sessionStartRef.current) / 60000),
    );
    return (
      <ScrollView style={styles.root} contentContainerStyle={styles.centeredScroll}>
        <Text style={styles.bigEmoji}>✅</Text>
        <Text style={styles.title}>今日練習完成</Text>
        <View style={styles.statsBox}>
          <Text style={styles.statLine}>
            練了 <Text style={styles.statNum}>{practicedStrong + practicedWeak}</Text> 句
            （★★★ 強訊號 {practicedStrong}・★ 弱訊號 {practicedWeak}）
          </Text>
          <Text style={styles.statLine}>
            滑掉分心誤報 <Text style={styles.statNum}>{dismissed}</Text> 個
          </Text>
          <Text style={styles.statLine}>
            明日到期複習 <Text style={styles.statNum}>{dueTomorrow}</Text> 張
          </Text>
          <Text style={styles.statLine}>本次耗時約 {sessionMin} 分鐘</Text>
          <Text style={styles.statLine}>
            連續練習 <Text style={styles.statNum}>{streak}</Text> 天
          </Text>
        </View>
        {renderStatsCard()}
        {renderFreshBlock()}
        <Text style={styles.dimText}>繼續聽，明天見。</Text>
      </ScrollView>
    );
  }

  const episode = findEpisodeById(liveCapture.episode_id);
  const isPlaying = playerStatus.playing && stopAt !== null;

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={styles.scrollContent}
    >
      {/* Card header */}
      <View style={styles.cardHeader}>
        <Text style={styles.progress}>
          第 {Math.min(index + 1, queue.length)} / {queue.length} 張
        </Text>
        <View style={styles.badges}>
          {streak > 0 && (
            <View style={[styles.chip, styles.chipStreak]}>
              <Text style={styles.chipText}>🔥 {streak} 天</Text>
            </View>
          )}
          {current.mode === 'review' && (
            <View style={[styles.chip, styles.chipReview]}>
              <Text style={styles.chipText}>複習</Text>
            </View>
          )}
          <View
            style={[
              styles.chip,
              liveCapture.strength === 'strong'
                ? styles.chipStrong
                : styles.chipWeak,
            ]}
          >
            <Text style={styles.chipText}>
              {liveCapture.strength === 'strong' ? '★★★ 強訊號' : '★ 弱訊號'}
            </Text>
          </View>
        </View>
      </View>

      <Text style={styles.episodeTitle} numberOfLines={2}>
        {episode ? episode.title : '（未知單集）'}
      </Text>
      <Text style={styles.windowText}>
        難點窗口 {formatTime(liveCapture.window_start)} –{' '}
        {formatTime(liveCapture.window_end)}（重播{' '}
        {formatTime(liveCapture.context_start)} –{' '}
        {formatTime(liveCapture.context_end)}）
      </Text>

      {step === 'confirm' ? (
        /* Step a — 確認（雜訊過濾＝第二次曝光） */
        <View style={styles.section}>
          <Text style={styles.confirmPrompt}>
            你重聽了這一段。{'\n'}是真的沒聽懂，還是只是分心？
          </Text>
          <Pressable
            onPress={onConfirm}
            style={({ pressed }) => [styles.primaryBtn, pressed && styles.pressed]}
          >
            <Text style={styles.primaryBtnText}>這段是真的沒聽懂</Text>
          </Pressable>
          <Pressable
            onPress={onDismiss}
            style={({ pressed }) => [styles.ghostBtn, pressed && styles.pressed]}
          >
            <Text style={styles.ghostBtnText}>只是分心，滑掉</Text>
          </Pressable>
        </View>
      ) : (
        <>
          {/* Step b — 重聽 */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>重聽這段</Text>
            <View style={styles.row}>
              <Pressable
                onPress={() => void playSegment(1)}
                style={({ pressed }) => [styles.actionBtn, pressed && styles.pressed]}
              >
                <Text style={styles.actionBtnText}>▶ 原速 1x</Text>
              </Pressable>
              <Pressable
                onPress={() => void playSegment(0.7)}
                style={({ pressed }) => [styles.actionBtn, pressed && styles.pressed]}
              >
                <Text style={styles.actionBtnText}>▶ 慢速 0.7x</Text>
              </Pressable>
              {isPlaying && (
                <Pressable
                  onPress={stopPlayback}
                  style={({ pressed }) => [styles.stopBtn, pressed && styles.pressed]}
                >
                  <Text style={styles.actionBtnText}>⏹</Text>
                </Pressable>
              )}
            </View>
          </View>

          {/* Step c — 逐字稿與診斷 */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>逐字稿</Text>
            {transcript.phase === 'none' && (
              <Text style={styles.dimText}>
                逐字稿待轉錄（此集無官方逐字稿；設定 OpenAI key
                後自動補）——先用耳朵練，仍可繼續。
              </Text>
            )}
            {transcript.phase === 'loading' && (
              <View style={styles.rowCenter}>
                <ActivityIndicator color={C.accent} size="small" />
                <Text style={styles.dimText}>
                  {'  '}轉錄中…（每集只轉一次，第一次要下載音檔）
                </Text>
              </View>
            )}
            {transcript.phase === 'failed' && (
              <Text style={styles.dimText}>轉錄失敗：{transcript.reason}</Text>
            )}
            {transcript.phase === 'ready' && !revealed && (
              <Pressable
                onPress={onReveal}
                style={({ pressed }) => [styles.maskBox, pressed && styles.pressed]}
              >
                <Text style={styles.maskText}>
                  先聽懂再看 —— 點我顯示逐字稿
                </Text>
              </Pressable>
            )}
            {transcript.phase === 'ready' && revealed && (
              <View>
                {transcript.sentences?.before && (
                  <Text style={styles.contextText}>
                    {transcript.sentences.before.text}
                  </Text>
                )}
                <Text style={styles.focusText}>
                  {transcript.sentences && transcript.sentences.inWindow.length > 0
                    ? transcript.sentences.inWindow.map((s) => s.text).join(' ')
                    : '（此窗口沒有對到句子）'}
                </Text>
                {transcript.sentences?.after && (
                  <Text style={styles.contextText}>
                    {transcript.sentences.after.text}
                  </Text>
                )}

                {/* 診斷卡 */}
                {liveCapture.diagnosis ? (
                  <View style={styles.diagnosisCard}>
                    <View style={styles.rowWrap}>
                      <View style={[styles.chip, styles.chipDiag]}>
                        <Text style={styles.chipText}>
                          {DIAGNOSIS_LABELS_ZH[liveCapture.diagnosis.type]}
                        </Text>
                      </View>
                      <Text style={styles.diagFocus}>
                        {liveCapture.diagnosis.focus_phrase}
                      </Text>
                    </View>
                    <Text style={styles.diagText}>
                      {liveCapture.diagnosis.explanation_zh}
                    </Text>
                    <Text style={styles.diagTip}>
                      💡 {liveCapture.diagnosis.practice_tip_zh}
                    </Text>
                  </View>
                ) : diagnosing ? (
                  <View style={styles.rowCenter}>
                    <ActivityIndicator color={C.accent} size="small" />
                    <Text style={styles.dimText}>{'  '}Claude 診斷中…</Text>
                  </View>
                ) : !isDiagnosisConfigured() ? (
                  <Text style={styles.dimText}>
                    （未設定 Anthropic key，略過難點診斷）
                  </Text>
                ) : null}
              </View>
            )}
          </View>

          {/* Step d — 跟讀 */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>跟讀</Text>
            {recordError && <Text style={styles.errorText}>{recordError}</Text>}
            <View style={styles.row}>
              {recorderState.isRecording ? (
                <Pressable
                  onPress={() => void stopRecording()}
                  style={({ pressed }) => [styles.recordBtnActive, pressed && styles.pressed]}
                >
                  <Text style={styles.actionBtnText}>
                    ⏹ 停止（{Math.round((recorderState.durationMillis ?? 0) / 1000)}s）
                  </Text>
                </Pressable>
              ) : (
                <Pressable
                  onPress={() => void startRecording()}
                  style={({ pressed }) => [styles.recordBtn, pressed && styles.pressed]}
                >
                  <Text style={styles.actionBtnText}>
                    {recordingUri ? '🎙 重錄' : '🎙 開始跟讀'}
                  </Text>
                </Pressable>
              )}
              {recordingUri && !recorderState.isRecording && (
                <Pressable
                  onPress={() => void playRecording()}
                  style={({ pressed }) => [styles.actionBtn, pressed && styles.pressed]}
                >
                  <Text style={styles.actionBtnText}>▶ 我的錄音</Text>
                </Pressable>
              )}
              {recordingUri && !recorderState.isRecording && (
                <Pressable
                  onPress={() => void playSegment(1)}
                  style={({ pressed }) => [styles.actionBtn, pressed && styles.pressed]}
                >
                  <Text style={styles.actionBtnText}>▶ 原音對照</Text>
                </Pressable>
              )}
            </View>
          </View>

          {/* Step e — 評分 */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>這句的掌握度</Text>
            <View style={styles.row}>
              <Pressable
                onPress={() => onGrade('again')}
                style={({ pressed }) => [styles.gradeAgain, pressed && styles.pressed]}
              >
                <Text style={styles.gradeText}>再來一次</Text>
              </Pressable>
              <Pressable
                onPress={() => onGrade('good')}
                style={({ pressed }) => [styles.gradeGood, pressed && styles.pressed]}
              >
                <Text style={styles.gradeText}>記住了</Text>
              </Pressable>
              <Pressable
                onPress={() => onGrade('easy')}
                style={({ pressed }) => [styles.gradeEasy, pressed && styles.pressed]}
              >
                <Text style={styles.gradeText}>太簡單</Text>
              </Pressable>
            </View>
          </View>
        </>
      )}
    </ScrollView>
  );
}

const C = {
  bg: '#0C1117',
  card: '#161D26',
  border: '#243244',
  text: '#E8EDF4',
  dim: '#8A97A8',
  accent: '#4ADE80',
  accentDark: '#14532D',
  primary: '#3B82F6',
  danger: '#EF4444',
  amber: '#F59E0B',
};

const styles = StyleSheet.create({
  root: { flex: 1 },
  scrollContent: { paddingBottom: 32 },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    paddingHorizontal: 24,
  },
  centeredScroll: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    paddingHorizontal: 24,
    paddingVertical: 24,
  },
  bigEmoji: { fontSize: 44 },
  title: { color: C.text, fontSize: 20, fontWeight: '800' },
  dimText: { color: C.dim, fontSize: 13, lineHeight: 20, textAlign: 'center' },
  errorText: { color: C.danger, fontSize: 13, marginBottom: 8 },

  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 16,
  },
  progress: { color: C.dim, fontSize: 13, fontWeight: '600' },
  badges: { flexDirection: 'row', gap: 6 },
  chip: {
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  chipStrong: { backgroundColor: '#7C2D12' },
  chipStreak: { backgroundColor: '#7C2D12' },
  chipWeak: { backgroundColor: C.card, borderWidth: 1, borderColor: C.border },
  chipReview: { backgroundColor: '#1E3A8A' },
  chipDiag: { backgroundColor: C.accentDark },
  chipText: { color: C.text, fontSize: 11, fontWeight: '700' },

  episodeTitle: { color: C.text, fontSize: 16, fontWeight: '700', marginTop: 12 },
  windowText: {
    color: C.dim,
    fontSize: 12,
    marginTop: 4,
    fontVariant: ['tabular-nums'],
  },

  section: {
    backgroundColor: C.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: C.border,
    padding: 14,
    marginTop: 14,
  },
  sectionTitle: {
    color: C.dim,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1,
    marginBottom: 10,
  },
  row: { flexDirection: 'row', gap: 10, flexWrap: 'wrap' },
  rowWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  },
  rowCenter: { flexDirection: 'row', alignItems: 'center' },

  confirmPrompt: {
    color: C.text,
    fontSize: 17,
    fontWeight: '600',
    lineHeight: 26,
    marginBottom: 16,
  },
  primaryBtn: {
    backgroundColor: C.accent,
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
    marginBottom: 10,
  },
  primaryBtnText: { color: '#06220F', fontSize: 16, fontWeight: '800' },
  ghostBtn: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: C.border,
    paddingVertical: 14,
    alignItems: 'center',
  },
  ghostBtnText: { color: C.dim, fontSize: 15, fontWeight: '600' },

  actionBtn: {
    backgroundColor: '#1E2A38',
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  stopBtn: {
    backgroundColor: '#3F1D1D',
    borderWidth: 1,
    borderColor: C.danger,
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  actionBtnText: { color: C.text, fontSize: 15, fontWeight: '700' },

  maskBox: {
    backgroundColor: '#0F1620',
    borderWidth: 1,
    borderColor: C.border,
    borderStyle: 'dashed',
    borderRadius: 10,
    paddingVertical: 22,
    alignItems: 'center',
  },
  maskText: { color: C.dim, fontSize: 14, fontWeight: '600' },
  contextText: { color: C.dim, fontSize: 14, lineHeight: 21 },
  focusText: {
    color: C.text,
    fontSize: 17,
    lineHeight: 26,
    fontWeight: '600',
    marginVertical: 6,
  },

  diagnosisCard: {
    marginTop: 12,
    backgroundColor: '#0F1B14',
    borderWidth: 1,
    borderColor: C.accentDark,
    borderRadius: 10,
    padding: 12,
    gap: 8,
  },
  diagFocus: { color: C.accent, fontSize: 15, fontWeight: '800' },
  diagText: { color: C.text, fontSize: 14, lineHeight: 21 },
  diagTip: { color: C.dim, fontSize: 13, lineHeight: 19 },

  recordBtn: {
    backgroundColor: '#312E81',
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  recordBtnActive: {
    backgroundColor: '#7F1D1D',
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },

  gradeAgain: {
    flex: 1,
    backgroundColor: '#3F1D1D',
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
  },
  gradeGood: {
    flex: 1,
    backgroundColor: '#14532D',
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
  },
  gradeEasy: {
    flex: 1,
    backgroundColor: '#1E3A8A',
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
  },
  gradeText: { color: C.text, fontSize: 15, fontWeight: '800' },

  statsBox: {
    backgroundColor: C.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: C.border,
    padding: 16,
    gap: 8,
    alignSelf: 'stretch',
  },
  statLine: { color: C.text, fontSize: 14, lineHeight: 21 },
  statNum: { color: C.accent, fontWeight: '800' },

  freshBox: {
    alignSelf: 'stretch',
    backgroundColor: C.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: C.border,
    overflow: 'hidden',
  },
  freshHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 14,
  },
  freshTitle: { color: C.text, fontSize: 15, fontWeight: '700' },
  freshChevron: { color: C.dim, fontSize: 14 },
  freshBody: { paddingHorizontal: 14, paddingBottom: 14, gap: 12 },
  freshHint: { color: C.dim, fontSize: 13, lineHeight: 20 },

  pressed: { opacity: 0.7, transform: [{ scale: 0.98 }] },
});
