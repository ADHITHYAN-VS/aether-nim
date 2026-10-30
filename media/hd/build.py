#!/usr/bin/env python3
"""Cinematic rebuild. Run from cwd=media/hd. Requires manifest.json + s1..s9.mp3 + ../demo-tavily-v2.webm"""
import json
import subprocess
import sys

MAN = json.load(open("manifest.json"))
SEGS = MAN["segments"]
TOTAL = MAN["total"]
RAW = "../demo-tavily-v2.webm"
FPS = 30
CARD_NAMES = {"s1", "s3", "s5", "s7", "s9"}
CMAP = {"s1": "c1", "s3": "c2", "s5": "c3", "s7": "c4", "s9": "c5"}
FOOT = {"s2": 84.0, "s4": 105.0, "s6": 137.0, "s8": 209.0}
X = "w-text_w)/2"  # unused helper char

ARIALB = r"C\:/Windows/Fonts/arialbd.ttf"
ARIAL = r"C\:/Windows/Fonts/arial.ttf"


def run(cmd):
    r = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    if r.returncode != 0:
        print("FAILED:", cmd[:300])
        print(r.stderr[-2500:])
        sys.exit(1)


def esc(t):
    t = t.replace("\\", "").replace(":", "\\:").replace("'", "\\'").replace(",", "\\,")
    t = t.replace("λ", "lambda_").replace("₂", "2")
    t = t.replace("u2022", "").replace("u2014", "-").replace("u2192", "->")
    return t


def dt(text, font, size, color, x, y=None):
    if y is None:
        x, y = x.split(",", 1)
    return ("drawtext=fontfile='" + font + "':text='" + esc(text) + "':fontsize=" + str(size)
            + ":fontcolor=" + color + ":x=" + x + ":y=" + y)


CENTER = "(w-text_w)/2"

# ---------------- 1. narration wav ----------------
with open("alist.txt", "w") as f:
    for s in SEGS:
        f.write("file '" + s["name"] + ".mp3'\n")
run("ffmpeg -y -v error -f concat -safe 0 -i alist.txt -ar 44100 narration.wav")
print("narration ok")

# ---------------- 2. cards ----------------
BGHEAD = [
    "drawbox=x=0:y=0:w=1920:h=6:color=0x22d3ee@0.9:t=fill",
    dt("AETHER-NIM", ARIALB, 46, "0x22d3ee", "80", "52"),
    None,  # tag filled per card
    "drawbox=x=0:y=104:w=1920:h=2:color=0x1f2937:t=fill",
]


def card(name, tag, draws):
    fil = [BGHEAD[0], BGHEAD[1],
           dt(tag, ARIALB, 30, "0x6b7280", "w-tw-80", "58"),
           BGHEAD[3]] + draws
    vf = ",".join(fil)
    run('ffmpeg -y -v error -f lavfi -i color=c=0x0d1117:s=1920x1200 -vf "' + vf + '" -frames:v 1 ' + name + ".png")


card("c1", "THE HOOK", [
    dt("AETHER-NIM", ARIALB, 120, "0x22d3ee", CENTER + ",420"),
    dt("an autonomous resilience twin for fiber networks", ARIAL, 46, "0xe5e7eb", CENTER + ",590"),
    dt("Nebius x NVIDIA Global AI Hackathon 2026", ARIAL, 32, "0x6b7280", CENTER + ",690"),
])
card("c2", "THE GAP", [
    dt("The gap in operations today", ARIALB, 44, "0xe5e7eb", "120,180"),
    dt("Dashboards say", ARIALB, 56, "0xf87171", "160,330"),
    dt("something broke", ARIAL, 40, "0x9ca3af", "200,450"),
    dt("Meetings decide", ARIALB, 56, "0xfbbf24", "1020,330"),
    dt("what to do next", ARIAL, 40, "0x9ca3af", "1060,450"),
    dt("hours pass", ARIAL, 40, "0x9ca3af", "1060,540"),
    "drawbox=x=120:y=770:w=1680:h=160:color=0x111827:t=fill",
    dt("The answer is already inside the graph.", ARIALB, 42, "0xe5e7eb", CENTER + ",830"),
])
card("c3", "THE DIAGNOSIS", [
    dt("Diagnosis runs two sources at once.", ARIALB, 46, "0xe5e7eb", "120,170"),
    dt("NVIDIA Nemotron", ARIALB, 48, "0x22d3ee", "180,360"),
    dt("structured incident report to strict JSON plan", ARIAL, 34, "0x9ca3af", "220,450"),
    dt("Tavily Search API", ARIALB, 48, "0x34d399", "180,620"),
    dt("live call: real fiber-outage context from the open web", ARIAL, 34, "0x9ca3af", "220,710"),
    dt("citations stay visible on screen", ARIAL, 32, "0x6b7280", CENTER + ",1000"),
])
card("c4", "THE RULE", [
    dt("AI proposes.", ARIALB, 100, "0x22d3ee", CENTER + ",360"),
    dt("The engine disposes.", ARIALB, 100, "0xfbbf24", CENTER + ",540"),
    dt("validator -> optimizer -> rollback armed", ARIAL, 40, "0x9ca3af", CENTER + ",760"),
])
card("c5", "THE PROOF", [
    dt("TRUST, BUT VERIFY", ARIALB, 92, "0xe5e7eb", CENTER + ",400"),
    dt("as software.", ARIALB, 80, "0x22d3ee", CENTER + ",540"),
    dt("lambda2 restored - 5/5 demand pairs - verified by engine", ARIAL, 38, "0x9ca3af", CENTER + ",720"),
    dt("devpost.com/software/aether-nim", ARIAL, 30, "0x6b7280", CENTER + ",880"),
])
print("cards ok")

