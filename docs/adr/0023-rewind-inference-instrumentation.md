# ADR-0023 — 鎖屏倒帶推斷先儀器化，這一輪一個門檻都不動

- **Status:** accepted
- **Date:** 2026-08-14

## Context

ADR-0016 用「播放位置忽然往回」推斷控制中心／鎖定畫面的倒帶，2026-08-08 上線。
到 08-14 為止，`replay_events` 裡 **`trigger_source='lockscreen'` 是 0 筆**。

0 筆有兩類完全不同的成因，而目前的程式碼**分不出來**：

1. **上游**：系統控制項根本沒啟用（跳動從未發生），或跳動發生了但 JS 沒收到。
2. **下游**：跳動有送到 JS，但被三道閘中的某一道擋掉。

沒有讀數的情況下，唯一「看起來能做點什麼」的動作是調門檻——那是瞎猜，而且是最貴的
一種瞎猜：把 `SEEK_SETTLE_SEC` 調小會讓遲到生效的自家 seek 被記成外部倒帶，替一句
學習者從沒重聽過的話建出 capture。**幻覺事件比漏記更傷**（ADR-0016 已經寫過這條）。

上游還有一個到今天才看清楚的嫌疑：`setActiveForLockScreen` **是 `expo-audio` 的原生
函式，不是 JS**。`expo-audio` 2026-08-04 才從 `~57.0.0` 拉到 `~57.0.3`，而鎖屏那段
程式碼 08-08 才寫；`runtimeVersion.policy: 'sdkVersion'` **不指紋化原生模組**，所以
新的 JS bundle 一定會被 OTA 推到還沒有那顆函式的舊 build 上。更糟的是原本的寫法：

```ts
setAudioModeAsync({...})
  .then(() => { playerRef.current.setActiveForLockScreen(...); })
  .catch((err) => console.warn('[audio] setAudioModeAsync failed:', err));
```

`setActiveForLockScreen` 一 throw（舊 binary 上它是 `undefined`，呼叫就是 TypeError）
會被報成「**setAudioModeAsync** failed」——錯誤訊息指向一個根本沒出事的函式。這是
「鎖屏 0 筆」查不出來的直接成因之一。

## Decision

**這一輪只做觀測，`SEEK_SETTLE_SEC` / `SEEK_SETTLE_MS` / `EXTERNAL_REWIND_MIN_SEC`
一個都不改。**

1. **記憶體環狀緩衝**（`App.tsx` 模組層，40 筆，**不新增任何 store / AsyncStorage
   key**）。每一次「位置往回跳」都留一筆帳：跳幅、牆鐘時間、單集、三道閘各自的邊際值
   （`gate2_margin_ms`、`gate3_dist`）、判定結果、`AppState`、是否播放中、播放速度。
   **門檻設在 `delta > 0`——連 0.1 秒的抖動都收**：只有全收，才分得出「被閘擋掉」與
   「跳動根本沒送到 JS」。
2. **開機探針**：`setAudioModeAsync` 與 `setActiveForLockScreen` 各自 try/catch，並在
   呼叫前記下 `typeof playerRef.current.setActiveForLockScreen`。`'function'` 以外就
   代表這顆 binary 太舊——那比任何一道閘都更能解釋 0 筆。
   仍然**只呼叫一次** `setActiveForLockScreen`（重複啟用會疊加 command handler，按一次
   往回鍵 seek 好幾次）。
3. **畫面上的讀數**（`App.tsx` 內的 `DevProbes`，掛在 `<UpdateStatus />` 下面，收合時
   一行）：開機探針、今天為什麼沒有題目通知（`getLastQuizStatus()?.summary_zh`）、
   最近 12 筆倒帶判定。沒有複製按鈕（clipboard 要新套件），實測完截圖回報。

**同時更正 ADR-0016 的一句話**：那份寫「純 JS，OTA 可送」。**不正確**——
`setActiveForLockScreen` 是原生函式，OTA 只能送呼叫它的那行 JS，不能送函式本身。

## 三道閘的分析（結論寫下來，但本輪不據此改動）

**閘③ `SEEK_SETTLE_SEC`（±1.5 秒位置比對）是唯一擋得住真鎖屏往回鍵的閘，而且它擋掉
的正是最有價值的那一段。**

`lastCommandedRef` **沒有到期機制**：只有 `seekTo` 寫、只有換集清。所以 app 內每一次
seek（↺15／快轉 30／拖曳／點逐字稿）都會在時間軸上留下一條**永久的 ±1.5 秒死帶**。

