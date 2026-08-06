#!/usr/bin/env python3
"""YouTube 自動字幕 VTT → 句子級、帶時間軸的乾淨 VTT。

為什麼需要這支：`/podcast-dl` skill 附的 clean_vtt.py 產出的是**閱讀用純文字**，
刻意丟掉時間軸。app 要的是「這一秒對應哪一句」，所以時間軸不能丟。

而 YouTube 的自動字幕不能直接餵給 app 的解析器（lib/transcriptFormats.ts）：
它是 rolling caption，每個 cue 會把上一行整句重印一次，直接 parse 會得到滿screen
重複、而且斷句斷在畫面寬度而不是句子邊界的東西。

    00:00:01.964 --> 00:00:04.350
    Welcome to Huberman Lab Essentials,          ← 上一 cue 的重印，無標記
    [music]<00:00:02.320><c> where</c>...        ← 只有這行是新的，且帶逐字時間

好消息是那些 inline 標記是**逐字時間**——比 Whisper 給的句子級時間還細。所以這支
的作法是：抽出 (時間, 單字) 序列 → 依標點重新斷句 → 輸出一句一個 cue 的 VTT。
產出的形狀跟 transcribe function 回傳的 segments 一致，app 兩條路徑共用同一個渲染。

用法：
    python3 vtt_to_sentences.py <input.vtt> <output.vtt> [--max-sec 14] [--max-chars 220]
"""
import argparse
import html
import re
import sys

# 逐字標記：<00:01:23.456>，後面通常跟著 <c>word</c>
TAG = re.compile(r"<(\d{2}):(\d{2}):(\d{2}\.\d{3})>")
CUE_TIME = re.compile(
    r"^(\d{2}:\d{2}:\d{2}\.\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}\.\d{3})"
)

# 句尾偵測要避開的縮寫——"Dr." 後面不是新句子。清單只放這份逐字稿真的會出現的。
ABBREV = {
    "dr.", "mr.", "mrs.", "ms.", "prof.", "st.", "vs.", "etc.",
    "e.g.", "i.e.", "approx.", "inc.", "ph.d.", "u.s.", "a.m.", "p.m.",
}


def to_seconds(hh: str, mm: str, ss: str) -> float:
    return int(hh) * 3600 + int(mm) * 60 + float(ss)


def parse_cue_start(line: str):
    m = CUE_TIME.match(line.strip())
    if not m:
        return None
    h, mi, s = m.group(1).split(":")
    return to_seconds(h, mi, s)


def extract_words(raw: str):
    """→ [(start_sec, word)]，依時間遞增、已去重。"""
    words: list[tuple[float, str]] = []
    blocks = raw.replace("\r\n", "\n").replace("\r", "\n").split("\n\n")

    for block in blocks:
        lines = [l for l in block.split("\n") if l.strip()]
        if not lines:
            continue
        cue_start = None
        payload = []
        for line in lines:
            t = parse_cue_start(line)
            if t is not None:
                cue_start = t
                payload = []
            elif cue_start is not None:
                payload.append(line)
        if cue_start is None:
            continue

        # 只取帶逐字標記的那一行；沒有標記的是 rolling 重印，整行丟掉。
        tagged = [l for l in payload if TAG.search(l)]
        if not tagged:
            continue

        for line in tagged:
            # 切成 [文字, 時間, 文字, 時間, ...]：第一段文字歸屬 cue 起點。
            parts = TAG.split(line)
            # split 後每 4 個一組（text, hh, mm, ss.mmm）；先處理開頭那段
            head = parts[0]
            cursor = cue_start
            for w in clean_text(head).split():
                words.append((cursor, w))
            i = 1
            while i + 3 <= len(parts):
                t = to_seconds(parts[i], parts[i + 1], parts[i + 2])
                chunk = clean_text(parts[i + 3])
                for w in chunk.split():
                    words.append((t, w))
                i += 4

    # 去重＋強制單調遞增：同一個 (時間, 單字) 只留第一次。
    out: list[tuple[float, str]] = []
    seen: set[tuple[float, str]] = set()
    last_t = -1.0
    for t, w in words:
        if (t, w) in seen:
            continue
        seen.add((t, w))
        t = max(t, last_t)
        last_t = t
        out.append((t, w))
    return out


def clean_text(s: str) -> str:
    s = re.sub(r"</?c[^>]*>", " ", s)      # <c> / </c>
    s = re.sub(r"<[^>]*>", " ", s)         # 其餘任何標籤
    s = html.unescape(s)                   # &gt;&gt; → >>
    s = s.replace(">>", " ")               # YouTube 的換人說話標記，對學習沒用
    s = re.sub(r"align:start|position:\d+%", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def ends_sentence(word: str) -> bool:
    w = word.lower()
    if w in ABBREV:
        return False
    # 允許句尾標點後面跟著引號/括號
    return bool(re.search(r"[.!?…][\"'”’)\]]*$", word))


def build_sentences(words, max_sec: float, max_chars: int):
    sentences = []
    cur: list[str] = []
    cur_start = None

    for t, w in words:
        if cur_start is None:
            cur_start = t
        cur.append(w)
        text = " ".join(cur)
        too_long = (t - cur_start) >= max_sec or len(text) >= max_chars
        if ends_sentence(w) or too_long:
            sentences.append({"start": cur_start, "last": t, "text": text})
            cur, cur_start = [], None

    if cur:
        sentences.append(
            {"start": cur_start, "last": words[-1][0], "text": " ".join(cur)}
        )

    # end 接到下一句的 start：跟播高亮靠 start<=t<end 判斷，留空隙會讓
    # 某些秒數「沒有任何一句是當前句」，畫面看起來像卡住。
    for i, s in enumerate(sentences):
        s["end"] = (
            sentences[i + 1]["start"] if i + 1 < len(sentences) else s["last"] + 2.0
        )
        if s["end"] <= s["start"]:
            s["end"] = s["start"] + 0.5
    return sentences


def fmt(t: float) -> str:
    h, rem = divmod(t, 3600)
    m, s = divmod(rem, 60)
    return f"{int(h):02d}:{int(m):02d}:{s:06.3f}"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("dst")
    ap.add_argument("--max-sec", type=float, default=14.0)
    ap.add_argument("--max-chars", type=int, default=220)
    args = ap.parse_args()

    raw = open(args.src, encoding="utf-8").read()
    words = extract_words(raw)
    if not words:
        print("❌ 抽不到任何帶時間標記的字——這份 vtt 可能不是 YouTube 自動字幕", file=sys.stderr)
        return 1

    sentences = build_sentences(words, args.max_sec, args.max_chars)

    with open(args.dst, "w", encoding="utf-8") as f:
        f.write("WEBVTT\n\n")
        for i, s in enumerate(sentences, 1):
            f.write(f"{i}\n{fmt(s['start'])} --> {fmt(s['end'])}\n{s['text']}\n\n")

    total = words[-1][0]
    print(f"words: {len(words)}  sentences: {len(sentences)}  covers: {fmt(total)}")
    avg = sum(len(s["text"]) for s in sentences) / len(sentences)
    print(f"avg chars/sentence: {avg:.0f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
