/**
 * 每日練習提醒 — expo-notifications 本地排程（Expo Go 可用，SDK 57 查證過）。
 * 策略：一則 DAILY repeating 通知；每次 app 開啟時 cancel 舊的再排新的，
 * 內容用當下 pending 數刷新（本地排程的固有限制：幾天不開 app 內容會過期，
 * 但通知本身每天照響）。
 */
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';

import { getCaptures } from './store';

export const DAILY_REMINDER_HOUR = 8; // 預設 08:00，之後設定頁可調
export const DAILY_REMINDER_MINUTE = 0;
const REMINDER_KIND = 'daily-reminder';

// App 在前景時也顯示 banner（SDK 57：shouldShowAlert 已棄用）
if (Platform.OS !== 'web') {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
  });
}

async function ensurePermissions(): Promise<boolean> {
  const current = await Notifications.getPermissionsAsync();
  if (current.granted) return true;
  if (!current.canAskAgain) return false;
  const req = await Notifications.requestPermissionsAsync({
    ios: { allowAlert: true, allowBadge: true, allowSound: true },
  });
  return req.granted;
}

/** 取消舊提醒＋用最新 pending 數重排。冪等，app 每次開啟呼叫一次即可。 */
export async function syncDailyReminder(): Promise<void> {
  if (Platform.OS === 'web') return;
  try {
    if (!(await ensurePermissions())) return; // 拒絕 → 靜默略過，練習 badge 仍是主迴圈
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync(REMINDER_KIND, {
        name: '每日練習提醒',
        importance: Notifications.AndroidImportance.DEFAULT,
      });
    }
    // 去重：只認 data.kind 標籤，不存 identifier（避免 stale id）
    const scheduled = await Notifications.getAllScheduledNotificationsAsync();
    await Promise.all(
      scheduled
        .filter(
          (r) => (r.content.data as { kind?: string } | null)?.kind === REMINDER_KIND,
        )
        .map((r) => Notifications.cancelScheduledNotificationAsync(r.identifier)),
    );
    const n = getCaptures().filter((c) => c.status === 'pending').length;
    await Notifications.scheduleNotificationAsync({
      content: {
        title: 'Echo 每日練習',
        body:
          n > 0
            ? `你昨天存了 ${n} 個難點，花 8 分鐘清掉`
            : '今天聽 podcast 了嗎？每次重聽都是進步的訊號',
        data: { kind: REMINDER_KIND },
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DAILY,
        hour: DAILY_REMINDER_HOUR,
        minute: DAILY_REMINDER_MINUTE,
        ...(Platform.OS === 'android' ? { channelId: REMINDER_KIND } : null),
      },
    });
  } catch (err) {
    console.warn('[notifications] syncDailyReminder failed:', err); // 通知失敗絕不影響 app
  }
}
