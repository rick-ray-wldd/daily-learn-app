# 為什麼先 Expo、之後才 Swift —— 遷移理由書

- **Date:** 2026-08-14
- **讀者：** 投資人、導師、未來的共同創辦人／第一位工程師
- **回答三個問題：** 一開始為什麼選 Expo？之後為什麼要往 Swift 走？為什麼不是現在
  就全部重寫？

---

## 0. 這份文件的證據標準

這份文件會被拿去做技術盡職調查，所以每個宣稱都標了來源，分三級：

- **可核對** —— 指得到 repo 裡的檔案、行號或 git 紀錄，讀者可以自己驗。
- **呼叫端提供** —— 來自本機執行紀錄或線上資料庫，本文件撰寫時未重新查證。
- **待驗證 / 估計** —— 還沒有人做過的事。**不准當成已完成的事引用。**

本文件不會出現「已驗證可編譯」這類措辭。到 2026-08-14 為止，`app/targets/EchoWidget/`
底下 6 個 Swift 檔（1,160 行）**一行都沒有被編譯過**，本機也沒有 Xcode。詳見 §7。

---

## 1. 為什麼不是 web

一句話：**產品的核心訊號在 web 上收不到。**

Echo 的論點是「學習者按返回鍵重聽，就是他沒聽懂的證據」（`CONTEXT.md` §1）。這句話
成立的前提是**我們真的收得到那一下**。ADR-0001（2026-07-13）把三件 web/PWA 拿不到的
能力列成決策理由：

1. **耳機遙控事件**（AirPods 的 back-15s、捏一下）—— Phase 2 的唯一入口。
2. **可靠的背景音訊** —— podcast 使用者九成時間螢幕是關的。
3. **裝置上的 rolling buffer** —— Phase 2 的「真實生活模式」要在本機留住剛剛過去的
   幾十秒聲音。

這不是「原生比較快、比較好看」的偏好題。是**能力有無**的問題：三階段願景（podcast
app → 耳機 → AR 眼鏡）共用同一條 `replay_events` 管線，而後兩階段的 trigger 在瀏覽器
沙箱裡根本不存在。選 web 等於在第一天就把第二、三階段砍掉。

> 可核對：`docs/adr/0001-native-ios-app-over-web.md`；`CONTEXT.md` 的 **Replay event**
> 詞條列出四個 `trigger_source`：`screen` / `headphone` / `lockscreen` / `select`。

---

## 2. 為什麼是 React Native，而不是一開始就 Swift

### 2.1 六週窗口的算術

執行窗口是 2026-07-13 → 08-21，六週，Pre-Demo Day 8/17。這個窗口決定了一件事：
**迭代速度比執行效率重要一個數量級。**

- 改 JS → `eas update --channel preview` → 幾分鐘後使用者手上就是新版。
- 改原生 → 重新編譯 → 上傳 → Apple processing（5–30 分）→ 測試者重新下載安裝。

在一個「每週一要向 15 人的 cohort 報告進度、8/17 要 pitch」的節奏裡，第二條路徑每天
最多跑一兩輪，第一條路徑一天可以跑十輪。ADR-0018 把這件事寫成了拒絕相依的理由：
「這六天的節奏承受不起」——那份 ADR 拒絕安裝 `expo-blur`（Expo 第一方模組），寧可用
三層疊層自己做玻璃材質，**唯一的理由就是不想失去 OTA**。

### 2.2 實際發生的事（可核對，不是假設）

| 事實 | 數字 | 來源 |
| --- | --- | --- |
| 最近一次 EAS Build | 2026-08-04，commit `5dd1ea4`，build number 2 | 呼叫端提供 |
| 那之後的 commit 數 | **10** | 可核對：`git rev-list --count 5dd1ea4..HEAD` |
| 殼（原生 binary）幾天沒換 | **10 天**（08-04 → 08-14） | **混合**：`5dd1ea4` 的日期可核對（`git log --date=short`），但「那之後沒有再出過 build」這件事 git 證明不了，屬呼叫端提供 |

那 10 個 commit 之中，9 個是純 JS／伺服器端的改動，**全部靠 OTA 送達**，包含這些
**看起來很像要重新 build 才做得到**的改動：

