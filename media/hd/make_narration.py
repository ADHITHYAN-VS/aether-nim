#!/usr/bin/env python3
"""AETHER-NIM cinematic rebuild: gapless 9-beat narration."""
import asyncio, json, subprocess, sys
import edge_tts

VOICE = "en-US-AndrewNeural"

SEGS = [
 ("s1", "Before a network service ships, someone should find out exactly where it breaks."),
 ("s2", "AETHER-NIM is a crash-test lab for fiber networks. It starts healthy: seventeen nodes, twenty links, five demand pairs, held together by one number, algebraic connectivity: five point three seven."),
 ("s3", "Now the gap. Dashboards show that something broke. Meetings decide what to do next. Hours pass. But the answer is already inside the graph."),
 ("s4", "So we break it, for real. A bridge link fails. Lambda two collapses to exactly zero. Two islands form. Throughput craters. Measured, not imagined."),
 ("s5", "Diagnosis runs two sources at once. A structured incident report goes to NVIDIA Nemotron on Nebius Token Factory. And at the exact same moment, the twin calls the Tavily Search API for live fiber-outage context from the real web."),
 ("s6", "Nemotron returns root causes, a ranked repair plan, risks and confidence, as strict JSON. And you can see the live citations on screen."),
 ("s7", "Now the rule. AI proposes. The engine disposes. Every proposed action is validated against the live graph, planned by a deterministic optimizer, with rollback armed."),
 ("s8", "The repair executes. A separate verifier recomputes every metric from scratch: success. One component. Five out of five demand pairs. Throughput restored. In seconds, not hours."),
 ("s9", "Every claim on this screen was measured, repaired and proven. AETHER-NIM. Trust, but verify, as software. Live demo and code below."),
]

async def main():
    info = []
    for name, text in SEGS:
        f = f"{name}.mp3"
        await edge_tts.Communicate(text, VOICE).save(f)
        d = float(subprocess.check_output(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", f]).decode().strip())
        info.append({"name": name, "text": text, "dur": round(d, 3)})
    t = 0.0
    for seg in info:
        seg["start"] = round(t, 3); t += seg["dur"]
    json.dump({"segments": info, "total": round(t, 3)}, open("manifest.json", "w"), indent=1)
    print(json.dumps(info, indent=1)); print("TOTAL", round(t, 3))

asyncio.run(main())
