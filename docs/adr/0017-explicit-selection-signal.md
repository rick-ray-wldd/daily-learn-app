# ADR-0017 — 框選是既有訊號的最強一級，不是新的管線

- **Status:** accepted
- **Date:** 2026-08-11

## Context

倒帶是隱性訊號：它告訴我們「他在第 T 秒卡住了」，但不告訴我們卡在哪幾個字。
`captureEngine` 只能退而求其次，把 `[T-15, T]` 這十五秒整段交給診斷，讓 Claude
再猜一次「難點在哪」。實測下來這一步是整條鏈上最不準的環節——一段十五秒的話裡
可能有三個候選難點，猜錯就等於隔天的練習卡在練錯的東西。

逐字稿頁已經有全文，學習者只要點兩下就能指出是哪幾個字。問題是：**這個新動作
應該被建模成什麼？**

三個選項：

1. 新開一張 `selections` 表 + 新的元件狀態機 + 新的診斷入口。
2. 沿用 capture，但用一個獨立的 boolean 欄位（`is_manual`）標記來源。
3. 沿用 capture，把它放進既有的 `strength` 階梯。

## Decision

**一、採用第三個：框選 = `strength: 'selected'`，是 weak → strong 之上的第三級。**

```
weak      倒帶了                        （可能只是分心）
strong    倒帶 + 10 秒內降速或開逐字稿  （幾乎確定沒聽懂）
selected  倒帶 + 開稿 + 親手圈出哪幾個字（他自己說的，沒有推測成分）
```

具體承諾（migration 006 + `lib/selection.ts`）：

- **ADR-0003 的單一 replay-event 管線不變**，框選只是多一個
  `trigger_source: 'select'`。它是唯一不伴隨播放位置變動的來源。
- `window_start/window_end` = **被框的那一句**的 `segment.start/end`，不是
  `[T-15, T]` 窗口。這是框選比倒帶精確的地方，也是它存在的理由。
- `status` 直接是 `'confirmed'`：練習頁的 confirm 步驟問的是「這段是真的沒聽懂
  嗎」，而框選就是學習者親手回答了那一題。
- 框到的字存進新欄位 `selection_text`，**不覆寫 `transcript_text`**（後者仍是整句，
  診斷需要上下文）。
- 使用者意圖存進 `selection_kind`（`vocab` / `grammar`），**刻意不重用**
  `DiagnosisType` 的六個值——那六個是 app 的判斷結果，這一欄是學習者自己說的。
  兩者不一致（他圈了一個詞、診斷認為難在連音）本身就是有價值的資料。
- 框選**不呼叫 `ingestReplayEvent`、不 seek、不 pause**。前者會依 `[T-15, T]`
  另建一筆 weak capture 並可能與這一筆合併，把精確的一句話變回模糊的十五秒；
  後兩者會被 ADR-0016 的外部倒帶推斷誤判成鎖屏倒帶。

跨句選取不支援：每一句是 FlatList 的獨立列，跨列做不出連續的色塊，而且
`window_start/window_end` 一旦跨句就失去「那一句」的意義。

**二、手勢是「點頭、點尾」兩次獨立的 tap，不是長按拖曳。**

系統原生的文字選取（長按叫出把手、拖曳兩端）是使用者最熟的做法，但這裡不做。
狀態機只有四態、兩個純量（`anchor` / `focus`，`-1` = 未設）：

```
idle      一般閱讀，點一句 = tap-to-seek
armed     選取模式開著，還沒點頭
anchored  點了頭，範圍就是 [anchor, anchor]   ← 動作列已經出現
ranged    頭尾都有，[min, max] 全部高亮
```

三個理由，重要性由高到低：

1. **手勢仲裁。** 逐字稿是一個垂直捲動的 FlatList，而拖曳選取必須在捲動中途搶下
   responder。RN 沒有任意 token 範圍的原生選取把手，自己做等於 `PanResponder`
   ＋ 逐 token 的命中測試 ＋ 邊緣自動捲動，三者都要跟外層清單搶同一根手指。
   本輪的 `VolumeSlider` 已經示範過這類仲裁多容易做錯（`onStartShouldSetPanResponder`
   回 true 會讓垂直拖曳被吃掉，因為 RN 在既有 responder 存在時**不會**把
   `onMoveShouldSetPanResponder` 派給 responder 自己）。tap 完全不參與仲裁。
2. **單手可用性。** 這個 app 的使用情境是通勤時單手持機。拇指壓住起點再拖到終點，
   手指正好蓋住自己要圈的字，範圍的終點在拇指底下看不見。兩次獨立的 tap 每一次
   都看得見結果，而且點錯了再點一次就好——不必整段重拖。
3. **對應既有的跨度模型。** capture 的窗口本來就是 `[start, end]` 兩個端點，不是
   一條連續軌跡。兩點 tap 與資料模型同構：沒有中間態要維護，也不必在拖曳的每一幀
   重算切片。點頭自己＝往回收一階（有範圍收成單字，只剩頭就取消），連取消都不需要
   第三種手勢。

配套：**長按仍然是進入選取的主要入口**（看到聽不懂的那一句直接壓住，不必先找開關），
但長按只負責「鎖定哪一列」，不承載範圍。標題列另有一顆「框選」開關給第二條路；按下
它的**那一刻** tap-to-seek 就得停用，否則使用者以為進了選取模式，點第一句卻跳了播放
位置。`anchored` 就讓動作列出現，因為只圈一個字是最常見的情況——若非得點兩個字才能
送出，單字反而變成最難表達的東西。