| commit | 日期 | 內容 | 為什麼 OTA 送得動 |
| --- | --- | --- | --- |
| `72c4d60` | 08-04 | 窗口化轉錄 + 逐字稿標註 | 純 JS + Edge Function |
| `4c3dfb2` | 08-05 | Apple Podcasts 式播放器、跟讀逐字稿 | 純 UI |
| `d1fd7ce` | 08-07 | **整個導覽架構換掉**（改成外殼式 + 全螢幕逐字稿） | 純 JS（ADR-0015） |
| `abd2dd0` | 08-08 | **接上控制中心／鎖定畫面控制項** | `UIBackgroundModes: ['audio']` 早就在 binary 裡，只是少呼叫一個函式（ADR-0016 Context） |
| `3344e01` | 08-11 | 玻璃材質全面改版、首頁 bento、逐字稿框選 | 疊層自己做，**刻意不裝原生模組**（ADR-0018） |
| `8f24d6e` | 08-12 | 訊號從二級擴成四級 | 純 JS + 一支未套用的 migration |

第 10 個 commit（`45e2383`，08-14，鎖屏複習的原生藍圖）**不在這個論證裡**：它加的是
1,160 行 Swift 加一支 config plugin，而 `app.json` 的 `plugins` 沒有引用它們，所以它們
既沒被 OTA 送出、也沒進殼——它們至今**不在任何一顆 binary 裡**（§7）。

換句話說：**過去十天所有真正送到使用者手上的產品進展，都發生在一顆十天沒動過的
binary 上。** 如果第一天選了 Swift，這九次要嘛變成九次 build，要嘛變成九次「等下一版
一起發」。

> ⚠️ 更正兩則內部說法：
> 1. 先前的內部筆記寫「`5dd1ea4` 之後有 8 個 commit」。實測
>    `git rev-list --count 5dd1ea4..HEAD` = **10**。以 10 為準。
> 2. 「10 個 commit 全部靠 OTA 送達」也是錯的——`45e2383` 加的原生碼一行都沒送出去。
>    正確說法是「**10 個 commit，沒有任何一個換過殼**」。

---

## 3. OTA 為什麼合法、而且技術上做得到

這是投資人最常追問的一點（「你們不是在偷偷繞過 App Store 嗎？」），所以講清楚機制。

### 3.1 iOS 原則上禁止執行下載來的機器碼

三道獨立的門，任何一道都足以擋下：

1. **程式碼簽章涵蓋每一頁可執行記憶體。** 核心在把某一頁標成可執行之前會驗簽章，
   簽章不對就不給執行。
2. **W^X（write xor execute）。** 同一頁記憶體不能同時可寫又可執行。第三方 app 拿不到
   JIT 權限（那是 Safari/WebKit 的特權），所以「先寫進去再跳過去執行」這條路不通。
3. **審查指南 2.5.2** —— app 不得下載、安裝或執行會引入功能變更的程式碼。

### 3.2 但 2.5.2 自己開了一個豁免

指南 2.5.2 明文豁免「由內建的 WebKit / JavaScriptCore 執行的腳本與程式碼」。這不是灰色
地帶或漏洞，是白紙黑字的例外條款，Expo / React Native / Codepush 這整個生態都建立在
它上面。

技術上的對應同樣乾淨：

> **JS bundle 對 iOS 而言是「資料」，不是「程式碼」。**
> Hermes VM 才是那份簽章過的機器碼；它做的事就是去讀那包資料。
> 換資料 → 簽章不動 → 合法。

所以 OTA 不是規避簽章，而是**簽章覆蓋範圍之外的東西本來就可以換**。

### 3.3 界線在哪裡（這條線決定了整份遷移計劃的形狀）

改 Swift → 產出的機器碼變了 → 現有簽章失效 → 必須重新簽章 → 一顆新的 binary。**沒有
任何取巧空間。** `app/targets/RUNBOOK.md` 附錄把這條線寫成一句操作規則：

> 「改 JS 照舊 `eas update --channel preview`。**改 Swift 一定要重 build，OTA 推不動它。**」

這也是為什麼 `app/targets/` 與 `plugins/` 底下的東西目前對建置流程是**完全隱形**的：
`app/app.json` 的 `plugins` 仍然是 `["expo-audio","expo-asset","expo-status-bar"]`
（可核對），`withEchoWidget` 沒有被加進去。RUNBOOK 的原話：「`expo prebuild` /
`eas build` 現在跑起來跟這個資料夾不存在沒有兩樣。」這是**刻意的**——藍圖先寫好，但在
確定要付出「從此不能 OTA」的代價之前不啟用。

