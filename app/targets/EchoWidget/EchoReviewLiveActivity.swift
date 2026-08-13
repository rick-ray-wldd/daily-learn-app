//
//  EchoReviewLiveActivity.swift
//  EchoWidget —— **只編進 extension target**
//
//  鎖定畫面上的複習卡版面。五種呈現形態全部實作（鎖定畫面 + 動態島的
//  compactLeading / compactTrailing / minimal / expanded）——Apple 要求全部給齊，
//  只做鎖定畫面會在動態島上開天窗。
//
//  ── 版面是「三選一 + 想不起來」，不是「四選一」 ───────────────────────────
//  最早的任務簡報畫的是三顆按鈕、其中一顆是「想不起來」，也就是實際只有兩個真選項，
//  猜對率 50%——那測不到任何東西，只會產出一個好看的假正確率。所以這裡刻意偏離
//  原圖：**3 個選項（1 正解 + 2 干擾）排第一列，「想不起來」獨立第二列**，共 4 顆
//  按鈕、猜對率 33%。任何地方都不要再出現「四選一」這個名字。
//
//  ── 三條不准違反的版面規則 ────────────────────────────────────────────
//  ① **整體高度 ≤ 160pt**（Apple：超過會被系統截斷）。配額寫在 EchoLayout 裡。
//     排不下就縮 padding 與字級，**不准砍掉「想不起來」**——逃生口一旦消失，
//     使用者就會開始亂猜，而亂猜的資料比沒有資料更糟。
//  ② **不准讀 colorScheme。** 已知上游 bug 加上鎖定畫面實質永遠是深色底，
//     colorScheme 不可信。所有顏色來自 EchoWidgetColors.swift 寫死的色票。
//  ③ **不准放圖片／asset catalog／Text(style: .timer)／任何自走動畫。**
//     圖片解析度過大會讓 Live Activity 直接啟動失敗；自走動畫會吃掉更新預算，
//     而更新預算是使用者「按了有沒有反應」的唯一來源。
//
//  這個檔是純 SwiftUI 世界：**不准 import React、不准試圖從 JS 匯入任何東西**，
//  包括 lib/theme.ts 的常數（那份色票是手抄進 EchoWidgetColors.swift 的）。
//

import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

// MARK: - 版面配額

/// 高度配額。加總 = 8 + 16 + 5 + 16 + 5 + 22 + 5 + 34 + 5 + 30 + 8 = **154pt**
/// （最壞情況：含回饋列）。上限 160pt，留 6pt 給系統的四捨五入與字級放大。
///
/// ⚠️ 這組數字**沒有在真機或模擬器上量過**（本機沒有 Xcode）。第一次跑 EAS build
/// 拿到可安裝的版本後，第一件要確認的事就是它有沒有被截斷。
private enum EchoLayout {
    static let hPadding: CGFloat = 14
    static let vPadding: CGFloat = 8
    static let rowGap: CGFloat = 5

    static let headerHeight: CGFloat = 16
    static let feedbackHeight: CGFloat = 16
    static let promptHeight: CGFloat = 22

    /// 選項按鈕高度。觸控目標不得低於 30pt，34 是留了餘裕的值。
    static let optionHeight: CGFloat = 34
    static let optionGap: CGFloat = 6

    /// 逃生口高度。壓到 30pt 是**下限**，不准再低。
    static let escapeHeight: CGFloat = 30
}

/// 「想不起來」在資料上就是一個 chosenId，不是另一種事件（見 EchoAnswerIntent）。
private let kUnknownOptionId = "unknown"

// MARK: - 按鈕的出身

/// 每顆按鈕都要帶著「我是在哪一副牌的第幾張上被畫出來的」。
///
/// 為什麼不能只帶 cardId：deckId 只有**日**的粒度（= deckDate），同一天內 app 重算
/// 佇列、把新的一副牌寫回同一個 DECK_KEY 之後 deckId 完全沒變，但 cards 換人了。
/// 這時只帶 cardId 的舊按鈕會把答案記到新牌的新位置上（或者靜靜消失），完整推理見
/// `EchoAnswerIntent.cardIndex`。包成一個 struct 是為了讓「三個欄位要一起傳」這件事
/// 在型別上成立——分開傳遲早會有人只更新其中兩個。
private struct EchoCardCoordinate {
    let deckId: String
    /// 1-based，與 header 的「3/5」是同一個數字。
    let cardIndex: Int
    let cardId: String

