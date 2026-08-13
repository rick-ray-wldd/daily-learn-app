//
//  EchoAnswerIntent.swift
//  EchoWidget —— **同時編進主 app target 與 extension target**
//
//  這是整個功能的心臟：使用者在鎖定畫面按下一顆按鈕時，真正發生的事。
//
//  ⚠️ 一個必須說清楚的前提（很多教學寫錯，本專案的文件也曾寫錯）：
//  App Intent 按鈕**會喚醒 app 行程，只是不進前景**——不是「不喚醒 app」。
//  Apple 明講：`LiveActivityIntent` 的 perform() 跑在 **app 的行程**裡，
//  所以這個型別**必須**加進 app target（extension 那份只是為了讓 Button(intent:)
//  過型別檢查）。漏掉這一步的症狀是：按鈕畫得出來，按下去什麼都不會發生。
//
//  為什麼一定要是 LiveActivityIntent 而不是純 AppIntent：純 AppIntent 跑在 widget
//  extension 行程裡，而那個行程做不到我們要的任何一件事——
//    ① 沙箱不允許 extension 寫共享容器 ⇒「答案寫回 App Group」永遠失敗；
//    ② extension 行程裡 Activity<T>.activities 永遠是空陣列 ⇒ 3/5 → 4/5 更新不了。
//
//  perform() 是**純 Swift**：不需要 RN/JS runtime 起來、不連網、不碰 Supabase。
//  這正是它比通知 action 可靠的地方（通知 action 在 app 被殺掉時不可靠）。
//

import ActivityKit
import AppIntents
import Foundation

@available(iOS 17.0, *)
struct EchoAnswerIntent: LiveActivityIntent {

    static var title: LocalizedStringResource = "回答複習卡"

    /// 不把 app 帶到前景。使用者按完應該還留在鎖定畫面上，繼續答下一題——
    /// 一按就跳進 app 的話，「鎖定畫面上兩秒答一題」這個賣點就不存在了。
    static var openAppWhenRun: Bool = false

    /// 這顆按鈕被**畫出來**的那一刻，畫面上那副牌的 deckId。
    ///
    /// 按鈕必須自己帶著出身，因為 perform() 唯一能看到的另一個東西是 App Group 裡
    /// **當下**那份快照——而那份快照隨時可能已經不是畫按鈕時的那一份了（見 cardIndex）。
    @Parameter(title: "deckId") var deckId: String

    /// 畫按鈕當下這張卡在那副牌裡的位置（**1-based，與 header 的「3/5」同一個數字**）。
    ///
    /// 為什麼光有 cardId 不夠：deckId 只有「日」的粒度（= deckDate），所以同一天內
    /// app 重算佇列、把新的一副牌寫回同一個 DECK_KEY 之後，deckId 完全沒變，
    /// 但 cards 已經換人了。這時鎖定畫面上那顆舊按鈕若只帶 cardId：
    ///   · 那張卡已不在新快照裡 ⇒ 靜靜丟掉，使用者按了完全沒反應；
    ///   · 那張卡還在、但位置變了 ⇒ 答案會被記到**新牌的新位置**上，游標跳號、
    ///     header 的分子與 attributes 的分母對不起來，最後結算還會宣稱「5 張複習完了」。
    /// 跨日也是同一個病根：ADR-0011 的 carryover 會讓同一個 capture 昨天在 index 3、
    /// 今天在 index 0，而昨天的 activity 要到明天 08:00 才 stale。
    ///
    /// 所以 perform() 收到的是一組**座標**（deckId + cardIndex + cardId），三件事都要
    /// 與當下快照對得上才算數。對不上就不是「同一副牌的同一張卡」，一律不記帳。
    @Parameter(title: "cardIndex") var cardIndex: Int

    @Parameter(title: "cardId") var cardId: String

    /// "a" | "b" | "c" | "unknown"（unknown = 想不起來）。
    ///
    /// 為什麼「想不起來」共用同一個 intent 而不是另開一個型別：少一個型別、少一處
    /// 要在兩個 target 註冊，而且它在資料上本來就只是一個 chosenId，不是另一種事件。
    @Parameter(title: "optionId") var optionId: String