### 3.4 TestFlight 不是 OTA 的替代品（常見誤解）

先把事實講對，因為兩邊都常被講錯：

| | 人數上限 | 要不要 Apple 審核 |
| --- | --- | --- |
| **Internal Testing** | 100 人（團隊成員） | **不需要審核** |
| **External Testing** | 10,000 人 | 需要 **Beta App Review** |

所以「TestFlight 一定要等審核」是錯的。但**「TestFlight 跟 OTA 一樣快」也是錯的**——
即使 Internal Testing 免審核，每一版仍然要付：

1. 編譯（EAS 上的完整 iOS build）
2. 上傳到 App Store Connect
3. **Apple processing 5–30 分鐘**（這段完全不在我們控制內）
4. 每位測試者手動更新、重新下載安裝

第 4 項才是真正的殺手：它把「使用者手上是哪一版」變成一件我們無法保證的事。OTA 的
`eas update` 是使用者下次開 app 就自動生效。對一個**每天都要看真實留存數據**的六週衝刺
來說，這兩者不是同一個東西。

補充一個目前的具體限制：`app/package.json` 沒有 `expo-dev-client`（14 個 dependency
逐一可核對）。加上它會讓 14 → 15，本輪明確不加。代價是：**無法在實機上邊改 JS 邊看
Live Activity**。折衷是用 `preview` profile 出 internal build。

---

## 4. Swift 買得到什麼（按價值排序）

### 4.1 把核心訊號從「推斷」變成「量測」 ← 最高價值，也是最有說服力的論證

**問題陳述。** ADR-0016 揭露了一件很不舒服的事：`expo-audio` 的
`MPRemoteCommandCenter` handler 在原生層**直接呼叫 `AVPlayer.seek`，完全不經過 JS**：

```swift
remoteCommandCenter.skipBackwardCommand.addTarget { [weak self] event in
  let seekTime = currentTime - CMTime(seconds: event.interval, ...)
  player.ref.seek(to: seekTime, ...)          // ← JS 這邊什麼都收不到
}
```

也就是說：使用者鎖著螢幕、從鎖定畫面按往回鍵——**這個產品唯一在乎的訊號**——會憑空
消失。而 podcast 使用者絕大多數時間螢幕就是鎖著的。

**目前的補救，以及它的代價。** ADR-0016 選了一條純 JS 的路：每 250ms 取樣播放位置，
「忽然往回超過 3 秒、且不是我們自己送的 seek」就推斷成一筆 `trigger_source:
'lockscreen'` 的 replay event。這套推斷實際佔用的程式碼（`app/App.tsx`，可核對）：

| 位置 | 內容 |
| --- | --- |
| L81–88 | `EXTERNAL_REWIND_MIN_SEC = 3`——純為推斷存在的常數，加 7 行註解解釋為什麼是 3 |
| L188–197 | 三個 ref：`lastTimeRef` / `ignoreJumpUntilRef` / `lastCommandedRef` |
| L218–221 | 換集時把基準歸零（`replace()` 會把位置打回 0，那不是倒帶） |
| L358–360 | `seekTo` 裡兩行防護：先關掉偵測、記下自己的目標 |
| L365–386 | 偵測 effect 本體，含 9 行註解說明為什麼要有它 |

（`SEEK_SETTLE_SEC` / `SEEK_SETTLE_MS` 不列入——它們也服務進度條的追趕邏輯 L312–322，
不是純為推斷而生。）

這套推斷有兩個**已經寫在 ADR 裡的**缺陷：

- **它刻意偏向漏記。** ADR-0016 Consequences：「兩道閘都可能吃掉真的外部倒帶……這是
  刻意的：幻覺事件會替一句學習者從沒重聽過的話建出 capture，比少一筆更傷。」也就是說
  我們**主動選擇低估**自己的核心指標。
- **JS 被 iOS 暫停期間的倒帶會整段漏掉。** 背景音訊模式下 JS thread 通常還活著，但
  **不保證**。

**實測結果（呼叫端提供，本輪嘗試複查失敗：`supabase-echo` MCP token 過期；退而用
`.env` 的 anon key 走 PostgREST 時，計數被 RLS 濾成 0，測不出真實筆數）：**

