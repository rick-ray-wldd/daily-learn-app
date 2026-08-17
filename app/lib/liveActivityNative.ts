/**
 * 鎖屏複習卡的**跨橋層** —— `lib/liveActivity.ts` 唯一被允許碰原生的鄰居。
 *
 * ## 為什麼要分成兩個檔
 *
 * `liveActivity.ts` 的鐵律①是「純型別 + 純函式、零 side effect、不碰 NativeModules」。
 * 那條規則是有代價換來的：它讓出題、換題、收割的**規則**可以在沒有裝置、沒有原生
 * 模組的情況下被完整測試。所以跨橋的部分不能寫進去，只能另開一個檔。
 *
 * 這個檔自己的鐵律：**不做任何決定**。payload 由 `liveActivity.ts` 的純函式產生，
 * 這裡原封不動送過去；回來的東西原封不動交回去驗證。它只負責「橋在不在、
 * 怎麼呼叫、失敗了怎麼說」。
 *
 * ## 模組不存在是**常態**，不是錯誤
 *
 * `NativeModules.EchoLiveActivity` 只有在「有跑過 `withEchoWidget` plugin 的
 * binary」裡才存在。而這個 repo 靠 OTA 迭代：同一份 JS 會同時跑在**有**和**沒有**
 * 這個模組的殼上。所以每一支都必須在模組缺席時回一個明確的結果，
 * 而不是丟例外——丟例外會讓一顆舊殼在收到新 JS 的當下整個白畫面。
 *
 * ⚠️ 對應的原生端 `targets/EchoWidget/EchoLiveActivityModule.swift`
 * **從未編譯過**。這裡的每一支都要當成「可能整個不存在」來寫。
 */
import { NativeModules, Platform } from 'react-native';

import {
  MIN_IOS_VERSION,
  NATIVE_MODULE_NAME,
  parseAnswers,
  type EligibilityReason,
  type LiveActivityAnswer,
  type LiveActivityEndPayload,
  type LiveActivityStartPayload,
  type LiveActivityUpdatePayload,
} from './liveActivity';

/** 原生端實作的形狀。與 `EchoLiveActivityNativeModule` 相同，這裡只是拿來上型別。 */
interface NativeShape {
  areActivitiesEnabled(): Promise<boolean>;
  start(payload: LiveActivityStartPayload): Promise<string>;
  update(activityId: string, payload: LiveActivityUpdatePayload): Promise<void>;
  end(activityId: string, payload: LiveActivityEndPayload): Promise<void>;
  listActivityIds(): Promise<string[]>;
  listAnswers(): Promise<unknown[]>;
  deleteAnswers(answerIds: string[]): Promise<number>;
  readCursor(): Promise<number | null>;
}

/**
 * 取原生模組。**每次都重新讀 `NativeModules`**，不快取成 module 常數：
 * 這個檔可能在原生模組註冊完成之前就被 import，快取一個當下的 `undefined`
 * 會讓它在整個 app 生命週期裡都以為模組不存在。
 */
function native(): NativeShape | null {
  const mod = (NativeModules as Record<string, unknown>)[NATIVE_MODULE_NAME];
  return mod ? (mod as NativeShape) : null;
}

export function isNativeModuleAvailable(): boolean {
  return native() !== null;
}

/** iOS 主版號；量不到回 null（`checkEligibility` 收 null 當「不確定」）。 */
export function iosMajorVersion(): number | null {
  if (Platform.OS !== 'ios') return null;
  const major = parseInt(String(Platform.Version), 10);
  return Number.isFinite(major) ? major : null;
}

/**
 * 這台裝置現在能不能起卡。
 *
 * 順序刻意與 `checkEligibility` 一致：先問便宜且確定的（平台、版本），
 * 再問要跨橋的。這樣回傳的 reason 永遠指向**最根本**的那個原因。
 */
export async function probeEligibility(): Promise<
  { ok: true } | { ok: false; reason: EligibilityReason }
> {
  if (Platform.OS !== 'ios') return { ok: false, reason: 'not-ios' };

  const major = iosMajorVersion();
  if (major !== null && major < MIN_IOS_VERSION) {
    return { ok: false, reason: 'ios-too-old' };
  }

  const mod = native();
  if (!mod) return { ok: false, reason: 'native-module-missing' };

  try {
    const enabled = await mod.areActivitiesEnabled();
    return enabled ? { ok: true } : { ok: false, reason: 'activities-disabled' };
  } catch (err) {
    // 橋在、呼叫炸了：當成「關閉」而不是「模組缺席」——後者會讓使用者以為
    // 要重裝 app，實際上他只要去設定裡打開即時動態。
    console.warn('[liveActivityNative] areActivitiesEnabled failed:', err);
    return { ok: false, reason: 'activities-disabled' };
  }
}