# ---------------- 3. per-slot video ----------------
slots = []
for s in SEGS:
    n, d = s["name"], s["dur"]
    out = "slot_" + n + ".mp4"
    if n in CARD_NAMES:
        run("ffmpeg -y -v error -loop 1 -i " + CMAP[n] + ".png -t " + ("%.3f" % d)
            + " -r " + str(FPS) + " -c:v libx264 -preset medium -crf 17 -pix_fmt yuv420p -an " + out)
    else:
        run("ffmpeg -y -v error -fflags +genpts -ss " + ("%.3f" % FOOT[n]) + " -i " + RAW
            + " -t " + ("%.3f" % d)
            + " -vf scale=1920:1200:flags=lanczos,setsar=1,fps=" + str(FPS)
            + " -an -c:v libx264 -preset medium -crf 17 -pix_fmt yuv420p " + out)
    slots.append(out)
    print(out, "ok")
with open("vlist.txt", "w") as f:
    for sf in slots:
        f.write("file '" + sf + "'\n")
run("ffmpeg -y -v error -f concat -safe 0 -i vlist.txt -c copy video_all.mp4")
print("video_all ok")

# ---------------- 4. captions ----------------


def at(sec):
    return "%d:%02d:%05.2f" % (int(sec // 3600), int(sec % 3600 // 60), sec % 60)


ev = []
for s in SEGS:
    ev.append("Dialogue: 0," + at(s["start"]) + "," + at(s["start"] + s["dur"]) + ",Cap,,0,0,0,," + s["text"])
open("caps.ass", "w", encoding="utf-8").write(
"""[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1200
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV
Style: Cap,Verdana,34,&H00FFFFFF,&H00000000,&H90000000,-1,3,3,0,2,90,90,56

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
""" + "\n".join(ev) + "\n")

# ---------------- 5. music bed ----------------
run("ffmpeg -y -v error -f lavfi -i \"aevalsrc='(0.05*sin(2*PI*110*t)+0.026*sin(2*PI*220.7*t)"
    "+0.014*sin(2*PI*330.2*t))*(0.75+0.25*sin(2*PI*0.07*t))':s=44100:d=" + ("%.3f" % TOTAL) + "\" "
    "-af \"lowpass=f=900,afade=t=in:d=2.5,afade=t=out:st=" + ("%.3f" % (TOTAL - 3)) + ":d=3\" music.wav")

# ---------------- 6. mux + burn captions ----------------
run("ffmpeg -y -v error -i video_all.mp4 -i narration.wav -i music.wav "
    "-filter_complex \"[1:a]volume=1.0[a1];[2:a]volume=0.17[a2];"
    "[a1][a2]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95[aout]\" "
    "-map 0:v -map [aout] -c:v libx264 -preset medium -crf 17 -pix_fmt yuv420p -c:a aac -b:a 160k "
    "-t " + ("%.3f" % TOTAL) + " muxed.mp4")
run("ffmpeg -y -v error -i muxed.mp4 -vf subtitles=caps.ass "
    "-c:v libx264 -preset medium -crf 17 -pix_fmt yuv420p -c:a copy final_hd.mp4")
print("final_hd.mp4 DONE")