> 線上 `replay_events` 共 **11 筆，全部是 `'screen'`。`'lockscreen'` 一筆都沒有。**
> 這套推斷自 08-08 上線至今**從未觸發過**。

這個 0 有兩種解釋，而我們**分不出來是哪一種**——這正是問題所在：

1. 使用者（目前只有創辦人一人）真的從來沒從鎖定畫面倒帶過；或
2. 推斷漏掉了它們（兩道閘太保守、或 JS 在背景被暫停）。

**Swift 買到的是：讓這個問題消失。** 約 60 行的原生模組（**估計，不是量測；尚未實作、
未驗證**）自己在 `MPRemoteCommandCenter.shared().skipBackwardCommand` 上註冊一個
observer target、把事件直接 emit 給 JS，就可以把上表整張刪掉：不再有 3 秒門檻、不再有
兩道閘、不再有「偏向漏記」這個內建的自我低估。`trigger_source: 'lockscreen'` 從**推論**
變成**量測**。

ADR-0016 自己已經預告了這個終點：

> 「真的要滴水不漏，得等 `expo-audio` 把 remote command 以事件送進 JS（上游議題），
> 到時這整套推斷就可以拆掉並 supersede 這份。」

也就是說有兩條路可以走到同一個地方：**自己寫原生模組**，或**推一個 PR 給 `expo-audio`
上游**。後者對生態比較好、對我們比較慢。兩條都需要一顆新 binary。

**待驗證的技術細節（不准寫成已知）**：`MPRemoteCommandCenter` 允許同一個 command 掛
多個 target，所以「我們只觀察、讓 expo-audio 繼續負責 seek」在文件上是成立的；但
ADR-0016 已經記過一個相關的坑——`removeTarget(self)` 移不掉 block 形式的 handler。這個
共存方案**沒有在真機上驗證過**。

**為什麼這一項排第一。** 因為它不是加功能，是**修正證據品質**。整個公司的論點是
「我們是第一個把這個訊號接住的 app」。一個從未觸發過的推斷路徑，在盡職調查裡是一個
很難回答的問題。

> 順帶一提，創辦人自己做過的一個 N=12 實驗指向同一個結論。《Shadow Your Perfect Self》
> （CSIE7641 多模態 HCI 期末專案）比較三種 shadowing 條件：C1 母語陌生人 / C2 自己·
> 母語腔 / C3 自己·L1 腔。**主觀上學習者壓倒性偏好自己的聲音**（C3 在 helpful、
> like-me、easiest、comfortable 四個維度全部第一；C1 在任何維度都沒領先過）。但
> **客觀四指標不分離，而且互相矛盾**——原作者自己報的是 **null result**，結論是
> 「**瓶頸是測量，不是動機**」。
>
> 這份實驗**不能**被引用成「Mirror 有效」。它能支持的只有一件事：在這個題目上，
> 把資源投在**量得準**比投在**讓人更想用**更划算。§4.1 就是那件事的工程版本。

### 4.2 Phase 2 的全部

六週計劃 W4 的條目（可核對，`docs/02-execution/six-week-plan.md` L42–43）：

> **真實生活模式 demo**：背景 rolling buffer + AirPods 手勢（技術驗證，拍進 demo 影片用）

這需要 `AVAudioEngine` 的 input tap 持續維護一個裝置上的環形緩衝，並在耳機手勢發生時
把過去 N 秒切出來。**React Native 完全做不到**——不是慢，是沒有這個 API 表面。

這一項的現況要講清楚：RN 側**沒有任何實作**，而且六週計劃的風險段已經把它列為第二順位
可砍項（「再砍：真實生活模式 demo 改用『概念影片』呈現」）。它是**遷移之後才做得到的
事**，不是遷移的前置條件。

### 4.3 Live Activity（鎖屏複習卡）

藍圖已經在 `app/targets/EchoWidget/`（6 個 Swift 檔、1,160 行）+ 自寫 config plugin
`plugins/withEchoWidget.js`，決策記在 ADR-0021。價值明確但**排在第三**，原因寫在
RUNBOOK 的中止條件裡：

> 「Live Activity **不是 8/17 Pre-Demo Day 的必要條件**。既有的每日通知已經覆蓋
> 『提醒』。」

