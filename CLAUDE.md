# Project Echo（工作代號）— daily-learn-app

英語學習創業專案。以「重聽 = 聽不懂的隱性訊號」為核心洞察的 podcast 學習 app，
漸進發展到耳機真實生活模式，終極願景是 AR 眼鏡上的 ambient 英語教練。

## 一句話
> 學習者每按一次返回鍵，就是在告訴我們他哪裡聽不懂——我們是第一個把這個訊號接住的 app。

## 關鍵限制與日期
- 執行窗口：**2026-07-13 → 08-21**（NTU 矽谷探索課程 P3，共 6 週）
- **每週一 09:30–12:30 NTU Day**（SIT office）= 每週進度發表，天然的 weekly sprint 節奏
- **Pre-Demo Day 2026-08-17**（12 分鐘 pitch）= 最終 deadline
- 創辦人為訪客身份（非 Stanford 學生）；entity / 簽證等營運議題記錄在**本機保留的策略筆記**（不在此公開 repo，見資料夾地圖註記）

## 技術決定（已定案，除非有新理由不要重新討論）
- **Expo (React Native) iOS app**：因為 Phase 2 需要耳機遙控事件（AirPods back-15s / 捏一下），只有原生 app 拿得到
- **Supabase**（auth + Postgres + storage）、**Whisper API** ASR、**Claude API** 難點診斷
- 本機已有 IndexTTS-2（用 `/indextts-setup` skill），prototype 階段可免費生成慢速朗讀/示範音檔
- 📐 **每個結構決策都正式記在 `docs/adr/`**（編號、accepted 後不改只 supersede）。動到某區塊前先讀該區的 ADR；領域詞彙以根目錄 `CONTEXT.md` 為準。

## 資料夾地圖
> 🔒 = **本機保留、不在公開 repo**（`.gitignore` 擋掉；含融資/競品/訪談假設/含金鑰路徑的內容）。
> 這些檔在你本機仍在原位，agent 在本機工作照樣讀得到，只是不會被 push。

| 路徑 | 用途 |
| --- | --- |
| `CONTEXT.md` | **領域詞彙表 + 模組地圖 + seam（先讀這個）** |
| `docs/00-vision-and-angle.md` | 目的、角度、三階段願景 |
| `docs/01-product/` | rewind 訊號設計、MVP spec、roadmap |
| `docs/01-product/competitors.md` | 🔒 競品分析（含內部誠實風險） |
| `docs/01-product/architecture.md` | 🔒 系統架構（含本機絕對路徑 / Fish key 位置） |
| `docs/02-execution/six-week-plan.md` | 逐週執行計劃（對齊 NTU Day / Pre-Demo Day） |
| `docs/02-execution/weekly-log/` | 每週實際進度紀錄（NTU Day 發表材料來源） |
| `docs/adr/` | **架構決策紀錄（編號、accepted 後只 supersede）** |
| `docs/03-fundraising/` | 🔒 pitch 大綱、投資人策略、objection FAQ |
| `docs/04-research/` | 🔒 用戶訪談指南與紀錄、技術筆記 |
| `app/` | MVP 程式碼（Expo，W1 開始） |
| `design/` | mockup、demo 影片、視覺資產 |

## 工作慣例
- 每週日晚上更新 `weekly-log/`，週一 NTU Day 直接拿去報告
- 所有 metrics 以 `docs/02-execution/six-week-plan.md` 底部的「可融資里程碑」為準

## Agent skills

### Issue tracker

Issues and PRDs are tracked in this public repository's GitHub Issues; publish only public-safe material. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the five default canonical triage labels. See `docs/agents/triage-labels.md`.

### Domain docs

This repository uses a single-context domain layout. See `docs/agents/domain.md`.
