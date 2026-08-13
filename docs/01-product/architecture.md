# 系統架構（MVP → Phase 2 同一套骨架）

> **初稿 2026-07-12 · 部分校正 2026-08-14。**
> 下面的全景圖是**當初的規劃**，不是現況快照。已知落差列在圖後面的〈規劃 vs 現況〉，
> 其餘段落（五個技術決策、Mirror 模式、單位經濟、Phase 2 預留）仍然成立。
> 權威的現況以 `docs/02-execution/roadmap-expo-to-native.md` §1 為準。

## 全景圖
```
┌─────────────────────── iOS App (Expo / React Native) ───────────────────────┐
│                                                                              │
│  播放器模組                 訊號模組                    練習模組              │
│  react-native-track-player  replay_events 收集器         Daily Session UI    │
│  · RSS 訂閱/串流/下載        · 螢幕返回鍵                 · 誤報滑除           │
│  · 背景播放/鎖屏控制         · 耳機遙控 back-15s ◄─┐      · 原速/0.7x 重聽     │
│  · 倍速 0.7x–2x             · 離線佇列→上線同步    │      · Mirror 自聲對照 ⭐ │
│                                                   │      · Shadowing 錄音     │
│  聲音註冊（onboarding 唸 60–90s 短文 → 上傳）       │      · SRS 測驗          │
│                                    Phase 2 同一條事件管線（AirPods 手勢）      │
└───────────────┬──────────────────────────────────────────────▲──────────────┘
                │ events / audio clips                          │ digest / push
┌───────────────▼──────────────── Supabase ─────────────────────┴──────────────┐
│  Postgres: users · voice_profiles · episodes · replay_events · captures      │
│            · difficulty_items · practice_sessions                            │
│  Storage:  音檔切片 · 用戶錄音 · 自聲合成音檔                                  │
│  Edge Functions / Cron（狀態機驅動,capture.status 為軸）:                     │
│   1. ingest      RSS 解析、episode metadata、官方逐字稿抓取(podcast:transcript)│
│   2. transcribe  Whisper API —— 只轉錄 replay 事件 ±2min 窗口(省 10x 成本)     │
│   3. diagnose    Claude API:句子對齊+擷取窗口交集 → 六類難點分類 → 練習內容     │
│   4. daily-digest 每晚 cron:組裝明日 session → 推播                           │
│   5. voice-gen   自聲 TTS(Fish Audio s2-pro, reference_id=用戶 voice_id)      │
└───────────────────────────────────────────────────────────────────────────────┘
```

## 規劃 vs 現況（2026-08-14 校正）

上圖畫的是 7 月的規劃。三處已經不同，**看圖時請以這張表為準**：

| 圖上寫的 | 實際上 | 為什麼 |
| --- | --- | --- |
| `react-native-track-player` | **`expo-audio`** | SDK 57 的 expo-audio 已能背景播放 + 鎖屏控制（ADR-0016），少一個原生相依 |
| Edge Function 有 5 支 | **只有 3 支：`transcribe` / `diagnose` / `annotate`** | 見下 |
| 沒有 `annotate` | **有，而且是呼叫量最大的一支** | 逐字稿的難點詞標註（琥珀色），實際用量遠超其他兩支 |

Edge Function 逐支現況：

| 圖上編號 | 名稱 | 現況 |
| --- | --- | --- |
| 1 | `ingest` | ❌ **沒做**。RSS 解析改在 client 端（`lib/rss.ts`、`lib/podcastSearch.ts`） |
| 2 | `transcribe` | ✅ 已上線。窗口化 Whisper（ADR-0005） |
| 3 | `diagnose` | ✅ 已上線。Claude strict-schema（ADR-0007） |
| 4 | `daily-digest` | ❌ **沒做**。每日提醒改用 `expo-notifications` 的**本地排程**（`lib/notifications.ts`），零伺服器成本 |
| 5 | `voice-gen` | ❌ **沒做**。Mirror 模式尚未實作，`voice_profiles` 表 0 筆 |
| — | `annotate` | ✅ 已上線，圖上漏了 |

> 這張表本身就是一個有用的訊號：**規劃的 5 支裡有 2 支後來證明不需要伺服器**
> （RSS 解析、每日提醒），因為在 client 端做更便宜也更即時。

## 五個關鍵技術決策（與理由）

1. **音檔切片在 client 端做**(ffmpeg-kit / expo-av):聽 podcast 時音檔本來就
   在手機上,切 15 秒上傳比伺服器抓整集再切便宜且簡單。Supabase Edge Function
   是 Deno 跑不了 ffmpeg,這個決策讓我們**不需要任何額外 worker 伺服器**。