一般化：app 內 seek 到 X 之後經過牆鐘 Δ 秒，再按鎖屏往回鍵（固定 10 秒），落點是
`X + Δ·rate − 10`；被閘③吃掉的條件是 `|Δ·rate − 10| ≤ 1.5`：

| 播放速度 | 會被吃掉的 Δ（秒） |
| --- | --- |
| 1.0× | 8.5 – 11.5 |
| 0.85× | 10.0 – 13.5 |
| 0.7× | 12.1 – 16.4 |

「↺15 之後再聽個十秒還是沒懂、再倒一次」正好落在這個窗口裡——而那正是
`captureEngine` 靠 `windowsOverlap` 把 capture 升級成 `strong` 的那個模式。
**這是系統性漏記，不是隨機漏記。**

**閘② `SEEK_SETTLE_MS`（1500ms 時間窗）在鎖屏情境命中率 ≈ 0。** `ignoreJumpUntilRef`
只由 app 內的 `seekTo` 寫；螢幕鎖著時使用者不可能在 1.5 秒內先按到 app 內的鍵。

**閘① `EXTERNAL_REWIND_MIN_SEC = 3` 永遠攔不到系統往回鍵**（那是固定 10 秒，遠在門檻
之上）。它唯一的實質漏記面是**鎖屏進度條的小幅往回拖曳**（`changePlaybackPositionCommand`），
而那是一次真實的「剛剛那句沒抓到」。

**正確的修法不是把 1.5 調小**——那會讓遲到生效的自家 seek 被誤記成外部倒帶——
**而是讓 `lastCommandedRef` 有到期機制**（隨 `ignoreJumpUntilRef` 一起到期，或播放位置
離開目標超過 N 秒後作廢）。**要等環狀緩衝拿到真實資料再動。**

## 比任何閘門更能解釋「0 筆」的兩個上游嫌疑

1. **裝置上的 binary 可能沒有 `setActiveForLockScreen`**（見 Context）。→ 開機探針的
   `lock_screen_fn` 直接回答。
2. **它的失敗被掛錯名字的 `.catch` 吃掉**。→ 本輪已修成兩段各自捕捉。

**可排除的候選**：`replay_events_trigger_source_check` 從 `001_init.sql:60` 就允許
`'lockscreen'`，雲端沒有擋。

## 實測腳本要避開的路徑

- **不要用「app 內按暫停 → 鎖屏按播放」開場。** app 內暫停會 `deactivateSession()`
  （`keepAudioSessionActive` 預設 false）→ 背景被 suspend、JS 凍結；而鎖屏的 play 按鈕
  **不呼叫** `activateSession()`，所以那條路徑可能整個沒聲音，會被誤判成偵測失敗。
- 正確的兩個對照：
  1. **播放中直接鎖屏按往回鍵** → 預期讀數是 `已記錄`。
  2. **app 內 ↺15 → 等約 10 秒 → 鎖屏按往回鍵** → 預期讀數是 `閘③ |Δ|≈0.0`。
- 兩者都看不到任何一筆 → 看開機探針的 `lock_screen_fn`，那就是答案。
- **AirPods 三下（`previousTrackCommand`）根本沒註冊**，按了毫無反應——那不是被閘擋掉，
  是壓根沒接。

## Consequences

- 「lockscreen 0 筆」從一個沒有證據的猜謎，變成**一次實測就能收斂**的問題：讀數會直接
  說出是沒啟用、沒送到 JS、還是被第幾道閘擋掉。
- **緩衝一關 app 就清空**（記憶體、不進 store）。這是刻意的取捨：它是實測期間的儀器，
  不是使用者資料；代價由「讀數要看得到」補上。
- **本輪沒有修好任何漏記。** 閘③的死帶仍然存在，`strong` 升級的那個模式仍然系統性漏記。
  修法（`lastCommandedRef` 到期）已經寫在上面，等資料。
- 開機探針只在**啟動時**量一次。若 `setActiveForLockScreen` 成功但系統之後把控制項讓給
  別的 app，這裡看不出來。
- **線上狀態未能獨立驗證**：Supabase MCP 一台 token 過期、一台指到別的專案。因此
  `difficulty_items = 0` 至少有兩個候選成因（**從沒評分過**／**FK 被
  `captures_strength_check` 擋在雲端外**），本輪**不挑一個當結論**。
- **沒有 supersede 任何 ADR。** ADR-0016 的推斷機制原封不動；本份只更正它「純 JS，
  OTA 可送」那句話，並替它補上讀數。