    init() {}

    init(deckId: String, cardIndex: Int, cardId: String, optionId: String) {
        self.deckId = deckId
        self.cardIndex = cardIndex
        self.cardId = cardId
        self.optionId = optionId
    }

    func perform() async throws -> some IntentResult {

        guard let deck = EchoAppGroup.loadDeck() else { return .result() }

        // ① 座標對得上今天的牌嗎。**三件都要對**：deckId（哪一副）、cardIndex（第幾張）、
        //    cardId（是不是同一張）。只比 cardId 不夠——deckId 只有日粒度，同一天內
        //    重算的新牌用的是同一個 deckId（理由見 cardIndex 的註解）。
        //    對不上就整筆丟掉：不記帳、不推進游標。陳舊按鈕產生的答案比沒有答案更糟。
        let index = cardIndex - 1
        guard
            deck.deckId == deckId,
            deck.cards.indices.contains(index),
            deck.cards[index].cardId == cardId
        else {
            await resyncStaleActivity()
            return .result()
        }
        let card = deck.cards[index]

        // ② 手上這副牌對應的 Live Activity。找不到不代表可以跳過記帳（見 ④）。
        //    這裡的比對用 deck.deckId 而不是參數的 deckId —— 走到這一行時兩者已經
        //    在 ① 被證明相等，寫成快照那一份是為了讓「真相來自快照」這件事讀得出來。
        let activity = Activity<EchoReviewAttributes>.activities
            .first(where: { $0.attributes.deckId == deck.deckId })

        // ③ "unknown" 不會等於任何 correctId，所以「想不起來」天然是 false。
        let correct = (optionId == card.correctId)

        // ④ **先落地，再更新 UI。** 順序不准反過來：
        //    落地是不可失去的（那是產品唯一的資料資產），UI 是可以重來的
        //    （下一次前景啟動就會重畫）。而且即使 ② 沒找到 activity，
        //    使用者確實按了那一下，這筆訊號就必須留下來。
        //
        //    answerId **不是 UUID，是 (deckId, cardId) 算出來的穩定鍵**，這一點是刻意的：
        //    按鈕從按下去到 activity.update() 落地之間有數百毫秒到一秒的空窗，畫面上
        //    沒有任何按壓回饋（Button 的 label 有 .invalidatableContent()，但那是系統
        //    自己決定要不要畫），使用者很自然會「以為沒反應」再按一次別的選項。若每次
        //    按壓都給一個新 UUID，同一張卡就會產出兩筆 answer_id 不同、chosen_id 互相
        //    矛盾的紀錄，而收割端的 dedupeAnswers 只認 answer_id、兩筆都會放行——
        //    分母被灌水、同一張卡同時被算成「答對」與「想不起來」。穩定鍵讓
        //    「一張卡最多一筆帳」變成檔案系統層級的不變式：同名檔，寫幾次都只有一份。
        let record = EchoAnswerRecord(
            schemaVersion: EchoAppGroup.answerSchemaVersion,
            answerId: EchoAppGroup.answerId(deckId: deck.deckId, cardId: card.cardId),
            deckId: deck.deckId,
            cardId: card.cardId,
            chosenId: optionId,
            correct: correct,
            answeredAt: EchoAppGroup.iso8601(Date()),
            source: EchoAppGroup.sourceLockScreen
        )
        // try? 而不是 try：寫檔失敗（磁碟滿、容器暫時拿不到）不該讓整個 intent
        // 拋錯，那會讓使用者看到系統的失敗提示卻不知道發生什麼事。
        // appendAnswer 是 first-write-wins：第一次按下的那個選擇才是真實訊號。
        try? EchoAppGroup.appendAnswer(record)

        // ⑤ 游標只是給 app 收割時對帳用的，**不是真相**（真相是 ④ 的檔案）。
        //    寫在 activity 的 guard **之前**：使用者確實答完了這一張，找不到 activity
        //    （被使用者滑掉、被系統回收）不該讓對帳用的游標停在舊位置。
        EchoAppGroup.writeCursor(cardIndex)

        guard let activity else { return .result() }

        // ⑥ 下一張。回饋（上一題對不對／正解是什麼）刻意塞進**下一題**的 state，
        //    這樣一次 perform() 只需要一次 update()（理由見 EchoReviewAttributes）。
        let nextIndex = index + 1
        let state: EchoReviewAttributes.ContentState
        if nextIndex < deck.cards.count {
            let next = deck.cards[nextIndex]
            state = EchoReviewAttributes.ContentState(
                cardId: next.cardId,
                cardIndex: nextIndex + 1,
                prompt: next.prompt,
                options: next.options.map {
                    EchoReviewAttributes.Option(id: $0.id, labelZh: $0.labelZh)
                },
                lastAnswerCorrect: correct,
                lastCorrectLabelZh: correct ? nil : card.correctLabel,
                finished: false
            )
        } else {
            state = EchoReviewAttributes.ContentState(
                cardId: "",
                cardIndex: deck.cards.count,
                prompt: "",
                options: [],
                lastAnswerCorrect: correct,
                lastCorrectLabelZh: correct ? nil : card.correctLabel,
                finished: true
            )
        }

        // ⑦ **只呼叫一次 update()。** Apple 明訂：任何時間軸更新所需的程式碼都必須
        //    在 return 之前跑完，所以這裡 await。
        //
        //    答完最後一題也**不要** end()：讓它停在結算畫面，直到 staleDate 或
        //    使用者自己滑掉。要不要結束由 JS 端在下次前景收割完之後決定——
        //    在這裡 end 掉，使用者連「我今天答完了」都來不及看到。
        await activity.update(ActivityContent(state: state, staleDate: Self.nextStaleDate()))

        // ⑧
        return .result()
    }