而且它自己帶著 14 條「完全沒有驗證過的事」（`app/targets/README.md` §7），其中兩條
**可能推翻整個設計**：(1) 鎖定狀態下按鈕能不能觸發 intent（Apple 文件說鎖定裝置上按鈕
是 inactive，官方文件與論壇都沒有明確答案）；(2) `LiveActivityIntent` 背景喚醒 RN app
行程時，會不會連帶冷啟 Hermes + 載入整包 JS bundle。README 稱後者為「**本設計最大的
未驗證假設**」。

### 4.4 端上語音辨識（**待評估，未查證**）

端上語音辨識（`SFSpeechRecognizer`）有可能讓轉錄成本歸零。目前的成本
結構是可核對的：`transcribe` Edge Function 檔頭記載 148 分鐘一集用 Whisper 全轉約
**$0.89**，而 Whisper 拒收 >25MB，所以超過約 25 分鐘的單集**整檔轉錄根本不可能**——
ADR-0005 的窗口化不只是省錢，是可行性前提。

**但這一項的所有優勢都是推測。** 端上模型的準確度、對非母語口音的表現、耗電、以及
「窗口化之後我們每次其實只轉 10 分鐘（約 $0.06）」使得節省幅度到底有多大——**一項都
沒查過**。標為待評估，不列入遷移的理由。

### 4.5 Xcode 這個工具本身

- **Instruments 的耗電剖析。** 對一個背景音訊 app，這是真實的下架／負評風險，而且
  目前**完全沒有量測手段**。
- **符號化的 crash report。** 現在拿到的是未符號化的堆疊。
- **迭代速度。** RUNBOOK 附錄記的最短迴圈是 `swiftc -typecheck`（秒級）→
  `npx expo run:ios`（分鐘級），對照現在原生側**唯一**的驗證手段是 `swiftc -parse`
  ——它連不存在的 module 都放行。

---

## 5. Swift 買不到什麼（以及明確不該做的事）

### ❌ 不要用 Swift 重寫 UI

兩個理由，都可以量：

**一、會失去 OTA，而 OTA 是六週窗口內最大的武器。** §2.2 那十天、十個 commit 就是
證據。用 SwiftUI 重寫之後，`3344e01`（玻璃材質全面改版）那種改動每一次都要走一遍
build → processing → 使用者重新下載。

**二、瓶頸不在渲染。** 使用者感受到的等待來自伺服器端：

| 慢的地方 | 在哪 | 換成 Swift 有幫助嗎 |
| --- | --- | --- |
| Whisper 轉錄一個窗口 | `transcribe` Edge Function（`MAX_WINDOW_SEC = 600`） | ❌ 完全沒有 |
| Claude 難點診斷 | `diagnose` Edge Function | ❌ 完全沒有 |
| 逐字稿標註 | `annotate` Edge Function | ❌ 完全沒有 |
| 列表捲動、玻璃疊層 | RN 側 | 沒有人回報過卡頓 |

把 UI 從 RN 換到 SwiftUI，是**在沒有問題的地方付出全部的代價**。

### ❌ 不要為了「原生比較專業」而遷移

這份文件裡每一個遷移理由都對應到一個**具體拿不到的東西**（remote command 事件、
`AVAudioEngine` tap、ActivityKit、Instruments）。沒有對應具體能力的部分，一律留在 JS。

---

## 6. 所以混合架構是什麼形狀

**主動選擇的分工線是「這件事需不需要原生 API 表面」，不是「這件事重不重要」。**

| 留在 JS（可 OTA） | 移到 Swift（要重 build） |
| --- | --- |
| 全部 UI、導覽、玻璃材質層 | remote command 事件 → JS（§4.1） |
| `captureEngine` / `srs` / `selection`（純函式） | `AVAudioEngine` rolling buffer（Phase 2） |
| 逐字稿三來源、診斷呼叫、同步 | ActivityKit / App Intents（ADR-0021） |
| 每日佇列、通知 | （待評估）端上 ASR |

支持這條線的證據，不是形容詞：

1. **ADR-0018 為了守住 OTA，拒絕了 Expo 第一方模組**，寧可用三層疊層自己做玻璃。
   一個「反正之後要遷移」的團隊不會做這個取捨。
