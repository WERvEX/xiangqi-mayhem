"""把录好的镜头、TTS 旁白、字幕和标题合成成片。

用法：.venv/Scripts/python compose.py landscape|portrait|all
输出：out/final/象棋大乱斗-横屏.mp4、out/final/象棋大乱斗-竖屏.mp4

流程：每个镜头先单独裁切、排版成统一尺寸的片段 → 按顺序拼接 → 叠加字幕（ASS）和旁白音轨。
ffmpeg 以低优先级、最多 4 线程运行。
"""

import json
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).parent
CLIPS = ROOT / "out" / "clips"
TTS = ROOT / "out" / "tts"
BUILD = ROOT / "out" / "build"
FONT_FILE = Path("C:/Windows/Fonts/SourceHanSansCNMedium.ttf")
FONT = "Source Han Sans CN Medium"
FPS = 30

LEAD = 0.3  # 每段开头到旁白开始的留白
GAP = 0.5  # 旁白结束到下一段的留白


def ff(*args: str) -> None:
    flags = getattr(subprocess, "BELOW_NORMAL_PRIORITY_CLASS", 0)
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *args]
    r = subprocess.run(cmd, creationflags=flags)
    if r.returncode:
        raise SystemExit(f"ffmpeg 失败：{' '.join(cmd)}")


def probe_duration(path: Path) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
        capture_output=True, text=True,
    ).stdout
    return float(out.strip())


# ───────────── 剪辑表 ─────────────


@dataclass
class Shot:
    clip: str | tuple[str, str]  # 一个镜头，或 (左, 右) 两个镜头并排
    start: float = 0.0
    dur: float | None = None  # None：填满这一段剩下的时间
    title: str = ""  # 标题（横屏在左侧空白处，竖屏在顶部）
    sub: str = ""  # 标题下的一行说明
    freeze_before: float = 0.0  # 开头定格多久（用第一帧）
    placeholder: str = ""  # 还没录的镜头，用文字占位
    cue: str = ""  # 从旁白念到这几个字时切到这个镜头（比 dur 优先，决定上一个镜头的长度）


@dataclass
class Segment:
    id: str  # 对应 narration.json 的段落
    shots: list[Shot]
    hold: float = 0.0  # 旁白结束后额外停留（片尾）
    end_card: bool = False


LANDSCAPE = [
    Segment("h01", [Shot("L-intro", 0, None, freeze_before=4.3)]),
    Segment("h02", [
        Shot("L-intro", 6.6, None, "锦囊三选一", "第 1、5、10、16 回合发放"),
        Shot("L-codex", 2.0, None, "29 个锦囊", "白银 · 黄金 · 棱彩", cue="锦囊一共"),
    ]),
    Segment("h03", [
        Shot("L-tianma", 0.9, None, "天马行空", "马不会被蹩马腿"),
        Shot("L-zongheng", 1.0, None, "纵横天下", "车可以斜着走", cue="车可以"),
        Shot("L-huoshao", 1.0, None, "火烧连营", "炮吃子后烧掉周围的敌子", cue="炮吃子"),
        Shot("L-jieshi", 0.9, None, "借尸还魂", "被吃掉的车马炮原地复活", cue="被吃掉"),
    ]),
    Segment("h04", [
        Shot("L-kingcap", 1.8, None, "吃将获胜", "吃掉对方的将帅就赢"),
        Shot("L-shield", 0.9, None, "护盾", "挡下一次吃子", cue="有些锦囊"),
        Shot("L-kingcap", 0.0, None, "红圈提醒", "将帅可以被直接吃掉", cue="将帅有危险"),
    ]),
    Segment("h05", [
        Shot(("L-online-host", "L-online-guest"), 2.4, 7.0),
        Shot(("L-online-host", "L-online-guest"), 13.3, None),
        Shot("L-hotseat", 0.3, None, "同屏对战", "一台设备，轮流走棋", cue="同屏对战"),
    ]),
    Segment("h06", [
        Shot("L-ai", 0.8, None, "挑战 AI", "四档难度 · 三种性格"),
        Shot("L-ai", 11.4, None, "走法提示", "卡住时让 AI 推荐一步", cue="卡住时"),
    ]),
    # 大模型画面里左侧是模型的对话框，标题只在设置页那几秒显示
    Segment("h07", [
        Shot("L-llm", 0.8, 4.2, "挑战大模型", "接入你自己的大模型"),
        Shot("L-llm", 5.0, None),
        Shot("L-llm", 9.3, None, cue="你每走一步"),
        Shot("L-llm", 33.6, None, cue="想知道"),
        Shot("L-llm-settings", 1.0, None, "密钥只存在本机", "请求由浏览器直接发给服务商", cue="API 密钥"),
    ]),
    Segment("h08", [
        Shot("L-eve", 1.4, 2.2, "模型斗蛐蛐", "DeepSeek 对 GLM"),
        Shot("L-eve", 3.6, None),
        Shot("L-eve", 60.0, None, cue="双方看不到"),
    ]),
    Segment("h09", [
        Shot("L-replay", 0.9, None, "回放", "每局都能回看"),
        Shot("L-replay", 6.7, None, "对局记录", "一条链接分享整局棋", cue="最近的对局"),
    ]),
    Segment("h10", [Shot("L-home", 0.5, None)], hold=1.5, end_card=True),
]