    init(attributes: EchoReviewAttributes, state: EchoReviewAttributes.ContentState) {
        self.deckId = attributes.deckId
        self.cardIndex = state.cardIndex
        self.cardId = state.cardId
    }

    func intent(optionId: String) -> EchoAnswerIntent {
        EchoAnswerIntent(deckId: deckId, cardIndex: cardIndex, cardId: cardId, optionId: optionId)
    }
}

// MARK: - Widget

struct EchoReviewLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: EchoReviewAttributes.self) { context in
            EchoLockScreenView(
                attributes: context.attributes,
                state: context.state,
                isStale: context.isStale
            )
            // 背景由我們指定，不交給系統推色——這是「不准讀 colorScheme」的另一半：
            // 只有底色也被寫死，寫死的前景色對比度才算得準。
            .activityBackgroundTint(EchoTheme.bg)
            .activitySystemActionForegroundColor(EchoTheme.text)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    EchoIslandBrand()
                }
                DynamicIslandExpandedRegion(.trailing) {
                    EchoCounterText(index: context.state.cardIndex, total: context.attributes.deckLength)
                }
                DynamicIslandExpandedRegion(.center) {
                    EchoIslandCenter(
                        attributes: context.attributes,
                        state: context.state,
                        isStale: context.isStale
                    )
                }
                DynamicIslandExpandedRegion(.bottom) {
                    // 展開態放**同一組按鈕**：使用者在哪一種形態下作答，走的都該是
                    // 同一個 intent、留下同一種資料。兩套按鈕＝兩套 bug。
                    if !context.isStale && !context.state.finished {
                        VStack(spacing: EchoLayout.rowGap) {
                            EchoOptionsRow(
                                coordinate: EchoCardCoordinate(attributes: context.attributes, state: context.state),
                                options: context.state.options
                            )
                            EchoEscapeButton(
                                coordinate: EchoCardCoordinate(attributes: context.attributes, state: context.state)
                            )
                        }
                    }
                }
            } compactLeading: {
                EchoCompactGlyph(finished: context.state.finished)
            } compactTrailing: {
                EchoCounterText(index: context.state.cardIndex, total: context.attributes.deckLength)
            } minimal: {
                Text("\(context.state.cardIndex)")
                    .font(EchoTheme.counterFont)
                    .foregroundStyle(EchoTheme.text)
            }
            // 藍 = 中性 chrome。這條框線不代表任何學習語意，所以只能是藍的。
            .keylineTint(EchoTheme.primary)
        }
    }
}

// MARK: - 鎖定畫面

private struct EchoLockScreenView: View {
    let attributes: EchoReviewAttributes
    let state: EchoReviewAttributes.ContentState
    let isStale: Bool

    private var coordinate: EchoCardCoordinate {
        EchoCardCoordinate(attributes: attributes, state: state)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: EchoLayout.rowGap) {
            EchoHeaderRow(
                sourceLabel: attributes.sourceLabel,
                index: state.cardIndex,
                total: attributes.deckLength
            )

            if let lastCorrect = state.lastAnswerCorrect {
                EchoFeedbackRow(correct: lastCorrect, correctLabelZh: state.lastCorrectLabelZh)
            }

            if isStale {
                // 過期的題目**不准讓人作答**：JS 端已經該重算一副新的牌了，
                // 這時收到的答案會記到昨天的卡上，是純粹的污染。
                EchoNoticeRow(text: "打開 Echo 更新今天的卡")
            } else if state.finished {
                EchoNoticeRow(text: "今天的 \(attributes.deckLength) 張複習完了 · 打開 Echo 看細節")
            } else {
                Text(state.prompt)
                    .font(EchoTheme.promptFont)
                    .foregroundStyle(EchoTheme.text)
                    .lineLimit(1)
                    // 題面長度由 JS 端擋在 48 字元；縮放只是最後一道保險，
                    // 真的縮到 0.6 就表示上游有 bug，讓它看得出來。
                    .minimumScaleFactor(0.6)
                    .frame(height: EchoLayout.promptHeight, alignment: .leading)

                EchoOptionsRow(coordinate: coordinate, options: state.options)
                EchoEscapeButton(coordinate: coordinate)
            }
        }
        .padding(.horizontal, EchoLayout.hPadding)
        .padding(.vertical, EchoLayout.vPadding)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - 列

private struct EchoHeaderRow: View {
    let sourceLabel: String
    let index: Int
    let total: Int