2. **ADR-0021 的原生藍圖寫完了，但 `app.json` 的 `plugins` 沒有加進去**（可核對）。
   藍圖與啟用是兩個獨立決策，這正是分工線在運作的樣子。
3. **`lib/liveActivity.ts` 的 `checkEligibility()`** 回傳 `'native-module-missing'` /
   `'ios-too-old'` / `'activities-disabled'`——JS 側從一開始就假設原生模組可能不在，
   「所有原生呼叫都必須 feature-detect，模組不在就整段跳過，不准 crash」。混合是被
   設計進去的，不是事後補的。**但要講清楚它現在只是被寫好、還沒被用上**：沒有任何檔
   import `liveActivity.ts`，這個函式的呼叫端是 0（§6.2、§7）。

### 6.1 遷移的順序與閘門

順序按「發現問題的成本」由低到高排（`app/targets/RUNBOOK.md`）：純語法 → 型別 →
pbxproj 形狀 → 模擬器 → 真機 → EAS。目前卡在第 1 步之前：**本機沒有 Xcode。**

三個閘門（任何一個沒過就不推進）：

- **裝 Xcode 之後的第一次 `swiftc -typecheck`。** RUNBOOK 稱這是「本 runbook 最划算的
  一步」——1,160 行 Swift 至今只跑過 `-parse`。
- **第一次 `expo prebuild` 要在拋棄式副本裡跑**（`/tmp/echo-prebuild`），不在 repo 裡。
- **第一次 `eas build` 不要在快沒時間的時候跑。** 它會多做三件很可能是互動式的事：
  註冊新 bundle id、兩邊開 App Group capability、**兩組 provisioning profile 重新產生**
  （主 app 那組也會，因為 entitlements 變了）。

### 6.2 `runtimeVersion` 的坑（遷移計劃裡最容易致命的一格）

現況可核對：`app/app.json` 是 `"runtimeVersion": { "policy": "sdkVersion" }`，實際值是
`exposdk:57.0.0`。

危險在於：**啟用 `targets/` 之後原生內容變了，但 SDK 版本沒變**，所以 `runtimeVersion`
不會跟著改。結果是 EAS Update 會把「假設原生模組存在」的新 JS，送給一顆**沒有那個模組**
的舊 binary。

repo 目前的緩解手段是 **feature detection**，不是改 policy：`lib/liveActivity.ts` 的
`checkEligibility()`（:673）就是為此存在，模組不在就整段跳過。同類先例已經寫在
`lib/selection.ts` 檔頭（:293「JS bundle 一定比 SQL 早到」）。

> ⚠️ **但這道防線今天的覆蓋率是 0，不能當成已經生效的保護。** 本輪 grep 核對：
> **沒有任何檔 import `lib/liveActivity.ts`**，所以 `checkEligibility()` 一個呼叫端都
> 還沒有（§7 同一件事的另一面）。feature-detect 的效力等於它的呼叫端覆蓋率——
> 「feature-detect 擋得住」要等到有呼叫端、而且在舊 binary 上實測過，才算成立。

至於改 policy：

- `app/targets/README.md` §3 與 ADR-0021 Consequences 的原文都是——若要讓兩者強制對齊，
  得改成 `runtimeVersion.policy: "appVersion"`（或手動指定字串），而且「**那是另一個
  決策，要先寫 ADR**」。
- **repo 內任何地方都沒有出現 `fingerprint` 這個字。** 如果要主張 fingerprint policy
  （它會把原生內容的雜湊納入 runtimeVersion，理論上正好解決這個問題），那是一個
  **新提案**，必須先寫成 ADR 並評估代價，**不能寫成 repo 既有的決定**。

不論走哪條，有一件事是確定的：**啟用 plugin 的那個 commit，必須同時處理 runtimeVersion
的對齊問題，不能分兩次做。**

---

## 7. 誠實紀錄：到今天為止**沒有**發生的事

這一節存在的理由，跟 ADR-0021 那一節同名段落一樣：**這個 repo 的複查已經抓過三次
「宣稱了沒發生的事」。**（「三次」是呼叫端提供的；repo 內唯一寫下次數的 ADR-0021
〈誠實紀錄〉當時記的是**兩次**，第三次應在其後。別把它當成 repo 內可核對的數字。）