PORTRAIT = [
    Segment("v01", [Shot("P-zongheng", 0.6, None, "象棋大乱斗")]),
    Segment("v02", [
        Shot("P-intro", 6.3, None, "锦囊三选一"),
        Shot("P-tianma", 1.0, None, "天马行空", cue="马不蹩腿"),
        Shot("P-zongheng2", 1.0, None, "纵横天下", cue="车能斜走"),
        Shot("P-jieshi", 1.0, None, "借尸还魂", cue="被吃的子"),
    ]),
    Segment("v03", [
        Shot("P-online-host", 3.6, None, "联机对战"),
        Shot("P-ai", 11.6, None, "挑战 AI", cue="可以挑战"),
        Shot("P-llm", 10.8, None, "挑战大模型", cue="也能接入"),
    ]),
    Segment("v04", [Shot("P-eve", 36.0, None, "模型斗蛐蛐")]),
    Segment("v05", [Shot("P-home", 0.5, None, "象棋大乱斗")], hold=1.0, end_card=True),
]


@dataclass
class Layout:
    name: str
    w: int
    h: int
    edl: list[Segment]
    sub_max: int  # 每条字幕最多几个字
    out_name: str
    # 字幕、标题的位置与字号
    styles: dict = field(default_factory=dict)


LAYOUTS = {
    "landscape": Layout("landscape", 1920, 1080, LANDSCAPE, 22, "象棋大乱斗-横屏.mp4"),
    "portrait": Layout("portrait", 1080, 1920, PORTRAIT, 13, "象棋大乱斗-竖屏.mp4"),
}

# 竖屏：游戏画面缩小放在下方，顶部留一条放标题和字幕
P_SCALE = 0.82
P_TOP = 1920 - round(1920 * P_SCALE)
BG = "0x1c1611"


def clip_path(name: str) -> Path:
    return CLIPS / f"{name}.mp4"


# ───────────── 片段渲染 ─────────────


def render_shot(lay: Layout, shot: Shot, dur: float, out: Path) -> None:
    W, H = lay.w, lay.h
    if shot.placeholder:
        ff("-f", "lavfi", "-i", f"color=c={BG}:s={W}x{H}:r={FPS}:d={dur:.3f}",
           "-c:v", "libx264", "-preset", "veryfast", "-crf", "14", "-threads", "4", "-pix_fmt", "yuv420p", str(out))
        return

    def src_dur(name: str) -> float:
        return probe_duration(clip_path(name))

    names = shot.clip if isinstance(shot.clip, tuple) else (shot.clip,)
    inputs: list[str] = []
    chains: list[str] = []
    need = dur - shot.freeze_before
    for i, n in enumerate(names):
        avail = src_dur(n) - shot.start
        pad_end = max(0.0, need - avail) + 0.1
        inputs += ["-i", str(clip_path(n))]
        chains.append(
            f"[{i}:v]trim=start={shot.start:.3f},setpts=PTS-STARTPTS,"
            f"tpad=start_mode=clone:start_duration={shot.freeze_before:.3f}:stop_mode=clone:stop_duration={pad_end:.3f},"
            f"trim=duration={dur:.3f},setpts=PTS-STARTPTS[s{i}]"
        )
    if len(names) == 2:
        chains.append("[s0][s1]hstack=inputs=2[st]")
        last = "st"
    else:
        last = "s0"
    if lay.name == "portrait":
        sw, sh = round(W * P_SCALE / 2) * 2, round(H * P_SCALE / 2) * 2
        chains.append(f"[{last}]scale={sw}:{sh}:flags=lanczos,pad={W}:{H}:{(W - sw) // 2}:{H - sh}:color={BG}[v]")
    else:
        chains.append(f"[{last}]scale={W}:{H}[v]")
    ff(*inputs, "-filter_complex", ";".join(chains), "-map", "[v]", "-r", str(FPS),
       "-c:v", "libx264", "-preset", "veryfast", "-crf", "14", "-threads", "4", "-pix_fmt", "yuv420p", str(out))


