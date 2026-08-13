//
//  EchoAppGroup.swift
//  EchoWidget —— **同時編進主 app target 與 extension target**
//
//  App Group 共享容器的**唯一入口**。識別碼、目錄名、UserDefaults key 只准出現在
//  這個檔裡一次；散出去第二份，兩份就會在某次改名時分岔，而分岔的症狀是「答案憑空
//  消失」——不報錯、不 crash，只是少資料。
//
//  三條資料通道，**每條恰好一個 writer**（這條規則不准破，它是整份設計的地基）：
//
//    deckKey    ← 只有**前景 app** 寫。今天整副牌（含正解），intent 讀它查答案與下一題。
//    cursorKey  ← 只有 **intent** 寫。已答到第幾張，app 收割時拿來對帳（不是真相）。
//    答案檔案    ← 只有 **intent** 寫。**唯一可信的答案帳本**，app 收割後刪檔。
//
//  為什麼答案是「一題一檔 + 原子寫入」而不是一個 UserDefaults 陣列：
//  跨行程的 read-modify-write **沒有原子性保證**，兩次點擊交錯時後寫的會蓋掉先寫的，
//  答案靜默消失。這種 bug 在 demo 上測不出來（每天才 ≤5 筆、手速也慢），卻會直接
//  污染本專案唯一的產品論點（「每一次重聽/作答都是訊號」）。一題一檔天然 append-only、
//  收割中途被中斷不會漏帳也不會重複。
//
//  ⚠️ 檔名（= answer_id）是 **(deckId, cardId) 算出來的穩定鍵，不是 UUID**。
//  用 UUID 的話「同一張卡按兩次」會產出兩筆 answer_id 不同、chosen_id 互相矛盾的
//  紀錄，而收割端只認 answer_id 去重、兩筆都會放行——分母灌水、同一張卡同時被算成
//  「答對」與「想不起來」。而使用者按兩次是**必然會發生**的：按下去到 activity.update()
//  落地之間有近一秒沒有明確回饋，任何人都會再按一次。穩定鍵把「一張卡最多一筆帳」
//  變成檔案系統層級的不變式（同名檔，寫幾次都只有一份），去重也才真的是冪等的。
//
//  ⚠️ 這個檔會編進主 app（deployment target 16.4），所以型別整體標 @available(iOS 17.0, *)：
//  它服務的 LiveActivityIntent 實質下限就是 17.0。
//

import Foundation

@available(iOS 17.0, *)
enum EchoAppGroup {

    /// 與 app.json 的 ios.bundleIdentifier（com.rickray.echo）綁定。
    /// 改這裡就要同步改 plugins/withEchoWidget.js 的 DEFAULT_APP_GROUP
    /// 與 lib/liveActivity.ts 的 APP_GROUP_ID —— 三處必須完全一致。
    static let identifier = "group.com.rickray.echo"

    /// 答案落地的子目錄（App Group 容器根目錄下）。
    static let answersDirectoryName = "live-activity-answers"

    /// app → intent 單向：今天這副牌的完整內容（含正解）。
    static let deckKey = "echo.liveActivity.deck.v1"

    /// intent → app 單向：已答到第幾張（0-based）。
    static let cursorKey = "echo.liveActivity.cursor.v1"

    /// 答案檔的 schema 版本。JS 端讀到 ≠ 1 就丟棄並 warn（不准猜）。
    static let answerSchemaVersion = 1

    /// 答案的來源標記。目前只有鎖定畫面這一種進入點。
    static let sourceLockScreen = "lockscreen"

    static var defaults: UserDefaults? { UserDefaults(suiteName: identifier) }

    // MARK: - 檔案

