#!/usr/bin/env python3
"""Build a compact preview glossary from the user's TOEFL vocabulary PDFs."""

import json
import re
import sys

import pdfplumber


def clean(value):
    return re.sub(r"\s+", " ", str(value or "")).strip()


def parse_pos_and_meaning(raw):
    value = clean(raw)
    match = re.match(r"^(n\./v\.|n\./adj\.|adj\.|adv\.|v\.|n\.)\s*(.*)$", value, re.I)
    if not match:
        return "", value
    pos = match.group(1).lower()
    mapping = {
        "n.": "noun",
        "v.": "verb",
        "adj.": "adjective",
        "adv.": "adverb",
        "n./v.": "noun / verb",
        "n./adj.": "noun / adjective",
    }
    return mapping.get(pos, ""), match.group(2).strip()


def trim_notes(value):
    value = re.sub(r"[（(](?:名词|动词|形容词|复数|高频词|注意|热点短语).*?[）)]", "", value)
    return clean(value).strip("；;，, ")


def read_reading_vocabulary(path, entries):
    with pdfplumber.open(path) as pdf:
        for page in pdf.pages:
            for table in page.extract_tables():
                for row in table:
                    if not row:
                        continue
                    for offset in (0, 3):
                        if len(row) < offset + 3:
                            continue
                        word = clean(row[offset + 1]).lower()
                        meaning = clean(row[offset + 2])
                        if re.fullmatch(r"[a-z][a-z -]*", word) and meaning:
                            entries[word] = {"word": word, "partOfSpeech": "", "zh": meaning, "source": "桌面·托福阅读必备词汇"}


def read_high_frequency_vocabulary(path, entries):
    with pdfplumber.open(path) as pdf:
        for page in pdf.pages:
            for table in page.extract_tables():
                for row in table:
                    if not row or len(row) < 3:
                        continue
                    word = clean(row[1]).lower()
                    raw_meaning = clean(row[2])
                    if not re.fullmatch(r"[a-z][a-z -/]*", word) or not raw_meaning:
                        continue
                    part_of_speech, meaning = parse_pos_and_meaning(raw_meaning)
                    entries[word] = {
                        "word": word,
                        "partOfSpeech": part_of_speech,
                        "zh": trim_notes(meaning),
                        "source": "桌面·新托福高频词汇",
                    }


def main():
    if len(sys.argv) != 4:
        raise SystemExit("usage: extract-desktop-glossary.py READING_PDF HIGH_FREQUENCY_PDF OUTPUT_JSON")
    entries = {}
    read_reading_vocabulary(sys.argv[1], entries)
    read_high_frequency_vocabulary(sys.argv[2], entries)
    with open(sys.argv[3], "w", encoding="utf-8") as output:
        json.dump(sorted(entries.values(), key=lambda item: item["word"]), output, ensure_ascii=False, indent=2)
        output.write("\n")
    print(f"wrote {len(entries)} glossary entries to {sys.argv[3]}")


if __name__ == "__main__":
    main()