| 沒發生的事 | 證據 |
| --- | --- |
| **沒有任何一行 Swift 被編譯過** | 本機 `xcode-select -p` → `/Library/Developer/CommandLineTools`；`xcodebuild -version` → `requires Xcode`；`CommandLineTools/SDKs/` 只有 macOS SDK。1,160 行只跑過 `swiftc -parse`（exit 0），而 `-parse` **不解析 module、不做型別檢查**——同一份檔跑 `-typecheck` 會直接 `error: no such module 'ActivityKit'` |
| **`withEchoWidget` 沒有經過真正的 prebuild** | 已驗證的只有「pbxproj 的形狀」（在合成專案 + 真實 SDK 57 模板上）。那份模板沒跑過 `expo prebuild`、沒有 CocoaPods、沒有 `.xcconfig`。**完全沒有編譯這回事** |
| **原生 build 一次都沒跑過** | `app.json` 的 `plugins` 不含 `withEchoWidget`；最近一次 EAS Build 是 08-04（呼叫端提供），那時 `targets/` 還不存在 |
| **`lib/liveActivity.ts` 不在 Metro graph 裡** | 沒有任何檔 import 它，所以它不在輸出的 `.hbc` 裡。改壞了 `expo export` 照樣全綠。真正涵蓋它的只有 `tsc --noEmit` |
| **鎖定畫面倒帶的推斷從未觸發** | 11 筆 replay event 全是 `'screen'`（呼叫端提供） |
| **migration 006 未套用到線上** | **本輪實查（2026-08-14）**：對線上 PostgREST 打 `captures?select=selection_text` 與 `?select=selection_kind`，兩者都回 `42703`（column does not exist），對照 `?select=id` 正常。兩個 CHECK 約束的內容 anon 端讀不到，那一項沿用 `CONTEXT.md` §4 的紀錄。**因此 `saved`/`selected`/`segmentation` 三種訊號在伺服器端一筆都沒有**——local-first 讓使用者看不出來 |
| **`difficulty_items` 0 筆、真實使用者 1 位** | 呼叫端提供。**本輪查證失敗**：MCP token 過期，改走 anon key 時 RLS 把所有計數濾成 0，測不出真實筆數 |
| **還沒有測試套件** | `CONTEXT.md` §4：`captureEngine` + `srs` 是純函式，應該在任何重構之前先拿到第一批測試 |
| **app icon 仍是 Expo 範本預設圖** | 設計參考線都還印在上面（呼叫端提供） |

**這一節不是自我批評，是遷移計劃的輸入。** §6.1 的三個閘門就是照這張表排出來的。

---

## 8. 被問到時怎麼回答

### 版本 A —— 一句話（pitch 現場、走廊）

> 我們用 React Native 是為了在六週內每天都能改，用 Swift 是為了拿到耳機和鎖定畫面的
> 事件——那是我們核心訊號的來源，React Native 拿不到。

### 版本 B —— 被追問時（30 秒）

> 一開始就排除 web，因為 Phase 2 的耳機手勢在瀏覽器裡不存在。在原生的框架裡選
> React Native，是因為 JS bundle 對 iOS 而言是資料不是程式碼，所以可以合法 OTA——
> 過去十天我們出了十個 commit，包括整個導覽架構換掉，binary 一次都沒重新 build。
>
> 現在要往 Swift 走，是因為有一件事 JS 拿不到：使用者從鎖定畫面按往回鍵時，
> `expo-audio` 是在原生層直接 seek，完全不經過 JS。我們現在靠「播放位置忽然往回」
> 推斷，而且刻意調得保守——結果是線上 11 筆 replay event 全是螢幕上按的，鎖定畫面
> 一筆都沒有。約 60 行 Swift 可以把整套推斷刪掉，把那個訊號從推論變成量測。
>
> 但我們不重寫 UI。重寫 UI 會失去 OTA，而瓶頸在 Whisper 轉錄，不在渲染。

### 版本 C —— 對工程師

