//
//  EchoLiveActivityModule.swift
//  Echo —— **只編進主 app target，不進 extension**
//
//  藍圖缺的那一塊：把鎖屏複習卡**叫出來**的人。
//
//  ── 為什麼是 RN bridge module 而不是 Expo module ──────────────────────────
//
//  Expo module（含 `modules/` 底下的 local module）在 iOS 上一律被編成**獨立的
//  pod**，也就是獨立的 Swift module。而 `EchoAnswerIntent` 必須待在主 app target
//  ——它自己的檔頭寫得很清楚：extension 行程裡 `Activity<T>.activities` 永遠是空
//  陣列，換題就換不動。
//
//  兩者一旦不在同一個 Swift module，`Activity<EchoReviewAttributes>` 的泛型參數
//  就是兩個不同的型別（mangled name 不同）：起卡的人起了一張，換題的人找不到它。
//  **而且不會報錯**，只會靜靜地按了沒反應——這個 repo 最怕的那種失敗。
//
//  所以這支走傳統 bridge：Swift 實作 + 一支 `RCT_EXTERN_MODULE` 的 .m，兩個檔都由
//  `plugins/withEchoWidget.js` 加進**主 app target**，與 intent、attributes 同一個
//  module。新架構下 legacy module 走 interop layer，仍然可用。
//
//  ── 這支唯一的職責 ────────────────────────────────────────────────────────
//
//  跨橋、碰 ActivityKit、讀寫 App Group。**所有規則都不在這裡**——出哪幾題、
//  下一題是誰、什麼時候該結束，全部由 `lib/liveActivity.ts` 的純函式決定，
//  payload 原封不動送過來。這支只做三件事：解 payload、呼叫 ActivityKit、回報。
//
//  ⚠️ **從未編譯過。** 本機沒有 Xcode 與 iPhoneOS SDK，第一次驗證會發生在 EAS Build。
//

import ActivityKit
import Foundation
import React

@available(iOS 17.0, *)
@objc(EchoLiveActivity)
final class EchoLiveActivityModule: NSObject {

    /// bridge module 預設在自己的 serial queue 上跑；ActivityKit 的 request/update
    /// 都要求主執行緒，所以整支釘在 main。
    @objc static func requiresMainQueueSetup() -> Bool { true }
    @objc var methodQueue: DispatchQueue { .main }

    // MARK: - 能力查詢

    @objc(areActivitiesEnabled:rejecter:)
    func areActivitiesEnabled(
        _ resolve: @escaping RCTPromiseResolveBlock,
        rejecter reject: @escaping RCTPromiseRejectBlock
    ) {
        resolve(ActivityAuthorizationInfo().areActivitiesEnabled)
    }

    // MARK: - 起卡

    /// - Parameter payload: `lib/liveActivity.ts` 的 `LiveActivityStartPayload`。
    /// - Returns: activityId（JS 端存起來，之後 update/end 都要帶）。
    @objc(start:resolver:rejecter:)
    func start(
        _ payload: NSDictionary,
        resolver resolve: @escaping RCTPromiseResolveBlock,
        rejecter reject: @escaping RCTPromiseRejectBlock
    ) {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            reject("E_ACTIVITIES_DISABLED", "使用者在系統設定關閉了即時動態", nil)
            return
        }