    var body: some View {
        HStack(spacing: EchoTheme.sp(2)) {
            Text(sourceLabel)
                .font(EchoTheme.captionFont)
                .foregroundStyle(EchoTheme.dim)
                .lineLimit(1)
            Spacer(minLength: EchoTheme.sp(1))
            EchoCounterText(index: index, total: total)
        }
        .frame(height: EchoLayout.headerHeight)
    }
}

/// "3/5"。等寬數字：3→4 換位時寬度不變，header 右緣不會抖。
private struct EchoCounterText: View {
    let index: Int
    let total: Int

    var body: some View {
        Text("\(index)/\(total)")
            .font(EchoTheme.counterFont)
            .foregroundStyle(EchoTheme.dim)
    }
}

/// 上一題的回饋。
///
/// 語意色在這裡各司其職，**不准互換**：
///   ✓ 用綠（accent）＝「學習者動手了，而且對了」；
///   ✗ 與正解用琥珀（highlightInk）＝「這是 app 的判定」。
/// **沒有紅色。** 答錯不是錯誤、是訊號——用紅色警示會讓使用者開始躲著答題。
private struct EchoFeedbackRow: View {
    let correct: Bool
    let correctLabelZh: String?

    private var message: String {
        if correct { return "上一題答對了" }
        guard let label = correctLabelZh, !label.isEmpty else { return "上一題答錯了" }
        return "上一題正解：\(label)"
    }

    var body: some View {
        HStack(spacing: EchoTheme.sp(1)) {
            Text(correct ? "✓" : "✗")
            Text(message)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
        .font(EchoTheme.captionFont)
        .foregroundStyle(correct ? EchoTheme.accent : EchoTheme.highlightInk)
        .frame(height: EchoLayout.feedbackHeight, alignment: .leading)
    }
}

/// 結算／過期時蓋掉題目的那一行。
private struct EchoNoticeRow: View {
    let text: String