# ───────────── 字幕 ─────────────


def ass_time(t: float) -> str:
    t = max(0.0, t)
    h = int(t // 3600)
    m = int(t % 3600 // 60)
    s = t % 60
    return f"{h}:{m:02d}:{s:05.2f}"


def split_sentence(text: str, start: float, end: float, max_len: int) -> list[tuple[str, float, float]]:
    """按标点把一句话切成几条字幕，时间按字数分配；去掉句末标点"""
    parts = [p for p in re.split(r"(?<=[，。：；！？、])", text) if p.strip()]
    chunks: list[str] = []
    for p in parts:
        if chunks and len(chunks[-1]) + len(p) <= max_len and not re.search(r"[。：；！？]$", chunks[-1]):
            chunks[-1] += p
        else:
            chunks.append(p)
    total = sum(len(c) for c in chunks)
    out, t = [], start
    for c in chunks:
        d = (end - start) * len(c) / total
        out.append((re.sub(r"[，。：；、]$", "", c), t, t + d))
        t += d
    return out


def ass_header(lay: Layout) -> str:
    W, H = lay.w, lay.h
    if lay.name == "landscape":
        sub = f"Style: Sub,{FONT},46,&H00FFFFFF,&H00FFFFFF,&H00101010,&H90000000,0,0,0,0,100,100,1,0,1,3,1,2,40,40,34,1"
        title = f"Style: Title,{FONT},76,&H0060C8F0,&H00FFFFFF,&H00101010,&H00000000,1,0,0,0,100,100,4,0,1,2,0,5,0,0,0,1"
        note = f"Style: Note,{FONT},36,&H00D8E4EC,&H00FFFFFF,&H00101010,&H00000000,0,0,0,0,100,100,1,0,1,1.5,0,5,0,0,0,1"
        url = f"Style: Url,{FONT},38,&H00FFFFFF,&H00FFFFFF,&H00101010,&H00000000,0,0,0,0,100,100,0,0,1,1.5,0,5,0,0,0,1"
    else:
        sub = f"Style: Sub,{FONT},58,&H00FFFFFF,&H00FFFFFF,&H00101010,&H90000000,0,0,0,0,100,100,1,0,1,3,1,8,40,40,{P_TOP - 130},1"
        title = f"Style: Title,{FONT},84,&H0060C8F0,&H00FFFFFF,&H00101010,&H00000000,1,0,0,0,100,100,6,0,1,2,0,8,0,0,60,1"
        note = f"Style: Note,{FONT},44,&H00D8E4EC,&H00FFFFFF,&H00101010,&H00000000,0,0,0,0,100,100,1,0,1,1.5,0,5,0,0,0,1"
        url = f"Style: Url,{FONT},56,&H00FFFFFF,&H00FFFFFF,&H00101010,&HC0000000,1,0,0,0,100,100,0,0,3,24,0,5,0,0,0,1"
    return (
        "[Script Info]\nScriptType: v4.00+\n"
        f"PlayResX: {W}\nPlayResY: {H}\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n"
        "[V4+ Styles]\n"
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, "
        "Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n"
        f"{sub}\n{title}\n{note}\n{url}\n\n"
        "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
    )


def dialogue(start: float, end: float, style: str, text: str, tags: str = "") -> str:
    return f"Dialogue: 0,{ass_time(start)},{ass_time(end)},{style},,0,0,0,,{tags}{text}\n"


def captions(lay: Layout, shot: Shot, t0: float, t1: float) -> str:
    """镜头标题：横屏放在左侧空白区，竖屏放在顶部"""
    out = ""
    fade = r"{\fad(250,200)"
    if shot.placeholder:
        return dialogue(t0, t1, "Title", shot.placeholder, fade + rf"\pos({lay.w // 2},{lay.h // 2})}}")
    if not shot.title:
        return ""
    if lay.name == "landscape":
        out += dialogue(t0, t1, "Title", shot.title, fade + r"\pos(335,470)}")
        if shot.sub:
            out += dialogue(t0, t1, "Note", shot.sub, fade + r"\pos(335,555)}")
    else:
        out += dialogue(t0, t1, "Title", shot.title, fade + "}")
    return out


def end_card(lay: Layout, t0: float, t1: float) -> str:
    fade = r"{\fad(400,0)"
    if lay.name == "landscape":
        return (
            dialogue(t0, t1, "Title", "象棋大乱斗", fade + r"\fs96\pos(335,450)}")
            + dialogue(t0, t1, "Note", "电脑 · 手机 · 打开浏览器就能玩", fade + r"\pos(335,545)}")
            + dialogue(t0, t1, "Note", "在线游玩", fade + r"\pos(1585,420)}")
            + dialogue(t0, t1, "Url", "wervex.github.io/xiangqi-mayhem", fade + r"\pos(1585,470)}")
            + dialogue(t0, t1, "Note", "开源地址", fade + r"\pos(1585,580)}")
            + dialogue(t0, t1, "Url", "github.com/WERvEX/xiangqi-mayhem", fade + r"\pos(1585,630)}")
        )
    # 压暗游戏画面（顶部标题区本来就是深色），再在中间放网址
    dim = rf"{{\fad(400,0)\an7\pos(0,{P_TOP})\p1\bord0\shad0\1c&H000000&\1a&H50&}}m 0 0 l {lay.w} 0 {lay.w} {lay.h} 0 {lay.h}{{\p0}}"
    return (
        dialogue(t0, t1, "Note", dim)
        + dialogue(t0, t1, "Note", "在线游玩", fade + rf"\pos({lay.w // 2},1020)}}")
        + dialogue(t0, t1, "Url", "wervex.github.io/xiangqi-mayhem", fade + rf"\pos({lay.w // 2},1110)}}")
        + dialogue(t0, t1, "Note", "电脑 · 手机 · 打开浏览器就能玩", fade + rf"\pos({lay.w // 2},1230)}}")
    )


# ───────────── 合成 ─────────────


def cue_time(sentences: list[dict], cue: str) -> float:
    """旁白里念到 cue 的时间（句内按字数估算），相对旁白开头"""
    for s in sentences:
        i = s["text"].find(cue)
        if i >= 0:
            return s["start"] + (s["end"] - s["start"]) * i / len(s["text"])
    raise SystemExit(f"旁白里找不到「{cue}」")


def shot_starts(seg: "Segment", sentences: list[dict]) -> list[float]:
    """每个镜头在本段内的开始时间：有 cue 的对齐旁白（提前 0.15s），否则接在上一个镜头后面"""
    starts = [0.0]
    for i, shot in enumerate(seg.shots[1:], 1):
        if shot.cue:
            starts.append(LEAD + cue_time(sentences, shot.cue) - 0.15)
        else:
            prev = seg.shots[i - 1]
            if prev.dur is None:
                raise SystemExit(f"{seg.id}：第 {i} 个镜头没有 dur，后面的镜头需要 cue")
            starts.append(starts[-1] + prev.dur)
    return starts


def build(lay: Layout) -> None:
    narration = {s["id"]: s for s in json.loads((ROOT / "narration.json").read_text(encoding="utf-8"))[lay.name]}
    work = BUILD / lay.name
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir(parents=True)
    fonts = BUILD / "fonts"
    fonts.mkdir(parents=True, exist_ok=True)
    if not (fonts / FONT_FILE.name).exists():
        shutil.copy(FONT_FILE, fonts / FONT_FILE.name)

    ass = ass_header(lay)
    parts: list[Path] = []
    audio: list[tuple[Path, float]] = []
    t = 0.0
    for seg in lay.edl:
        if seg.id not in narration:
            raise SystemExit(f"narration.json 里没有 {seg.id}")
        sentences = json.loads((TTS / f"{seg.id}.json").read_text(encoding="utf-8"))
        voice_len = sentences[-1]["end"]
        seg_len = LEAD + voice_len + GAP + seg.hold
        starts = shot_starts(seg, sentences)
        fill = [i for i, s in enumerate(seg.shots) if s.dur is None and i + 1 < len(seg.shots) and not seg.shots[i + 1].cue]
        if fill:
            raise SystemExit(f"{seg.id}：只有最后一个镜头或后面接着 cue 的镜头可以不写 dur")
        st = t
        for i, shot in enumerate(seg.shots):
            end = starts[i + 1] if i + 1 < len(seg.shots) else seg_len
            d = end - starts[i]
            if d < 0.8:
                print(f"  警告：{seg.id} 第 {i + 1} 个镜头只有 {d:.2f}s")
                d = max(d, 0.3)
            out = work / f"{len(parts):03d}.mp4"
            render_shot(lay, shot, d, out)
            parts.append(out)
            ass += captions(lay, shot, st, st + d)
            st += d
        seg_len = st - t
        audio.append((TTS / f"{seg.id}.mp3", t + LEAD))
        for s in sentences:
            for text, a, b in split_sentence(s["text"], t + LEAD + s["start"], t + LEAD + s["end"], lay.sub_max):
                ass += dialogue(a, b, "Sub", text)
        if seg.end_card:
            ass += end_card(lay, t + 0.4, t + seg_len)
        print(f"  {seg.id}: {t:6.2f}s → {t + seg_len:6.2f}s")
        t += seg_len

    total = t
    (work / "list.txt").write_text("".join(f"file '{p.name}'\n" for p in parts), encoding="utf-8")
    ass_path = work / "subs.ass"
    ass_path.write_text(ass, encoding="utf-8")

    # 旁白音轨：每段放到对应时间，混在一起
    a_inputs: list[str] = []
    a_chain: list[str] = []
    for i, (p, at) in enumerate(audio):
        a_inputs += ["-i", str(p)]
        ms = round(at * 1000)
        a_chain.append(f"[{i + 1}:a]adelay={ms}|{ms},aresample=48000[a{i}]")
    mix = "".join(f"[a{i}]" for i in range(len(audio))) + f"amix=inputs={len(audio)}:normalize=0,apad,atrim=0:{total:.3f},loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[aout]"

    rel = lambda p: p.relative_to(ROOT).as_posix()  # noqa: E731  ass 滤镜的路径里不能有盘符冒号，用相对路径
    vf = f"[0:v]subtitles={rel(ass_path)}:fontsdir={rel(fonts)},fade=t=in:st=0:d=0.4,fade=t=out:st={total - 0.6:.3f}:d=0.6[vout]"
    out_file = ROOT / "out" / "final" / lay.out_name
    out_file.parent.mkdir(parents=True, exist_ok=True)
    ff("-f", "concat", "-safe", "0", "-i", str(work / "list.txt"), *a_inputs,
       "-filter_complex", ";".join([vf, *a_chain, mix]),
       "-map", "[vout]", "-map", "[aout]", "-r", str(FPS),
       "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-threads", "4", "-pix_fmt", "yuv420p",
       "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", "-t", f"{total:.3f}", str(out_file))
    print(f"完成：{out_file.name}，{total:.1f}s")


if __name__ == "__main__":
    import os

    os.chdir(ROOT)
    which = sys.argv[1] if len(sys.argv) > 1 else "all"
    for name in (LAYOUTS if which == "all" else [which]):
        print(name)
        build(LAYOUTS[name])
    shutil.rmtree(BUILD, ignore_errors=True)  # 中间片段和字幕文件，合成完就不需要了
