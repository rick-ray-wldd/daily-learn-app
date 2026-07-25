# MVP Spec — Phase 1 Podcast App（6 週版）

## 核心循環（唯一重要的事）
```
聽 podcast → 按返回鍵 → app 靜默擷取 → 隔天早上 10 分鐘練習 → 感覺進步 → 繼續聽
```
每一個功能決策都問：有沒有讓這個循環更順？沒有就砍。

## 用戶故事
在美國際學生 Ray，每天通勤聽 30 分鐘 podcast。以前重聽完就過去了；
現在每次重聽都被 Echo 接住，隔天早餐時花 10 分鐘：滑掉 2 個誤報、
跟讀 3 句連音、複習 4 張單字卡——全部來自他自己昨天真實聽到的內容。

## 功能範圍
### P0（W1–W3，沒有這些就不算 MVP）
- [ ] Podcast 搜尋/訂閱（iTunes Search API + RSS 解析）
- [ ] 播放器：播放/暫停、back 15s、倍速（0.7x–2x）、背景播放、lock screen 控制
- [ ] Rewind 事件紀錄（含耳機遙控觸發的 skip-back —— 這個事件跟 Phase 2 同源）
- [ ] Capture pipeline：Whisper ASR（優先用 RSS `podcast:transcript` 省成本）
      → 句子對齊 → Claude 診斷分類
- [ ] Daily session：確認/滑掉 → 逐句練習（重聽原速/慢速 → 看逐字稿 →
      shadowing 錄音 → SRS 卡）
- [ ] 基本 streak + 每日推播（「你昨天存了 5 個難點，花 8 分鐘清掉」）

### P1（W4–W5，demo 加分項）
- [ ] **Mirror 模式**：難句用「你自己的聲音」合成流利版（原聲 → 自聲流利版 →
      跟讀錄音三段對照）。Prototype 用本機 IndexTTS-2 夜間批次生成，
      production 走 Fish Audio——完整技術路徑見 `architecture.md`
- [ ] 真實生活模式 demo：背景 rolling buffer + AirPods 手勢擷取（技術驗證版，
      給投資人看的 vision proof，不求穩定上架）
- [ ] Shadowing 發音比對回饋（錄音 vs 原音，先用簡單的 ASR 比對）
- [ ] 個人弱點儀表板（「你的難點 62% 是連音」）

### 明確不做（抵抗誘惑）
- 社交、排行榜、AI 對話角色扮演、自製課程內容、Android、多語言（先只做英語，
  UI 中英即可）

## 技術架構
```
Expo (React Native, iOS 優先)
├─ expo-av / react-native-track-player（背景播放 + remote events）
├─ Supabase：auth、Postgres、storage（音檔切片）、edge functions
├─ Whisper API：ASR（無官方逐字稿時）
├─ Claude API：難點診斷分類 + 練習內容生成
└─ PostHog（或 Supabase events）：行為分析
```
Prototype 期可用本機 IndexTTS-2 生成慢速示範朗讀（`/indextts-setup`）。

## 資料模型草稿
- `episodes`：podcast metadata、audio_url、transcript（快取）
- `replay_events`：user、episode、from_pos → to_pos、ts、播速、觸發來源（螢幕/耳機）
- `captures`：episode、時間區間、句子文字、音檔切片、訊號強度、狀態
  （pending / confirmed / dismissed）
- `difficulty_items`：type（vocab/linking/speed/grammar/accent/culture）、內容、
  SRS state（ease、interval、due）
- `practice_sessions`：日期、完成率、耗時

## 北極星與關鍵指標
- **北極星：每週完成的 daily session 數 / 活躍用戶**
- captures/日/活躍用戶（訊號有沒有在流動，目標 ≥3）
- confirm rate（訊號準不準，目標 ≥60%，太低=雜訊過濾要修）
- D1 / D7 留存（投資人第一個問的數字，D7 目標 ≥25%）
- Session 完成率（練習設計好不好，目標 ≥50%）
