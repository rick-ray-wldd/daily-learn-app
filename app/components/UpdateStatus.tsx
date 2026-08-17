/**
 * UpdateStatus — 這台裝置**現在跑的是哪一顆 JS bundle**，以及一鍵抓最新的。
 *
 * 為什麼要有這個：EAS Update 預設 `fallbackToCacheTimeout = 0`，意思是 app 每次啟動
 * 一定先跑手上那顆 bundle，同時在背景下載新的，**下一次**啟動才套用。所以「我推了
 * 但手機沒變」在畫面上是同一個樣子，實際上有四種完全不同的原因：
 *
 *   1. 還沒第二次冷啟動           → isUpdatePending = true（已下載，等重啟）
 *   2. 新 bundle 一啟動就 crash    → isEmergencyLaunch = true（expo-updates 自動回滾）
 *   3. 沒抓到（網路 / runtime 不符）→ checkError，或 checkForUpdateAsync 說沒有更新
 *   4. 其實已經更新了，只是沒看出來 → updateId 會變，isEmbeddedLaunch = false
 *
 * 沒有這個讀數就只能猜，所以它值得佔畫面上這一行。手動「檢查更新」把「重開兩次
 * 試試看」變成一個確定的動作：檢查 → 下載 → 重啟，三步都會回報。
 *
 * 這是開發期的儀表，不是產品功能：整條字級壓到 caption、顏色用 dim，收合時只有一行。
 */
import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import * as Updates from 'expo-updates';

import { C, R, SP, TYPE } from '../lib/theme';
import { t, useLang } from '../lib/i18n';

/** OTA id 很長，前 8 碼就足夠比對「是不是我剛推的那顆」。 */
function shortId(id: string | null): string {
  if (!id) return '—';
  return id.slice(0, 8);
}

function formatTime(d: Date | null | undefined): string {
  if (!d) return '—';
  try {
    return d.toLocaleString('zh-TW', {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return d.toISOString().slice(5, 16).replace('T', ' ');
  }
}

export default function UpdateStatus() {
  // 訂閱語言：回傳值不用，作用是切換時重繪好讓 t() 重新查表。
  useLang();
  const {
    currentlyRunning,
    isUpdateAvailable,
    isUpdatePending,
    isChecking,
    isDownloading,
    checkError,
    downloadError,
  } = Updates.useUpdates();

  const [open, setOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const embedded = currentlyRunning.isEmbeddedLaunch;
  // 回滾：新 bundle 啟動時炸了，expo-updates 退回上一顆能跑的。這是「推了沒變」
  // 最容易被誤判成「沒下載到」的情況，所以獨立標紅。
  const rolledBack = currentlyRunning.isEmergencyLaunch === true;

  const label = rolledBack
    ? t('update.rolled_back')
    : embedded
      ? t('update.builtin')
      : `OTA ${shortId(currentlyRunning.updateId ?? null)}`;

  const busy = isChecking || isDownloading;

  async function check() {
    setNote(null);

    if (!Updates.isEnabled) {
      setNote(t('update.disabled'));
      return;
    }

    try {
      // 已經下載好、只差重啟的情況不必再跑一次網路。
      if (isUpdatePending) {
        setNote(t('update.applying'));
        await Updates.reloadAsync();
        return;
      }

      setNote(t('update.checking'));
      const result = await Updates.checkForUpdateAsync();
      if (!result.isAvailable) {
        setNote(t('update.none'));
        return;
      }

      setNote(t('update.downloading'));
      const fetched = await Updates.fetchUpdateAsync();
      if (!fetched.isNew) {
        setNote(t('update.same'));
        return;
      }

      setNote(t('update.done_restarting'));
      await Updates.reloadAsync(); // 這行之後 app 會重啟，下面不會執行到
    } catch (err) {
      setNote(t('update.failed', { msg: err instanceof Error ? err.message : String(err) }));
    }
  }

  const error = checkError ?? downloadError;

  return (
    <View>
      <Pressable
        onPress={() => setOpen((v) => !v)}
        hitSlop={8}
        style={styles.pillRow}
      >
        <Text
          style={[
            styles.pill,
            rolledBack && styles.pillWarn,
            isUpdatePending && styles.pillReady,
          ]}
        >
          {isUpdatePending ? t('update.ready') : label}
        </Text>
      </Pressable>

      {open && (
        <View style={styles.card}>
          <Row k={t('update.running')} v={label} warn={rolledBack} />
          <Row k={t('update.published_at')} v={formatTime(currentlyRunning.createdAt)} />
          <Row k="channel" v={currentlyRunning.channel ?? '—'} />
          <Row k="runtime" v={currentlyRunning.runtimeVersion ?? '—'} />
          {rolledBack && (
            <Text style={styles.warnText}>
              {t('update.rollback_note')}
              {currentlyRunning.emergencyLaunchReason ?? t('update.unknown')}
            </Text>
          )}
          {isUpdateAvailable && !isUpdatePending && (
            <Text style={styles.hint}>{t('update.available')}</Text>
          )}
          {error && <Text style={styles.warnText}>{t('update.error', { msg: error.message })}</Text>}
          {note && <Text style={styles.hint}>{note}</Text>}

          <Pressable
            onPress={check}
            disabled={busy}
            style={[styles.button, busy && styles.buttonBusy]}
          >
            {busy ? (
              <ActivityIndicator size="small" color={C.text} />
            ) : (
              <Text style={styles.buttonText}>
                {isUpdatePending ? t('update.restart_to_apply') : t('update.check')}
              </Text>
            )}
          </Pressable>
        </View>
      )}
    </View>
  );
}

function Row({ k, v, warn }: { k: string; v: string; warn?: boolean }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowKey}>{k}</Text>
      <Text style={[styles.rowVal, warn && styles.rowValWarn]} numberOfLines={1}>
        {v}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pillRow: { alignSelf: 'flex-end', marginTop: SP(1) },
  pill: { ...TYPE.caption, color: C.faint, fontWeight: '400' },
  // 琥珀＝app 這邊出了狀況要你知道，跟標註同一套語意（見 theme.ts 檔頭）。
  pillWarn: { color: C.highlightInk },
  pillReady: { color: C.accent },

  card: {
    marginTop: SP(2),
    backgroundColor: C.surface,
    borderRadius: R.md,
    borderWidth: 1,
    borderColor: C.border,
    padding: SP(3),
    gap: SP(1.5),
  },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: SP(3) },
  rowKey: { ...TYPE.caption, color: C.dim, fontWeight: '400' },
  rowVal: { ...TYPE.caption, color: C.text, flexShrink: 1 },
  rowValWarn: { color: C.highlightInk },

  hint: { ...TYPE.caption, color: C.dim, fontWeight: '400' },
  warnText: { ...TYPE.caption, color: C.highlightInk, fontWeight: '400' },

  button: {
    marginTop: SP(1),
    backgroundColor: C.surfaceAlt,
    borderRadius: R.sm,
    paddingVertical: SP(2.5),
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 40,
  },
  buttonBusy: { opacity: 0.6 },
  buttonText: { ...TYPE.caption, color: C.text },
});
