# Privacy Policy — Echo

**Effective date: 2026-08-18** · Applies to: Echo for iOS (bundle id `com.rickray.echo`), distributed through Apple TestFlight.

**Echo has no signup. We do not collect your name, your email address, or your phone number, because the app never asks for them.** Your account is an anonymous ID created on your device the first time you open the app. Everything below is a description of what the code actually does; the section [How to check these claims](#12-how-to-check-these-claims) tells you which file to read for each one.

> 中文摘要：Echo 沒有註冊流程，**不收集姓名、email、電話**。第一次開啟 app 時會建立一個匿名帳號（一組隨機 UUID），所有資料都綁在那組 ID 底下。這份政策描述的是程式碼實際的行為，每一條都可以在公開 repo 裡查到對應的檔案。

Contact for anything in this document: **allcare.rickray@gmail.com**

---

## 1. This is a beta

Echo is an unreleased app in **external TestFlight testing**. It has one long-term user (the developer) and a small invited tester group. Three consequences you should read before installing:

1. **Data can be deleted without warning.** The database schema changes as the product changes. Migrations, resets, and cleanups during development may wipe your captures, practice history, or account. Do not put anything in Echo you would be upset to lose.
2. **Behaviour changes between builds**, including over-the-air updates that arrive without a new TestFlight install (see §5, Expo).
3. **This policy will change** as the app changes. The version you are reading is dated at the top.

> 中文：這是 beta 測試版。開發過程中的 migration / 重置可能**清空你的資料**，不會事先通知。app 的行為也會隨版本改變（含不經 TestFlight 的 OTA 更新）。這份政策會跟著產品一起改版。

---

## 2. Your account

On first launch the app calls Supabase's `signInAnonymously()`. That creates a user row containing a random UUID and a timestamp — no email, no password, no profile. The session is stored in the app's local storage on your device.

This account is **unrecoverable by design**. If you delete Echo, or switch phones, the session is gone and there is no way for you or for us to sign back into it. That is a deliberate trade for a beta with no signup friction, and it has a consequence you should know about: rows already synced to the server become orphaned — still stored, but no longer linked to any device you hold. See §8 for how deletion works given that.

> 中文：帳號＝一組隨機 UUID，**沒有 email、沒有密碼**。刪除 app 或換手機，這個帳號就永久取回不了；已經上傳的資料會留在伺服器上，變成無主的列。§8 說明這種情況下怎麼刪除資料。

---

## 3. What we collect, why, and how long we keep it

Everything here is scoped to your anonymous account by row-level security — one user cannot read another user's rows.

| Data | What it is, exactly | Why | Where it goes |
| --- | --- | --- | --- |
| **Replay events** | One row per backward seek: episode ID, position you jumped from, position you jumped to, playback rate, and whether the press came from the screen, a headphone remote, the lock screen, or a transcript selection. Plus a timestamp. | This is the product. Echo's entire thesis is that a rewind marks a moment you did not understand. | Supabase `replay_events` |
| **Captures** | The time window a rewind points at (start/end seconds), a signal-strength label, a status, the transcript sentence inside that window, and the AI diagnosis of it. | Turns a rewind into a practice card. | Supabase `captures` |
| **Practice cards** | Spaced-repetition state per capture: difficulty type, ease, interval, due date, repetition count. | Schedules the next review. | Supabase `difficulty_items` |
| **Practice sessions** | Date, how many items were in the session, how many you completed, a completion rate, and a timestamp. | The one metric we judge the product by. | Supabase `practice_sessions` |
| **Episode metadata** | Podcast title, episode title, audio URL, duration, RSS GUID, feed URL, transcript URL, publish date — of episodes you open. | Foreign key target for the rows above; lets practice replay the right audio. | Supabase `episodes` — **shared catalogue, not scoped to you.** It carries no personal data, but note that it also carries no owner, so it does not tell us who listened to what. The link between you and an episode exists only through your own replay events and captures. |
| **API usage counters** | Per user, per day, per function: a count. | Daily caps so one install cannot run up the OpenAI/Anthropic bill. | Supabase `api_usage` — readable by no client, only by the server function that increments it. |
| **Network metadata** | IP address, and the standard headers any HTTP request carries. | Unavoidable consequence of making a network request. | Seen by Supabase, Expo, Apple, and the podcast host you are streaming from. We do not store it ourselves. |

**Retention.** There is currently **no automatic deletion** in the system — that is a statement of fact, not a promise of indefinite storage. Rows persist until (a) you ask us to delete them, (b) a development reset removes them, or (c) the beta ends. **We will delete the entire beta dataset within 30 days of the TestFlight beta closing.**

> 中文：以上七類資料都綁在你的匿名帳號下，RLS 保證別的使用者讀不到。目前**沒有自動刪除機制**；資料會留到你要求刪除、開發期重置清掉、或 beta 結束為止（beta 結束後 30 天內全部刪除）。

### Data that stays on your device and is never uploaded

- **Shadowing recordings.** When you press record in a practice session, the audio is written to the app's cache directory on your phone. There is no upload call for it anywhere in the app. It is not sent to us, not sent to any AI provider, and not backed up by us. Deleting Echo deletes it.
- **Transcript cache.** Downloaded and generated transcripts are cached as files on the device.
- **Your transcript selections.** The words you frame in a transcript, and whether you called it a vocabulary, grammar, or word-boundary problem, are stored locally. The current build's sync payload does not include them.
- **Notifications.** Daily reminders and quiz notifications are scheduled locally by iOS. Echo does **not** register for push notifications and holds no push token, so notification content never leaves your phone and we cannot send you anything.
- **Subscriptions and feed lists.**

> 中文：**跟讀錄音不會上傳。** 它寫在手機的 cache 資料夾裡，程式碼裡沒有任何一行把它送出去。逐字稿快取、框選內容、通知排程、訂閱清單同樣只在裝置上。Echo 沒有註冊推播、也沒有 push token。

---

## 4. Microphone

Echo asks for microphone permission for exactly one feature: recording yourself repeating a sentence, so you can play it back against the reference audio. Recording starts only when you press the record button and stops when you press stop.

Echo does **not** record in the background, does not record while you listen to podcasts, and does not have a voice-cloning feature in this build. (The database has an unused `voice_profiles` table left over from planning; nothing writes to it.) If you deny microphone permission, everything except shadowing still works.

---

## 5. Third parties, and what each one actually receives

| Party | What it receives | What it does not receive |
| --- | --- | --- |
| **Supabase** ([privacy policy](https://supabase.com/privacy)) — database, auth, storage, server functions | Everything in the §3 table, plus your IP address. | Your name or email — we never had them. |
| **OpenAI** ([API terms](https://openai.com/policies/), [privacy policy](https://openai.com/policies/privacy-policy/)) — Whisper speech-to-text | A slice of the **podcast's own audio file**, plus a filename derived from the episode ID. The request is made by our server, not by your phone. | Your account ID, your voice, your microphone recordings, your IP address. |
| **Anthropic** ([API terms](https://www.anthropic.com/legal/commercial-terms), [privacy policy](https://www.anthropic.com/legal/privacy)) — Claude difficulty diagnosis and transcript annotation | The transcript **text** of the sentence you rewound, plus surrounding sentences for context. | Your account ID, any audio, your IP address, anything identifying you. |
| **Expo / EAS** ([privacy policy](https://expo.dev/privacy)) — over-the-air JavaScript updates | An update check from your device on launch: platform, app and runtime version, update ID, IP address. | Any of your learning data. |
| **Apple / TestFlight** ([privacy policy](https://www.apple.com/legal/privacy/)) | The email address your TestFlight invite was sent to, any feedback or screenshots you submit through TestFlight, and crash reports Apple shares with developers. This is Apple's system, governed by Apple's policy, not ours. | — |
| **Podcast publishers and their CDNs; Apple's iTunes Search API** | When you search for a show, your query goes to Apple's public podcast search endpoint. When you play an episode or refresh a feed, your device requests those files directly from the publisher's server, which sees your IP address. | We do not proxy these requests, and we receive nothing back from those hosts about you. |

**An important clarification about the Whisper path.** Echo does not upload audio from your phone for transcription. When a transcript is needed, our server function requests a byte range of the podcast episode from the publisher's own URL and forwards those bytes to Whisper. The audio sent to OpenAI is the podcast — publicly published audio — not anything recorded by you or on your device.

> 中文：**送到 Whisper 的是 podcast 本身的音檔片段，不是你的錄音、也不是從你手機上傳的東西。** 伺服器直接向 podcast 來源要那一段位元組再轉給 OpenAI。送到 Claude 的只有逐字稿**文字**，不含任何識別你的資訊。

**No advertising SDK. No third-party analytics. No crash-reporting SDK. No cross-app tracking, and no App Tracking Transparency prompt because there is nothing to track. We do not sell data and we do not share it with anyone not listed in this table.** The app's entire dependency list is 14 packages; you can read it in `app/package.json`.

---

## 6. Where the data is stored

Data lives in a Supabase-managed Postgres project (`lkywohepzbubiijxktai`) running on Supabase's cloud infrastructure, and in Supabase Edge Functions that call OpenAI and Anthropic. OpenAI and Anthropic are US-based companies.

We are not stating a specific storage region in this document, because we have not verified it in a way we can point you to — and the rule for this project is that unverified claims do not get written down as facts. Assume your data may be stored and processed **outside your country of residence**. If you want the exact region before you install, email us and we will read it off the dashboard and tell you.

---

## 7. How the data is protected

Described as what we do, not as a certification we hold:

- Every personal table has row-level security requiring `auth.uid() = user_id`, so a signed-in user can read and write only their own rows.
- The OpenAI and Anthropic API keys live only in server-side Edge Function secrets. They are not in the app bundle. Anyone who unpacks the app finds no provider key.
- Those functions reject callers with no user session, and enforce per-user daily call limits.
- All network traffic is over HTTPS.
- The developer can read the database. It is a one-person beta; there is no larger organisation and no formal access-control process, and pretending otherwise would be false.

We make no claim of compliance with GDPR, CCPA, or any other specific regime, and no claim of any security certification. We have not been audited.

> 中文：這裡寫的是「我們的作法」，不是合規宣稱。我們**不宣稱**符合 GDPR / CCPA 或任何認證，也沒有經過稽核。

---

## 8. Deleting your data, and the honest limits on it

**On-device data:** delete the app. Recordings, transcript caches, selections, subscriptions, and the session all go with it.

**Server-side data:** email **allcare.rickray@gmail.com** and ask. Here is the real limitation, stated plainly rather than papered over: **this build has no in-app delete button and no screen that shows your anonymous account ID.** So to find your rows we have to identify them from what you can tell us — roughly when you started using Echo, and which episodes you listened to. In a beta this small that is usually enough. If we cannot match your rows with confidence, we will tell you that instead of deleting someone else's data. Either way you will get a reply, and everything is deleted when the beta dataset is deleted (§3).

There is no data to export that you have not already seen in the app, but if you want a copy of your rows, ask by email and we will send them.

> 中文：裝置端資料 → 刪除 app 即可。伺服器端 → 寄信給我們。**限制照實說：這個版本沒有 app 內刪除鍵，也沒有畫面顯示你的匿名帳號 ID**，所以我們得靠你提供的線索（大約什麼時候開始用、聽了哪幾集）去比對。比對不到我們會直接告訴你，而不是亂刪別人的資料。

---

## 9. Children

Echo is not designed for, marketed to, or directed at children. It is intended for adult English learners, and the TestFlight tester group is invited by the developer personally. We do not knowingly collect data from anyone under 13. Since we collect no name, email, age, or any other identifier, we have no means of determining a user's age — which is exactly why access is by personal invitation.

If you are a parent or guardian and believe a child has used Echo, email **allcare.rickray@gmail.com** and we will locate and delete the associated data.

---

## 10. Legal basis and your choices

You can stop all collection at any time by deleting the app; there is no account left running on our side that keeps doing anything. Notifications can be turned off in iOS Settings, and microphone access can be revoked in iOS Settings without breaking the rest of the app.

Because the app is invitation-only and collects no contact details, we do not send marketing of any kind, and we have no mailing list.

---

## 11. Changes to this policy

Product changes come first, then this document is updated to match — never the reverse. Every version is dated at the top and every change is visible in this file's git history in the public repository. Material changes (a new third party, a new category of collected data, uploading anything currently kept on-device) will be announced to testers through TestFlight release notes before the build that makes the change ships.

---

## 12. How to check these claims

This app's source is public at **github.com/rick-ray-wldd/daily-learn-app**. If you want to verify a claim rather than trust it:

| Claim | Read |
| --- | --- |
| Accounts are anonymous, no signup | `app/lib/supabase.ts` |
| Each user can only read their own rows | `app/supabase/migrations/002_auth_rls.sql` |
| What a replay event and a capture contain | `app/supabase/migrations/001_init.sql`, `006_explicit_selection_signal.sql` |
| Exactly what is synced to the server | `syncCapture` / `syncEpisode` / `syncPracticeRecord` in `app/lib/store.ts` |
| Whisper receives podcast audio fetched server-side, not your recordings | `app/supabase/functions/transcribe/index.ts` |
| Claude receives only transcript text | `app/supabase/functions/diagnose/index.ts`, `app/supabase/functions/annotate/index.ts` |
| Recordings are never uploaded | `startRecording` / `stopRecording` in `app/screens/Practice.tsx` — and the absence of any storage upload call in the app |
| Notifications are local; no push token | `app/lib/notifications.ts` |
| No analytics or ad SDKs | `app/package.json` (14 dependencies, all listed) |

---

## Contact

**allcare.rickray@gmail.com** — for deletion requests, data questions, the storage region, or anything in this document. One person reads that inbox and replies.