        do {
            let attrs = try Self.decodeAttributes(payload["attributes"])
            let state = try Self.decodeState(payload["state"])
            let staleDate = Self.parseISO8601(payload["stale_date"])

            // 🔴 **先寫 deck 再起卡，順序不准反。** deck 快照是 intent 查正解與下一題
            // 的唯一來源；先起卡的話，卡已經在鎖定畫面上而 App Group 還是空的，
            // 使用者這時按下去會得到一個「找不到 deck」的無聲失敗。
            try Self.writeDeckSnapshot(payload["deck"])

            let activity = try Activity.request(
                attributes: attrs,
                content: .init(state: state, staleDate: staleDate),
                // nil = 不要 push token。本輪全部是本機排程，沒有後端推播。
                pushType: nil
            )
            resolve(activity.id)
        } catch let error as EchoLiveActivityError {
            reject(error.code, error.message, nil)
        } catch {
            // ActivityKit 自己丟的（最常見是 attributesTooLarge：ContentState 超過
            // 上限）。原樣回報，不要包裝成一句「啟動失敗」——那會讓人查不下去。
            reject("E_ACTIVITY_REQUEST_FAILED", "\(error)", error)
        }
    }

    // MARK: - 換題

    @objc(update:payload:resolver:rejecter:)
    func update(
        _ activityId: String,
        payload: NSDictionary,
        resolver resolve: @escaping RCTPromiseResolveBlock,
        rejecter reject: @escaping RCTPromiseRejectBlock
    ) {
        guard let activity = Self.activity(withId: activityId) else {
            // 找不到不是錯誤：使用者可能已經把卡滑掉了。JS 端據此收掉本地的
            // activityId，而不是重試一個永遠不會成功的 update。
            reject("E_ACTIVITY_NOT_FOUND", "找不到 activity: \(activityId)", nil)
            return
        }

        do {
            let state = try Self.decodeState(payload["state"])
            let staleDate = Self.parseISO8601(payload["stale_date"])
            Task { @MainActor in
                await activity.update(.init(state: state, staleDate: staleDate))
                resolve(nil)
            }
        } catch let error as EchoLiveActivityError {
            reject(error.code, error.message, nil)
        } catch {
            reject("E_ACTIVITY_UPDATE_FAILED", "\(error)", error)
        }
    }

    // MARK: - 收卡

    @objc(end:payload:resolver:rejecter:)
    func end(
        _ activityId: String,
        payload: NSDictionary,
        resolver resolve: @escaping RCTPromiseResolveBlock,
        rejecter reject: @escaping RCTPromiseRejectBlock
    ) {
        guard let activity = Self.activity(withId: activityId) else {
            // 已經不在了 = 已經達成目的。這裡 resolve 不 reject：呼叫端要的是
            // 「這張卡沒了」，而它確實沒了。
            resolve(nil)
            return
        }

        let dismissal = Self.parseDismissal(payload["dismissal"])
        let finalContent: ActivityContent<EchoReviewAttributes.ContentState>?
        if let raw = payload["state"], let state = try? Self.decodeState(raw) {
            finalContent = .init(state: state, staleDate: nil)
        } else {
            finalContent = nil
        }

        Task { @MainActor in
            await activity.end(finalContent, dismissalPolicy: dismissal)
            resolve(nil)
        }
    }

    // MARK: - 對帳

    @objc(listActivityIds:rejecter:)
    func listActivityIds(
        _ resolve: @escaping RCTPromiseResolveBlock,
        rejecter reject: @escaping RCTPromiseRejectBlock
    ) {
        resolve(Activity<EchoReviewAttributes>.activities.map(\.id))
    }

    /// 回**原始 JSON 物件**，驗證交給 JS 的 `parseAnswers`。
    /// 這裡刻意不驗：驗證規則寫在 `lib/liveActivity.ts`，在原生端再寫一份就會分岔。
    @objc(listAnswers:rejecter:)
    func listAnswers(
        _ resolve: @escaping RCTPromiseResolveBlock,
        rejecter reject: @escaping RCTPromiseRejectBlock
    ) {
        do {
            let dir = try EchoAppGroup.answersDirectory()
            let files = try FileManager.default.contentsOfDirectory(
                at: dir,
                includingPropertiesForKeys: nil
            ).filter { $0.pathExtension == "json" }

            var out: [Any] = []
            for url in files {
                guard
                    let data = try? Data(contentsOf: url),
                    let obj = try? JSONSerialization.jsonObject(with: data)
                else {
                    // 壞掉的單一檔案不該讓整批收割失敗——那會讓一個壞檔永久卡住
                    // 所有後續答案。跳過並繼續。
                    NSLog("[EchoLiveActivity] 跳過讀不了的答案檔: %@", url.lastPathComponent)
                    continue
                }
                out.append(obj)
            }
            resolve(out)
        } catch {
            resolve([])  // 目錄還沒建立 = 還沒有人答過題，不是錯誤
        }
    }

    /// - Returns: 實際刪掉的檔案數。
    @objc(deleteAnswers:resolver:rejecter:)
    func deleteAnswers(
        _ answerIds: NSArray,
        resolver resolve: @escaping RCTPromiseResolveBlock,
        rejecter reject: @escaping RCTPromiseRejectBlock
    ) {
        guard let dir = try? EchoAppGroup.answersDirectory() else {
            resolve(0)
            return
        }
        var deleted = 0
        for case let id as String in answerIds {
            // answer_id 就是檔名主體（見 EchoAppGroup 檔頭）。
            let url = dir.appendingPathComponent("\(id).json")
            if (try? FileManager.default.removeItem(at: url)) != nil { deleted += 1 }
        }
        resolve(deleted)
    }

    @objc(readCursor:rejecter:)
    func readCursor(
        _ resolve: @escaping RCTPromiseResolveBlock,
        rejecter reject: @escaping RCTPromiseRejectBlock
    ) {
        guard
            let defaults = EchoAppGroup.defaults,
            defaults.object(forKey: EchoAppGroup.cursorKey) != nil
        else {
            resolve(nil)
            return
        }
        resolve(defaults.integer(forKey: EchoAppGroup.cursorKey))
    }

    // MARK: - 解碼

    /// NSDictionary → Codable，走一次 JSONSerialization。
    /// 手刻逐欄位取值會在 `lib/liveActivity.ts` 改契約時靜靜地少解一欄；
    /// 走 Codable 的話少一欄就是 decode 失敗，會被看見。
    private static func decode<T: Decodable>(_ raw: Any?, as type: T.Type, what: String) throws -> T {
        guard let raw else {
            throw EchoLiveActivityError(code: "E_BAD_PAYLOAD", message: "payload 缺少 \(what)")
        }
        let data = try JSONSerialization.data(withJSONObject: raw)
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw EchoLiveActivityError(
                code: "E_BAD_PAYLOAD",
                message: "\(what) 解碼失敗：\(error)"
            )
        }
    }

    private static func decodeAttributes(_ raw: Any?) throws -> EchoReviewAttributes {
        try decode(raw, as: EchoReviewAttributes.self, what: "attributes")
    }

    private static func decodeState(_ raw: Any?) throws -> EchoReviewAttributes.ContentState {
        try decode(raw, as: EchoReviewAttributes.ContentState.self, what: "state")
    }

    /// deck 直接以 JSON `Data` 寫進 App Group 的 `deckKey`。
    /// `EchoAppGroup.loadDeck()` 同時吃 `Data` 與 `String` 兩種存法，這裡用 Data。
    private static func writeDeckSnapshot(_ raw: Any?) throws {
        guard let raw else {
            throw EchoLiveActivityError(code: "E_BAD_PAYLOAD", message: "payload 缺少 deck")
        }
        guard let defaults = EchoAppGroup.defaults else {
            throw EchoLiveActivityError(
                code: "E_APP_GROUP_UNAVAILABLE",
                message: "讀不到 App Group \(EchoAppGroup.identifier)——entitlement 沒設好？"
            )
        }
        // 先驗形狀再寫：寫進去一份 intent 解不開的 JSON，等於讓鎖屏上的按鈕
        // 全部失效，而且要等到使用者按下去才會發現。
        _ = try decode(raw, as: EchoDeckSnapshot.self, what: "deck")
        let data = try JSONSerialization.data(withJSONObject: raw)
        defaults.set(data, forKey: EchoAppGroup.deckKey)
    }

    private static func activity(withId id: String) -> Activity<EchoReviewAttributes>? {
        Activity<EchoReviewAttributes>.activities.first { $0.id == id }
    }

    private static func parseISO8601(_ raw: Any?) -> Date? {
        guard let text = raw as? String else { return nil }
        let withFractional = ISO8601DateFormatter()
        withFractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = withFractional.date(from: text) { return d }
        return ISO8601DateFormatter().date(from: text)
    }

    /// `'default' | 'immediate' | ISO 8601`（見 `LiveActivityEndPayload.dismissal`）。
    private static func parseDismissal(_ raw: Any?) -> ActivityUIDismissalPolicy {
        guard let text = raw as? String else { return .default }
        switch text {
        case "immediate": return .immediate
        case "default": return .default
        default:
            guard let date = parseISO8601(text) else { return .default }
            return .after(date)
        }
    }
}

struct EchoLiveActivityError: Error {
    let code: String
    let message: String
}