## Consequences

- **下游一行都不用改。** 診斷、SRS、每日 session 對 `selected` 的 capture 與對
  `strong` 的完全一樣，因為它就是一筆 capture。代價是每一處 `=== 'strong'` 的
  二分法都要重看 else 分支——三態不能再用二分法（`screens/Practice.tsx` 的
  排序與強度標籤已在本輪修正）。
- **confirm rate 這個指標的定義變了。** 框選來的卡片天生 `confirmed`，若把它算進
  分母，這個數字會被灌水成「使用者有多常用框選」。本輪已經照做：`Practice.tsx`
  的確認率另跑一次 `computeWeaknessStats(captures.filter(c => c.strength !== 'selected'))`，
  首頁本週漏斗也把 `selected` 整筆排除（不能只從 `rewinds` 扣，否則
  `mastered ≤ confirmed ≤ rewinds` 這個不變式會破——框選來的卡天生就是 confirmed）。
  文案跟著改成「倒帶確認率（框選不計入）」，因為一個沒說清楚分母的比率比沒有還糟。
  難點總數與診斷類型分布**仍然含框選**：那些都是真的難點，只有「倒帶猜得準不準」
  這個問題不該讓框選回答。
- **兩點 tap 的代價是使用者要先學會。** 沒有系統原生的選取把手，就沒有現成的
  affordance。靠 `anchored` 立刻出現的動作列與提示列教；若實機上證明學不會，正確的
  修法是把提示做得更明顯，而不是回頭做拖曳——拖曳的手勢仲裁問題不會因為使用者
  熟悉它就消失。圈很長的一段要點兩次也是刻意的：值得框的東西本來就短。
- **綠色的語意被撐開但沒有被稀釋。** `accentSurface`（選取底色）與 `accent`
  是同一件事的兩種表面：學習者動手了。琥珀（app 在猜）與它**永遠不會同時出現在
  同一個字上**——選取模式一開，琥珀標註就先讓位，否則「證據 vs 推測」這條產品
  唯一的分界線會被抹掉。
- **兩次遠端 upsert 是暫時的技術債。** `store.ts:syncCapture` 不認得兩個新欄位，
  而 `store.ts` 在本輪的平行作業中不屬於任何人，所以 `lib/selection.ts` 自己補寫
  一次。兩次各自只設自己知道的欄位，`on conflict (id) do update` 不會互相抹掉，
  先後到達都安全。下一輪併回 `syncCapture`。
- ⚠️ **migration 006 還沒套用到線上專案，而後果比這裡原本寫的嚴重。**
  這一條原本寫「缺欄位時只有補寫那一次會失敗」——**那是錯的**，已用 app 自己的
  anon key 對線上專案實測：`select selection_text` 回
  `42703 column captures.selection_text does not exist`，而兩張表的 CHECK 約束
  也還是舊集合，所以 `strength='selected'` 與 `trigger_source='select'` 會各自撞
  `23514`。也就是**三次遠端寫入全部被拒**（`syncCapture` / `syncSelectionColumns` /
  `syncReplayEvent`），三處都只 `console.warn`，UI 一律回報成功。
  使用者端確實沒有壞——ADR-0004 的 local-first 照常成立，本地 store 仍是真相——
  但**線上的框選資料是空的**，任何跑在 Postgres 上的分析都看不到這一級訊號。
  唯一的修法是把 006 套上去；**刻意不做**「降級成 `'strong'` / `'screen'` 再重送」
  的 fallback，那會寫進一筆從沒發生過的倒帶，正是這份 ADR 要消滅的那種假訊號。
- Phase 2 的耳機捏一下、Phase 3 的眼鏡指認都可以直接接成 `selected`，不需要新表。

**這一輪（W6 改版）沒有 supersede 任何 ADR。** 逐條交代，免得日後靠猜：

- ADR-0003（單一 replay-event 管線）、ADR-0004（local-first）、ADR-0012（一個
  capture 一個 learning focus）：原樣成立，框選只是多一個 `trigger_source`。
- ADR-0011（每日 session 的界線）：不變。框選來的 capture 與倒帶來的走同一套規則，
  當天產生的一樣進搶先練那一層。⚠️ 但「今天的算不算」這個判斷目前有**兩份實作**
  （`screens/Practice.tsx` 的佇列、`App.tsx:computeBadge` 的分頁徽章），本輪只修得動
  前者，所以徽章會多算今天的框選。下一輪應該把它收成一個函式，而不是修第二份。
- ADR-0015（外殼式導覽）：整份有效，只有「mini player 在任何畫面都常駐」這一句被
  ADR-0019 **修訂（amend）為「首頁以外」**——收窄一條 consequence 不算 supersede。
- ADR-0016（外部倒帶推斷）：不變，而且是框選**不 seek、不 pause** 的原因之一。
- 同批的 ADR-0018（玻璃材質層）、0019（三分頁）、0020（首頁的兩種組織原則）
  各自也都沒有 supersede；三份的結尾都自己寫清楚了。

未來真的會發生 supersede 的兩個點，先寫在這裡：`expo-audio` 若把 remote command
以事件送進 JS，ADR-0016 那套推斷可以整包拆掉；面板哪天要浮在封面圖上，ADR-0018
的假毛玻璃就得換成 `expo-blur` 並接受一次 rebuild。
