"""按 narration.json 生成每段旁白的 mp3 和句级时间轴（json）。

用法：.venv/Scripts/python tts.py [段落id ...]   不带参数则生成全部
输出：out/tts/<id>.mp3、out/tts/<id>.json（[{text, start, end}]，单位秒）

文本里的 "|" 表示停顿：前后分开合成，中间插入 PAUSE 秒静音（列举多个锦囊时给画面留出时间）。
"""

import asyncio
import json
import subprocess
import sys
from pathlib import Path

import edge_tts

ROOT = Path(__file__).parent
OUT = ROOT / "out" / "tts"
PAUSE = 0.55


def duration(path: Path) -> float:
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
                       capture_output=True, text=True)
    return float(r.stdout.strip())


async def synth_part(text: str, voice: str, rate: str, path: Path) -> list[dict]:
    comm = edge_tts.Communicate(text, voice, rate=rate, boundary="SentenceBoundary")
    sentences = []
    with open(path, "wb") as audio:
        async for chunk in comm.stream():
            if chunk["type"] == "audio":
                audio.write(chunk["data"])
            elif chunk["type"] == "SentenceBoundary":
                start = chunk["offset"] / 1e7
                sentences.append({"text": chunk["text"], "start": start, "end": start + chunk["duration"] / 1e7})
    return sentences


async def synth(seg_id: str, text: str, voice: str, rate: str) -> None:
    parts = [p for p in text.split("|") if p.strip()]
    files: list[Path] = []
    sentences: list[dict] = []
    offset = 0.0
    for i, part in enumerate(parts):
        f = OUT / f"{seg_id}.part{i}.mp3"
        ss = await synth_part(part, voice, rate, f)
        for s in ss:
            sentences.append({**s, "start": s["start"] + offset, "end": s["end"] + offset})
        files.append(f)
        offset += duration(f) + PAUSE
    out = OUT / f"{seg_id}.mp3"
    if len(files) == 1:
        files[0].replace(out)
    else:
        inputs = sum((["-i", str(f)] for f in files), [])
        chain = "".join(f"[{i}:a]aresample=24000,apad=pad_dur={PAUSE if i < len(files) - 1 else 0}[p{i}];" for i in range(len(files)))
        chain += "".join(f"[p{i}]" for i in range(len(files))) + f"concat=n={len(files)}:v=0:a=1[a]"
        subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *inputs, "-filter_complex", chain,
                        "-map", "[a]", "-c:a", "libmp3lame", "-b:a", "96k", str(out)], check=True)
        for f in files:
            f.unlink()
    (OUT / f"{seg_id}.json").write_text(json.dumps(sentences, ensure_ascii=False, indent=1), encoding="utf-8")
    end = sentences[-1]["end"] if sentences else 0
    print(f"{seg_id}  {end:5.2f}s  {len(sentences)} 句")


async def main() -> None:
    cfg = json.loads((ROOT / "narration.json").read_text(encoding="utf-8"))
    OUT.mkdir(parents=True, exist_ok=True)
    only = set(sys.argv[1:])
    for seg in cfg["landscape"] + cfg["portrait"]:
        if not only or seg["id"] in only:
            await synth(seg["id"], seg["text"], cfg["voice"], cfg["rate"])


asyncio.run(main())