    var body: some View {
        Text(text)
            .font(EchoTheme.captionFont)
            .foregroundStyle(EchoTheme.dim)
            .lineLimit(2)
            .minimumScaleFactor(0.8)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct EchoOptionsRow: View {
    let coordinate: EchoCardCoordinate
    let options: [EchoReviewAttributes.Option]

    var body: some View {
        HStack(spacing: EchoLayout.optionGap) {
            ForEach(options) { option in
                EchoOptionButton(coordinate: coordinate, option: option)
            }
        }
    }
}

// MARK: - 按鈕

/// 一顆選項。
///
/// 底是**中性玻璃**、字是主文字色，刻意**不上綠色**：綠色的語意是「學習者動手了」，
/// 而按下去之前還沒動手。三顆全綠會把回饋列那個 ✓ 的綠稀釋掉，訊號就不再顯眼了。
private struct EchoOptionButton: View {
    let coordinate: EchoCardCoordinate
    let option: EchoReviewAttributes.Option

    var body: some View {
        Button(intent: coordinate.intent(optionId: option.id)) {
            Text(option.labelZh)
                .font(EchoTheme.optionFont)
                .foregroundStyle(EchoTheme.text)
                .lineLimit(1)
                // 中文在窄欄很容易截字。標籤長度由 JS 端擋在 8 字，
                // 這裡再給一段縮放空間，寧可小一點也不要看到「制約場所…」。
                .minimumScaleFactor(0.7)
                .padding(.horizontal, EchoTheme.sp(1))
                .frame(maxWidth: .infinity, minHeight: EchoLayout.optionHeight)
                .background(EchoGlassSurface(radius: EchoTheme.radiusMd))
                // 按下去到 activity.update() 落地之間有數百毫秒到一秒。沒有這一行，
                // 那段空窗完全沒有回饋，使用者會以為壞了而連按第二顆——那正是
                // 「同一張卡兩筆互相矛盾的答案」的來源。標成 invalidatable 之後
                // 系統會自己把內容畫成等待中的樣子（**不是**我們畫的動畫，所以
                // 不違反「不准自走動畫」）。帳本那一側另有 first-write-wins 兜底。
                .invalidatableContent()
        }
        // .plain 才不會被系統套上自己的藍色高亮，把寫死的色票蓋掉。
        .buttonStyle(.plain)
    }
}

/// 逃生口。
///
/// 它是**空心**的（只有 hairline 外框、沒有玻璃填色），有兩個理由：
/// ① 視覺上要比三個選項退後一階——它不是第四個答案，是「我不知道」；
/// ② lib/theme.ts 明令 `faint` 不准出現在玻璃面板上（那個 5.1:1 是對不透明底色
///    實算的，玻璃底下是變數）。空心按鈕的底就是 activityBackgroundTint 的 bg，
///    對比度算得準，所以這裡才能合法用 faint。
private struct EchoEscapeButton: View {
    let coordinate: EchoCardCoordinate

    var body: some View {
        Button(intent: coordinate.intent(optionId: kUnknownOptionId)) {
            Text("想不起來")
                .font(EchoTheme.captionFont)
                .foregroundStyle(EchoTheme.faint)
                .frame(maxWidth: .infinity, minHeight: EchoLayout.escapeHeight)
                .overlay(
                    RoundedRectangle(cornerRadius: EchoTheme.radiusMd, style: .continuous)
                        .strokeBorder(EchoTheme.border, lineWidth: 1)
                )
                // 理由同 EchoOptionButton：逃生口是最常被連按的一顆
                // （「我不知道」按下去沒反應，任何人都會再按一次別的）。
                .invalidatableContent()
        }
        .buttonStyle(.plain)
    }
}

// MARK: - 材質

/// 玻璃面板：底填 + 上緣 1px 高光 + hairline 外框。
///
/// **上緣那條高光是玻璃感的唯一來源**，拿掉就只剩一張半透明灰卡片。這裡沒有背景
/// 模糊，也不需要——底色是純色 bg，模糊純色等於沒模糊（與 components/Glass.tsx
/// 的推理一字不差）。
private struct EchoGlassSurface: View {
    let radius: CGFloat

    private var shape: RoundedRectangle {
        RoundedRectangle(cornerRadius: radius, style: .continuous)
    }

    var body: some View {
        ZStack(alignment: .top) {
            shape.fill(EchoTheme.glassFill)
            Rectangle()
                .fill(EchoTheme.glassSheen)
                .frame(height: 1)
        }
        // 先裁切再描邊：高光是一條方角矩形，不裁的話會從圓角外露出兩個小角。
        .clipShape(shape)
        .overlay(shape.strokeBorder(EchoTheme.glassEdge, lineWidth: 1))
    }
}

// MARK: - 動態島

private struct EchoIslandBrand: View {
    var body: some View {
        HStack(spacing: EchoTheme.sp(1)) {
            Image(systemName: "waveform")
            Text("Echo")
                .lineLimit(1)
        }
        .font(EchoTheme.captionFont)
        .foregroundStyle(EchoTheme.dim)
    }
}

/// compactLeading 的小圖示。純 SF Symbol——動態島同樣不准放自訂圖片。
/// 答完之後換成打勾並轉綠：那一刻「學習者動手了」已經成立，綠色是它應得的。
private struct EchoCompactGlyph: View {
    let finished: Bool

    var body: some View {
        Image(systemName: finished ? "checkmark" : "waveform")
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(finished ? EchoTheme.accent : EchoTheme.text)
    }
}

private struct EchoIslandCenter: View {
    let attributes: EchoReviewAttributes
    let state: EchoReviewAttributes.ContentState
    let isStale: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: EchoTheme.sp(1)) {
            if let lastCorrect = state.lastAnswerCorrect {
                EchoFeedbackRow(correct: lastCorrect, correctLabelZh: state.lastCorrectLabelZh)
            }
            if isStale {
                EchoNoticeRow(text: "打開 Echo 更新今天的卡")
            } else if state.finished {
                EchoNoticeRow(text: "今天的 \(attributes.deckLength) 張複習完了")
            } else {
                Text(state.prompt)
                    .font(EchoTheme.promptFont)
                    .foregroundStyle(EchoTheme.text)
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