export interface StartResult {
  ok: boolean;
  activityId: string | null;
  /** 失敗時給人看的一句話。成功為 null。 */
  error_zh: string | null;
}

/**
 * 起卡。**payload 必須由 `buildStartPayload` 產生**——空 deck 在那支就會丟例外，
 * 這裡不再重複檢查（重複檢查等於把規則寫成兩份）。
 */
export async function startActivity(
  payload: LiveActivityStartPayload,
): Promise<StartResult> {
  const mod = native();
  if (!mod) {
    return {
      ok: false,
      activityId: null,
      error_zh: '這顆 binary 沒有鎖屏卡模組——需要重新 build 並安裝。',
    };
  }
  try {
    const activityId = await mod.start(payload);
    return { ok: true, activityId, error_zh: null };
  } catch (err) {
    return { ok: false, activityId: null, error_zh: nativeErrorZh(err) };
  }
}

export async function updateActivity(
  activityId: string,
  payload: LiveActivityUpdatePayload,
): Promise<boolean> {
  const mod = native();
  if (!mod) return false;
  try {
    await mod.update(activityId, payload);
    return true;
  } catch (err) {
    // 最常見是 E_ACTIVITY_NOT_FOUND：使用者把卡滑掉了。那不是 bug，
    // 呼叫端應該據此忘掉這個 activityId，而不是重試。
    console.warn('[liveActivityNative] update failed:', err);
    return false;
  }
}

export async function endActivity(
  activityId: string,
  payload: LiveActivityEndPayload,
): Promise<boolean> {
  const mod = native();
  if (!mod) return false;
  try {
    await mod.end(activityId, payload);
    return true;
  } catch (err) {
    console.warn('[liveActivityNative] end failed:', err);
    return false;
  }
}

export async function listActivityIds(): Promise<string[]> {
  const mod = native();
  if (!mod) return [];
  try {
    return await mod.listActivityIds();
  } catch {
    return [];
  }
}

/**
 * 收割鎖屏上按過的答案。
 *
 * **驗證一律走 `parseAnswers`**（`liveActivity.ts` 的純函式），這裡不自己驗：
 * 原生端故意回原始 JSON 就是為了讓驗證只有一份實作。
 */
export async function harvestAnswers(): Promise<{
  answers: LiveActivityAnswer[];
  rejected: number;
}> {
  const mod = native();
  if (!mod) return { answers: [], rejected: 0 };
  try {
    const raw = await mod.listAnswers();
    // `parseAnswers` 回的 rejected 已經是**筆數**（number），不是陣列。
    return parseAnswers(raw);
  } catch (err) {
    console.warn('[liveActivityNative] listAnswers failed:', err);
    return { answers: [], rejected: 0 };
  }
}

/** 只刪**已經成功處理過**的那幾筆。回傳實際刪掉的檔數。 */
export async function deleteAnswers(answerIds: string[]): Promise<number> {
  const mod = native();
  if (!mod || answerIds.length === 0) return 0;
  try {
    return await mod.deleteAnswers(answerIds);
  } catch (err) {
    console.warn('[liveActivityNative] deleteAnswers failed:', err);
    return 0;
  }
}

/**
 * 原生錯誤 → 一句人看得懂的中文。
 *
 * code 是 `EchoLiveActivityModule.swift` reject 時給的。**沒對到的 code 一律
 * 原樣顯示**，不要吞成「未知錯誤」——那會讓實機上唯一的線索消失。
 */
function nativeErrorZh(err: unknown): string {
  const e = err as { code?: string; message?: string } | null;
  switch (e?.code) {
    case 'E_ACTIVITIES_DISABLED':
      return '系統設定裡的「即時動態」是關的，請到 設定 → Echo 打開。';
    case 'E_APP_GROUP_UNAVAILABLE':
      return 'App Group 讀不到——entitlement 沒設好，需要重新 build。';
    case 'E_BAD_PAYLOAD':
      return `payload 形狀不對：${e?.message ?? ''}`;
    case 'E_ACTIVITY_NOT_FOUND':
      return '那張卡已經不在了（可能被滑掉）。';
    default:
      return e?.message ?? String(err);
  }
}