    /// 座標對不上時的收尾：把**這顆按鈕所屬的那張 activity**標成過期。
    ///
    /// 為什麼不能只是 `return .result()`：那一按會被完全靜默地吞掉——卡片不動、
    /// 沒有任何訊息、也沒有留下紀錄，使用者只會覺得功能壞了。這正好是「每一次按壓
    /// 都被接住」失效的樣子，而那句話是本專案的核心主張。標成過期之後版面會切成
    /// 「打開 Echo 更新今天的卡」（EchoReviewLiveActivity 的 isStale 分支），
    /// 使用者至少知道下一步要做什麼。
    ///
    /// 比對條件刻意用**按鈕自己帶的 deckId** 加上「畫面現在確實還停在這張卡」：
    ///   · 用按鈕的 deckId ⇒ 跨日殘留的舊 activity 也救得到，而且不會誤傷今天那張；
    ///   · 比 content.state.cardId ⇒ 如果那張 activity 其實早就換頁了（純粹是這顆
    ///     按鈕來自更舊的一次算繪），就不要多事把一張正常的卡打成過期。
    /// 這條路徑仍然只做一次 update()，沒有多吃更新預算。
    private func resyncStaleActivity() async {
        guard
            let activity = Activity<EchoReviewAttributes>.activities.first(where: {
                $0.attributes.deckId == deckId && $0.content.state.cardId == cardId
            })
        else { return }

        await activity.update(
            ActivityContent(state: activity.content.state, staleDate: Date())
        )
    }

    /// 下一次的 staleDate = **明天 08:00**（對齊 lib/notifications.ts 的
    /// DAILY_REMINDER_HOUR = 8；那邊改了這裡要跟著改）。
    ///
    /// 為什麼不是「N 小時後」：Live Activity 本來就會在約 8 小時後被系統結束、
    /// 約 12 小時後從鎖定畫面移除。staleDate 的語意是「**內容**過期」而不是
    /// 「活動結束」，我們要表達的是「跨過下一個提醒時點的題目就不該再作答」——
    /// 那時 app 已經該重新算一副新的牌了。
    private static func nextStaleDate(from now: Date = Date()) -> Date {
        let calendar = Calendar.current
        let fallback = now.addingTimeInterval(24 * 60 * 60)
        guard let tomorrow = calendar.date(byAdding: .day, value: 1, to: now) else { return fallback }
        return calendar.date(bySettingHour: 8, minute: 0, second: 0, of: tomorrow) ?? fallback
    }
}
