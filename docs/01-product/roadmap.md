# Roadmap：Podcast App → 耳機 → AR 眼鏡

同一套引擎（capture → diagnose → practice），trigger 和內容來源逐步升級。

## Phase 1 — Podcast App（現在 → 6 週）
- Trigger：返回鍵（螢幕 + 耳機遙控）
- 內容：podcast 音檔（乾淨、合法、有逐字稿、零隱私問題）
- 目的：驗證核心循環 + 累積留存數據 + 訓練診斷引擎

## Phase 2 — 真實生活模式（3–9 個月）
- Trigger：AirPods 捏一下/敲擊（iOS remote command events，Phase 1 已在用同一條
  事件管線）
- 機制：app 背景維持 rolling audio buffer（例如最近 60 秒，只在記憶體），手勢
  觸發時才把 buffer 寫入 capture——**沒觸發的音訊永遠不落地**
- 場景：課堂、點餐、smalltalk 中聽不懂 → 捏一下 → 晚上複習「今天那句到底是什麼」
- ⚠️ 隱私/法律：**加州是 all-party consent 州**（錄對話需所有人同意）。設計上：
  (a) buffer-only、不觸發不儲存，(b) on-device ASR 優先（Apple Speech / 本地
  Whisper），(c) demo 一律用自己 + 已同意的朋友。投資人一定會問，答案要熟。

## Phase 3 — AR 眼鏡（12 個月+，願景）
- Trigger：手勢 / 語音 /（終局）自動偵測
- 內容：眼鏡收錄的全天英語對話（含自己說的話 → 文法錯誤偵測 → 每日口說目標）
- 載體賭注:Meta Ray-Ban Display 一代開發生態 / Apple 眼鏡傳聞線。不需要現在
  選邊，需要的是**引擎和個人難點資料在我們手上**——硬體浪潮來的時候，我們是
  最懂「非母語者在真實生活中卡在哪」的公司。

## 為什麼這個順序（pitch 時的說法）
1. Phase 1 六週能做出來、能量化、能拿到留存——先證明「隱性訊號→練習」這個
   循環有人要
2. Phase 2 不需要新硬體：地球上已有十億副藍牙耳機，每一副都是我們的感測器
3. Phase 3 的眼鏡浪潮是「why now」的一部分，但我們的價值不押在特定硬體上，
   押在 capture→diagnose→practice 引擎 + 個人難點圖譜的資料飛輪