> **為什麼不是 web：** `replay_events` 有四個 `trigger_source`，其中 `headphone` 和
> `lockscreen` 在瀏覽器沙箱裡沒有 API 表面。Phase 2 要 `AVAudioEngine` 的 input tap
> 維護裝置上的環形緩衝，這個更不可能。ADR-0001。
>
> **為什麼 RN 而不是 Swift：** 指南 2.5.2 禁止下載可執行碼，但明文豁免由
> JavaScriptCore 執行的腳本。機制上：程式碼簽章涵蓋可執行頁、W^X 擋掉自我修改，
> 但 Hermes VM 本身是已簽章的機器碼，JS bundle 對它而言是資料。換資料不動簽章。
> 我們把這條槓桿用到極限——ADR-0018 為了守住 OTA，連 `expo-blur` 都沒裝，用底填 +
> 1px 上緣高光 + hairline 三層疊出玻璃。
>
> **TestFlight 不能取代 OTA：** Internal Testing 100 人不用審核，但每版還是要付編譯 +
> 上傳 + Apple processing 5–30 分 + 測試者手動更新。第四項讓「使用者手上是哪一版」
> 變成不可控。
>
> **Swift 的第一順位不是 Live Activity，是 remote command。** `expo-audio` 的
> `MPRemoteCommandCenter` handler 直接呼叫 `AVPlayer.seek`，JS 收不到。ADR-0016 用
> 250ms 取樣「位置往回 >3 秒且不是自家 seek」推斷，兩道閘都在 ref 上（state 有一格
> 延遲會誤判自家 ↺15）。ADR 明說偏向漏記——幻覺事件比漏記更傷。實測 11 筆全是
> `'screen'`，這條路徑上線六天從未觸發。自己註冊一個 observer target 就能刪掉
> `App.tsx` L188–197 + L358–360 + L365–386 那一整套。**這是估計，還沒實作，而且
> `removeTarget(self)` 移不掉 block handler 這個坑已經被記過一次。**
>
> **不做的事：** 不用 SwiftUI 重寫 UI。會失去 OTA，而且慢的地方是 `transcribe`
> Edge Function（Whisper，`MAX_WINDOW_SEC = 600`），不是渲染。
>
> **遷移的第一個閘門不是寫程式，是裝 Xcode。** 1,160 行 Swift 至今只跑過
> `swiftc -parse`，那連 module 都不解析。啟用 plugin 的那個 commit 必須同時處理
> `runtimeVersion` 對齊——現在是 `sdkVersion` policy，加原生模組不會改變它，
> 新 JS 會被送到沒有那個模組的舊 binary 上去。目前的緩解是 feature-detect
> （`checkEligibility()`），改 policy 是另一個還沒寫的 ADR。

---

## 附錄：本文件引用的來源

| 宣稱 | 來源 |
| --- | --- |
| 為什麼不是 web | `docs/adr/0001-native-ios-app-over-web.md` |
| 為什麼守住 OTA 值得放棄第一方模組 | `docs/adr/0018-glass-material-layer.md` |
| remote command 不經過 JS、推斷的兩道閘、偏向漏記 | `docs/adr/0016-remote-controls-and-inferred-rewind.md`；`app/App.tsx` L81–88 / L188–197 / L358–360 / L365–386 |
| Live Activity 的決定與未驗證清單 | `docs/adr/0021-lock-screen-review-live-activity.md`；`app/targets/README.md` §7（14 條）、§8 |
| 「改 Swift 一定要重 build」、遷移步驟與中止條件 | `app/targets/RUNBOOK.md` |
| `runtimeVersion` 現況 | `app/app.json` |
| plugins 不含 `withEchoWidget` | `app/app.json` |
| 沒有 `expo-dev-client`、14 個 dependency | `app/package.json` |
| Whisper 成本與 25MB 上限 | `app/supabase/functions/transcribe/`（檔頭） |
| Phase 2 的 W4 條目 | `docs/02-execution/six-week-plan.md` L42–43 |
| 四個 `trigger_source`、四級 strength | `CONTEXT.md` §2 |
| commit 數與日期 | `git log` / `git rev-list --count 5dd1ea4..HEAD` |
| 11 筆 replay event 全是 `'screen'`、`difficulty_items` 0 筆、真實使用者 1 位、最近一次 build | 呼叫端提供。**本輪嘗試複查失敗**：`supabase-echo` MCP token 過期；改用 anon key 走 PostgREST 時 RLS 把計數濾成 0（ADR-0013），測不到真實筆數 |
| migration 006 未套用到線上 | **本輪實查**：`captures.selection_text` / `selection_kind` 皆回 `42703` |
| 《Shadow Your Perfect Self》N=12 | 創辦人 CSIE7641 期末專案報告（**null result**，不在此 repo 內） |