2. **窗口式轉錄,不轉整集**:60 分鐘的集只轉 replay 事件周圍 ±2 分鐘。
   Whisper $0.006/min → 每個 capture 約 $0.02,全集轉錄則 $0.36/集。
3. **自聲合成延後到「確認之後」**:capture 當下不生成,等隔天用戶滑掉誤報、
   確認真難點後才對 confirmed items 跑 voice-gen —— TTS credits 只花在真難點上,
   成本控制直接內建在訊號設計裡。
4. **佇列用 Postgres 狀態機**(captures.status: pending→transcribed→diagnosed→
   ready)+ cron 輪詢,不引入額外 queue 服務。規模到了再換 pgmq。
5. **耳機遙控事件從 W1 就接**:iOS remote command events(鎖屏/耳機 back-15s)
   跟螢幕返回鍵寫進同一張 replay_events 表、多存一欄 trigger_source ——
   Phase 2 的真實生活模式只是換了音源,事件管線零改動。

## ⭐ Mirror 模式:用你自己的聲音唸給你聽

**產品邏輯**:聽不懂的句子,隔天你會聽到三個版本 ——
原聲(native)→ **你自己的聲音的流利版**(合成)→ 你剛剛跟讀的錄音。
「聽見已經講得很流利的自己」是模仿目標最強的形式,學術上叫 **golden speaker
effect**:模仿與自己音色相近的聲音,發音習得效率顯著更高。這也是 demo 裡
最起雞皮疙瘩的一刻。

### 技術路徑(兩套都已在本機驗證過,直接搬)

> 📍 **本機補充在 `architecture-local.md`**（gitignore 擋住，不進 repo）：
> IndexTTS-2 的 venv 與權重絕對路徑、TTS 後端 repo 的位置、以及金鑰檔的位置。
> 那些是這台機器上的座標，而且牽涉到另一個專案的內部結構——private repo
> 會加協作者、也可能日後轉公開，所以不該進任何 repo。

**A. Prototype(免費、本地、W2–W3 用)— IndexTTS-2 zero-shot**
- 呼叫方式:`/indextts-setup` skill,venv/權重全就位免安裝
- 用法:`spk_audio_prompt` 餵用戶 60–90s 註冊錄音(zero-shot,不用訓練),
  `text` 餵目標句 → 24kHz WAV。M4 約 14 秒/句,**晚上 cron 批次生成明日
  練習音檔剛好來得及**(batch 防護模式照 skill 裡的 resume-aware 寫法)
- 限制:跑在本機 Mac 上,只能撐 demo/beta,不是 production

**B. Production(上線用)— Fish Audio**
- 已有一條**驗證過的現成管線**可以照抄(克隆腳本 + 批次 TTS 腳本),
  路徑見本機補充
- production recipe:`api.fish.audio/v1/tts`、model `s2-pro`、
  `reference_id=<voice_id>`、429 退避、existsSync 續跑
- 已驗證跨語言克隆(韓語樣本唸中文)→ 中文腔用戶的音色唸
  native 英文 = 我們要的效果,同一原理
- 移植方式:把那兩支腳本的 Fish 呼叫邏輯抽成 Supabase Edge Function
  `voice-gen`(端點/參數照抄,別重新發明)
- ⚠️ 克隆與生成都花 Fish credits、建真實 voice model;上 production 前
  先算單位經濟(見下)

### Onboarding 設計
註冊時唸一段 60–90 秒的固定短文(內容設計成涵蓋常見音素)。這一段錄音
同時是:(a) Fish 克隆樣本(單檔 35s 可跑但 60s+ 品質較穩),
(b) IndexTTS-2 的 spk reference,(c) 用戶的發音基線(之後量測進步用)。

## 單位經濟草稿(每活躍用戶/日,3 個 confirmed captures)
| 項目 | 成本 |
| --- | --- |
| Whisper 窗口轉錄 | ~$0.06 |
| Claude 診斷+練習生成 | ~$0.03 |
| Fish 自聲 TTS(3 句) | ~$0.01–0.03 |
| 合計 | **~$0.10/日 ≈ $3/月** → 訂閱 $12–15/月,毛利健康 |

## Phase 2 預留(不做,但架構上不擋路)
- replay_events.trigger_source 已含 headphone;真實生活模式 = 新增一種
  audio source(rolling buffer)+ 同一條 capture pipeline
- on-device ASR(Apple Speech framework)介面預留,隱私敏感音訊不出裝置