    /// 答案目錄（不存在就建）。
    static func answersDirectory() throws -> URL {
        guard let container = FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: identifier)
        else {
            // 容器拿不到 = entitlement 沒設對或 App Group 沒開通。這是設定錯誤，
            // 不是執行期的偶發狀況，所以往上拋而不是靜靜回傳一個假路徑。
            throw EchoAppGroupError.containerUnavailable
        }
        let dir = container.appendingPathComponent(answersDirectoryName, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    /// answer_id：**同一副牌的同一張卡永遠算出同一個字串**（見檔頭的 ⚠️）。
    ///
    /// 它同時是檔名，所以只准留下檔名安全的字元。契約上 deckId 是 YYYY-MM-DD、
    /// cardId 是 UUID，兩者本來就全是安全字元；這裡的清洗是為了「快照哪天長出奇怪
    /// 的 id」時不要變成路徑穿越或寫不進去的檔名，而不是預期會用到的路徑。
    /// 截長度是因為檔名有 255 byte 上限，中文一個字就吃 3 byte。
    static func answerId(deckId: String, cardId: String) -> String {
        let raw = "\(deckId)__\(cardId)"
        let safe = String(
            raw.unicodeScalars.map { answerIdAllowedScalars.contains($0) ? Character($0) : "-" }
        )
        // 全部被清掉是不可能的（至少留得下那兩個底線），保底仍給一個非空字串：
        // JS 端的 parseAnswer 會把空的 answer_id 整筆丟掉。
        return safe.isEmpty ? UUID().uuidString : String(safe.prefix(180))
    }

    private static let answerIdAllowedScalars = CharacterSet(
        charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.-_"
    )

    /// 原子寫入一筆答案。檔名 = "<answer_id>.json"。
    ///
    /// **first-write-wins**：檔案已經在了就直接返回，不覆寫。同一張卡的第二次點擊
    /// 幾乎都是「以為沒反應」的重按，第一次按下的那個選擇才是真實訊號；讓後按的
    /// 蓋掉先按的，等於把使用者的猶豫記成他的答案。
    /// 就算兩次點擊真的撞在一起、兩邊都通過了這個檢查，因為檔名相同，最後仍然
    /// 只會有**一筆**紀錄——這才是這個設計要保證的不變式（誰贏是次要的）。
    static func appendAnswer(_ record: EchoAnswerRecord) throws {
        let url = try answersDirectory()
            .appendingPathComponent("\(record.answerId).json", isDirectory: false)
        if FileManager.default.fileExists(atPath: url.path) { return }
        let data = try JSONEncoder().encode(record)

        // .atomic：先寫暫存檔再 rename，保證 JS 端永遠不會讀到半寫的 JSON。
        // .completeFileProtectionUntilFirstUserAuthentication：按鈕本來就要求裝置解鎖
        //   過，這個等級足夠；而且它保證 app 之後在**背景**也讀得到。
        //   ⚠️ 不要用 .complete —— 裝置鎖著時連 app 自己都讀不到，收割會整批失敗。
        try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    // MARK: - UserDefaults

    /// 讀今天這副牌。解不出來回 nil，呼叫端必須能承受（例如：使用者換日了、
    /// app 還沒來得及寫新的一副，這時舊按鈕按下去就該什麼都不做）。
    static func loadDeck() -> EchoDeckSnapshot? {
        guard let defaults else { return nil }

        // 同時接受 Data 與 String：原生模組（下一輪）用哪一種寫進來還沒定案，
        // 兩種都吃就不會因為那個選擇而回頭改這裡。
        let raw: Data?
        if let data = defaults.data(forKey: deckKey) {
            raw = data
        } else if let text = defaults.string(forKey: deckKey) {
            raw = text.data(using: .utf8)
        } else {
            raw = nil
        }
        guard let raw else { return nil }
        return try? JSONDecoder().decode(EchoDeckSnapshot.self, from: raw)
    }

    /// 寫游標。**只有 intent 可以呼叫這個**（單一 writer 規則）。
    /// 前景 app 只准讀，不准寫——兩個 writer 就等於沒有 writer。
    static func writeCursor(_ index: Int) {
        defaults?.set(index, forKey: cursorKey)
    }

    // MARK: - 時間

    /// ISO 8601 **含時區偏移**（例：2026-08-13T07:41:22+08:00）。
    /// 刻意用當地時區而不是 UTC：這份資料的用途是回答「使用者在他的哪個生活時段
    /// 願意作答」，換算成 UTC 之後那個問題就要重新猜使用者當時在哪個時區。
    static func iso8601(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        formatter.timeZone = TimeZone.current
        return formatter.string(from: date)
    }
}

/// App Group 設定不正確時才會拋出。執行期的正常狀況一律用 optional 表達。
enum EchoAppGroupError: Error {
    case containerUnavailable
}

/// 寫進 App Group 的一筆答案。
///
/// **這個形狀與 lib/liveActivity.ts 的 LiveActivityAnswer 一對一對應，是跨語言契約，
/// 改一邊就要改另一邊。** key 用顯式 CodingKeys 而不是 encoder 的 convertToSnakeCase：
/// 契約要能在原始碼上被一眼讀到，不該藏在某個 encoder 的設定裡。
@available(iOS 17.0, *)
struct EchoAnswerRecord: Codable {

    /// 固定 1。JS 端讀到缺少或 ≠ 1 就丟棄並 warn。
    let schemaVersion: Int

    /// **(deck_id, card_id) 的穩定鍵**（`EchoAppGroup.answerId(deckId:cardId:)`），
    /// 不是 UUID。收割端用它去重，所以「收割到一半被殺掉」重跑不會重複計分，
    /// 而且**同一張卡被連按兩次也只會有一筆**（理由見檔頭的 ⚠️）。
    ///
    /// ⚠️ 跨語言契約：`lib/liveActivity.ts` 的 `LiveActivityAnswer.answer_id` 只要求
    /// 「非空字串」，所以這個改動不需要動 JS 的驗證邏輯；但那邊的註解仍寫著「UUID」，
    /// 該由 `lib/` 的擁有者順手改成「穩定鍵」。原生模組的 `deleteAnswers(answerIds)`
    /// 依然是「刪 `<answer_id>.json`」——answer_id 就是檔名主體，這層對應沒有變。
    let answerId: String

    let deckId: String
    let cardId: String

    /// "a" | "b" | "c" | "unknown"（unknown = 想不起來）。
    let chosenId: String

    /// chosenId == "unknown" 時**恆為 false**（想不起來不是答對）。
    let correct: Bool

    /// ISO 8601 含時區。
    let answeredAt: String

    /// "lockscreen" | "dynamic-island"。
    let source: String

    enum CodingKeys: String, CodingKey {
        case schemaVersion = "schema_version"
        case answerId = "answer_id"
        case deckId = "deck_id"
        case cardId = "card_id"
        case chosenId = "chosen_id"
        case correct
        case answeredAt = "answered_at"
        case source
    }
}

/// 今天整副牌的快照。**只有前景 app 會寫**，intent 只讀。
/// 這是唯一一個放正解（correctId）的地方——它待在 App Group 裡，不會被序列化進
/// ContentState、不會經過 push、不會離開裝置。
@available(iOS 17.0, *)
struct EchoDeckSnapshot: Codable {

    let deckId: String

    /// YYYY-MM-DD（當地時區）。與 deckId 相同值，分開放是為了讓「跨日了沒」
    /// 這件事在資料上讀得出來，而不是靠解析 id 字串。
    let deckDate: String

    let sourceLabel: String
    let cards: [Card]

    struct Card: Codable {
        let cardId: String
        let prompt: String
        let options: [Opt]

        /// 正解的 option id。**只存在這裡。**
        let correctId: String

        /// 正解的中文字面。答錯時要顯示在下一題的回饋列上。
        /// 找不到（deck 資料不一致）回 nil，版面就不顯示正解那一行——
        /// 顯示空字串會變成「正解：」後面一片空白，看起來像 app 壞了。
        var correctLabel: String? {
            options.first(where: { $0.id == correctId })?.labelZh
        }

        enum CodingKeys: String, CodingKey {
            case cardId = "card_id"
            case prompt
            case options
            case correctId = "correct_id"
        }
    }

    struct Opt: Codable {
        let id: String
        let labelZh: String

        enum CodingKeys: String, CodingKey {
            case id
            case labelZh = "label_zh"
        }
    }

    enum CodingKeys: String, CodingKey {
        case deckId = "deck_id"
        case deckDate = "deck_date"
        case sourceLabel = "source_label"
        case cards
    }
}
