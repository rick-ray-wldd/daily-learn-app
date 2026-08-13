//
//  EchoReviewAttributes.swift
//  EchoWidget —— **同時編進主 app target 與 extension target**
//
//  鎖定畫面複習卡（「三選一 + 想不起來」）的**資料契約**。改這個檔等於同時改三個地方：
//  SwiftUI 版面（EchoReviewLiveActivity）、App Intent（EchoAnswerIntent）、
//  以及 JS 端的 lib/liveActivity.ts。所以它自己不做任何決定，只描述形狀。
//
//  兩條不准違反的規則：
//
//  ① **正解（correct_id）絕對不准出現在 ContentState。** ContentState 是會被序列化、
//     未來可能經由 push 傳輸的載體；把答案放進去等於把題庫外洩給任何讀得到 payload
//     的路徑。而且我們根本不需要——intent 跑在 app 行程裡，讀得到 App Group 的
//     deck 快照（見 EchoAppGroup.deckKey）。
//
//  ② **ContentState 序列化後必須 < 1 KB。** ActivityKit 的硬上限是 static + dynamic
//     合計 4 KB，超過會拿到 ActivityAuthorizationError.attributesTooLarge，也就是
//     Live Activity 根本開不起來。所以這裡不准放逐字稿片段、音檔路徑、圖片、
//     diagnosis 全文——只放「畫這一格畫面最少需要的字」。
//
//  JSON key 一律 snake_case（顯式 CodingKeys）：JS 端 lib/liveActivity.ts 的
//  LiveActivityContentState 就是這個形狀，兩邊靠這份 key 名稱對上。
//

import ActivityKit
import Foundation

@available(iOS 17.0, *)
struct EchoReviewAttributes: ActivityAttributes {

    /// 一個選項。
    struct Option: Codable, Hashable, Identifiable {
        /// "a" | "b" | "c"。
        ///
        /// 刻意**不用 index**：ContentState 換題時 index 會重用（每題都是 0/1/2），
        /// 而按鈕按下去到 intent 真正跑起來之間有時間差，若 intent 參數帶的是 index，
        /// 撞到已經換過的題目就會把答案記到**錯的卡**上——而且不會報錯，只會靜靜
        /// 產出一筆錯誤的學習訊號。id 是穩定鍵，換題時對不上就整筆丟掉。
        let id: String

        /// 顯示字。≤ 8 個中文字：鎖定畫面一列要塞三顆，超過就會被截字。
        /// 長度由 JS 端（buildDeck）擋，這裡不再截斷——截在這裡等於幫 JS 的 bug 遮醜。
        let labelZh: String

        enum CodingKeys: String, CodingKey {
            case id
            case labelZh = "label_zh"
        }
    }

    struct ContentState: Codable, Hashable {

        /// = Capture.id（UUID）。答案回寫時就是這個鍵。
        let cardId: String

        /// 1-based，只給 header 的 "3/5" 用。分母是 deckLength，永遠 ≤ 5。
        let cardIndex: Int

        /// 英文題面。來源優先序由 JS 端決定（selection_text → focus_phrase），
        /// **絕不是整句逐字稿**——鎖定畫面塞不下，塞下去也讀不完。
        let prompt: String

        /// 恰好 3 個（1 正解 + 2 干擾），順序已經由 JS 端洗過。finished 時是空陣列。
        let options: [Option]

        /// 前一題答對了嗎。第一題是 nil（沒有前一題）。
        ///
        /// 為什麼把「回饋」塞進**下一題**的 state 而不是先揭曉再換題：一次 perform()
        /// 只准做一次 update()。先揭曉再換題需要兩次 update，會吃掉 iOS 18 的更新
        /// 節流預算——那個預算是裝置層級的動態值、Apple 不公布數字，撞到就是使用者
        /// 按了沒反應。合併成一次是唯一能保證每按必有回饋的做法。
        let lastAnswerCorrect: Bool?

        /// 前一題答錯時要顯示的正解中文。答對或第一題為 nil。
        let lastCorrectLabelZh: String?

        /// 整副牌答完了。true 時版面切成結算，options 為空。
        let finished: Bool

        enum CodingKeys: String, CodingKey {
            case cardId = "card_id"
            case cardIndex = "card_index"
            case prompt
            case options
            case lastAnswerCorrect = "last_answer_correct"
            case lastCorrectLabelZh = "last_correct_label_zh"
            case finished
        }
    }

    // MARK: - 靜態屬性
    //
    // 以下三個在 Live Activity 活著的期間**不可變**（ActivityKit 規定：attributes
    // 只在 request() 時給一次，之後只有 ContentState 能更新）。所以任何「每題會變」
    // 的東西都不准放這裡，放了就等於整場只顯示第一題的值。

    /// 一天一副牌，deckId = deckDate（YYYY-MM-DD）。intent 用它挑出「要更新哪一張
    /// activity」（跨日殘留的舊 activity 不該被更新）。
    ///
    /// ⚠️ **deckId 只有「日」的粒度，所以它不足以辨識一副牌。** 同一天內 app 重算
    /// 佇列、把新的一副寫回同一個 DECK_KEY 之後，deckId 一模一樣但 cards 已經換人。
    /// 因此 intent **不會**只靠 deckId 決定要不要收下一個答案——它收的是一組座標
    /// （deckId + cardIndex + cardId），三件都要與當下快照對得上。要把 deckId 變成
    /// 真正的身分（例如加上建牌時戳），得同時改 `lib/liveActivity.ts` 的
    /// `deck_id = today` 契約，那是另一個決策，先不做。
    let deckId: String

    /// header 左側，例如 "Echo · 今日複習"。
    let sourceLabel: String

    /// header 右側的分母。硬性 ≤ 5（ADR-0011 的 N=5）——**不准是 10**。
    /// 分母灌水就是把北極星灌水。
    let deckLength: Int

    enum CodingKeys: String, CodingKey {
        case deckId = "deck_id"
        case sourceLabel = "source_label"
        case deckLength = "deck_length"
    }
}
