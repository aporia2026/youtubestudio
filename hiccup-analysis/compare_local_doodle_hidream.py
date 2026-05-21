"""Doodle-style comparison run for HiDream-I1 only.

The earlier `compare_local_doodle_style.py` covered Flux schnell, Flux dev,
and Qwen-Image (i2i at denoise 0.7, doodle reference image, doodle_explainer
ai_image_suffix). HiDream wasn't included because the original verdict was
"doesn't work on 16 GB."

After the May 22 t5xxl-fp8 → Q5_K_M GGUF correctness fix, HiDream's
workflow at least *compiles* properly. This script tries the same 4
prompts on HiDream and writes results (or failure markers) into
public/model-comparison/doodle/ so the /local-studio/compare page can
add a HiDream column.

Expected outcome based on the earlier KSampler-hang verdict: HiDream
will time out on every prompt at 16 GB. The compare page then shows
"timeout — needs 24 GB" cells. If we're wrong and it actually completes,
the cells light up.

Generous timeout: 600s per prompt. The original solo smoke ran for 900s
with zero progress, so anything under 600s indicates real sampling.
"""
from __future__ import annotations

import json
import random
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

PROJECT = Path(r"C:\youtubestudio-live")
WORKFLOWS = PROJECT / "src" / "lib" / "comfyui" / "workflows"
OUT_DIR = PROJECT / "public" / "model-comparison" / "doodle"
OUT_DIR.mkdir(parents=True, exist_ok=True)
HOST = "http://127.0.0.1:8188"

WIDTH = 1024     # HiDream is verified to hang at sampling on 16 GB —
HEIGHT = 576     # smaller canvas reduces activation memory marginally.
DENOISE = 0.7    # Same as the rest of the doodle suite.

DOODLE_SUFFIX = (
    "minimalist hand-drawn stick figure doodle, thick uneven black outlines, "
    "simple circular heads, plain white background, flat shadowless lighting, "
    "vibrant saturated accent colors, 2D flat vector animation style, "
    "clean crisp outlines, motion-graphics aesthetic, NOT photorealistic, "
    "NOT a photograph"
)

PROMPTS = [
    ("p01-character-emotion",
     "Close-up of a stick figure with a curious face gently pressing a small button labeled TEST, "
     "followed by a huge red warning burst exploding outward; figure leans back in alarm."),
    ("p03-two-figures",
     "Two stick figures: one in a sneaky pose handing a fake paper message to the other "
     "who sits at an old computer; arrows lead from the message to the second figure's head."),
    ("p04-wide-chaos",
     "Wide scene: a row of computer terminals bent over with smoke puffs and red overload symbols; "
     "a giant '$10 MILLION' cleanup bill rising in the center; an alarm bell ringing above a "
     "sleeping internet globe just waking up with wide eyes."),
    ("p06-industrial",
     "A stick figure engineer in a hard hat watches industrial machines spin wildly out of control; "
     "a cartoon worm with a smug face slithers between them leaving sparkles; warning triangles "
     "everywhere; the lone engineer holds a tiny clipboard looking puzzled."),
]

REF_FILENAME = "stick-figure-magnifying-glass-phone.png"
REF_DIR = PROJECT / "public" / "style-refs" / "Doodle-explainer"

I2I_WORKFLOW = "hidream-i1-dev-i2i.json"
TIMEOUT_S = 600


def upload_reference() -> str:
    ref_path = REF_DIR / REF_FILENAME
    if not ref_path.exists():
        raise FileNotFoundError(f"reference image missing: {ref_path}")
    body = ref_path.read_bytes()
    boundary = f"----compare-hidream-{int(time.time())}"
    parts: list[bytes] = []
    for key, value in [("overwrite", "0"), ("type", "input")]:
        parts.append(f"--{boundary}\r\n".encode())
        parts.append(f'Content-Disposition: form-data; name="{key}"\r\n\r\n'.encode())
        parts.append(value.encode())
        parts.append(b"\r\n")
    parts.append(f"--{boundary}\r\n".encode())
    parts.append(
        f'Content-Disposition: form-data; name="image"; filename="doodle-ref.png"\r\n'.encode()
    )
    parts.append(b"Content-Type: image/png\r\n\r\n")
    parts.append(body)
    parts.append(f"\r\n--{boundary}--\r\n".encode())
    payload = b"".join(parts)
    req = urllib.request.Request(
        f"{HOST}/upload/image",
        data=payload,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read())
    if not data.get("name"):
        raise RuntimeError(f"ComfyUI upload response missing name: {data}")
    return data["name"]


def submit(prompt: str, ref_filename: str, client_id: str) -> str:
    text = (WORKFLOWS / I2I_WORKFLOW).read_text(encoding="utf-8")
    text = text.replace("<<PROMPT>>", prompt)
    text = text.replace("<<WIDTH>>", str(WIDTH))
    text = text.replace("<<HEIGHT>>", str(HEIGHT))
    text = text.replace("<<SEED>>", str(random.randint(0, 999999)))
    text = text.replace("<<DENOISE>>", str(DENOISE))
    text = text.replace("<<STEPS>>", "20")
    text = text.replace("<<REF_IMAGE>>", ref_filename)
    if "<<" in text:
        missing = [c.split(">>")[0] for c in text.split("<<")[1:]]
        raise RuntimeError(f"Unfilled placeholders in {I2I_WORKFLOW}: {missing}")
    graph = json.loads(text)
    payload = json.dumps({"prompt": graph, "client_id": client_id}).encode("utf-8")
    req = urllib.request.Request(
        f"{HOST}/prompt",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read())["prompt_id"]
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"HTTP {e.code}: {e.read().decode('utf-8', 'ignore')[:600]}")


def wait_for(pid: str) -> tuple[str, int, dict | None]:
    t0 = time.time()
    while True:
        elapsed = int(time.time() - t0)
        if elapsed > TIMEOUT_S:
            urllib.request.urlopen(urllib.request.Request(f"{HOST}/interrupt", method="POST"))
            return ("timeout", elapsed, None)
        try:
            with urllib.request.urlopen(f"{HOST}/history/{pid}", timeout=10) as r:
                hist = json.loads(r.read())
            entry = hist.get(pid)
            if entry and entry.get("status", {}).get("completed"):
                return (entry["status"].get("status_str", "unknown"), elapsed, entry)
        except Exception:
            pass
        time.sleep(5)


def fetch_first_image(entry: dict) -> tuple[bytes, str] | None:
    outputs = entry.get("outputs", {}) or {}
    for node_out in outputs.values():
        for img in node_out.get("images", []):
            url = (
                f"{HOST}/view?"
                f"filename={urllib.parse.quote(img['filename'])}&"
                f"subfolder={urllib.parse.quote(img.get('subfolder',''))}&"
                f"type={urllib.parse.quote(img['type'])}"
            )
            with urllib.request.urlopen(url, timeout=30) as r:
                return r.read(), img["filename"]
    return None


def main() -> int:
    print(f"=== HiDream doodle smoke at {WIDTH}x{HEIGHT}, denoise={DENOISE} ===", flush=True)
    print(f"Reference: {REF_FILENAME}", flush=True)
    print(f"Timeout per prompt: {TIMEOUT_S}s", flush=True)
    print(f"Starting at {time.strftime('%H:%M:%S')}", flush=True)

    print("Uploading reference to ComfyUI input/ ...", flush=True)
    ref_name = upload_reference()
    print(f"  uploaded as: {ref_name}", flush=True)

    results: list[dict] = []
    for slug, scene_prompt in PROMPTS:
        full_prompt = f"{scene_prompt} {DOODLE_SUFFIX}"
        t0 = time.time()
        client_id = f"doodle-hidream-{slug}"
        print(f"\n  {slug:<22}", end="", flush=True)
        try:
            pid = submit(full_prompt, ref_name, client_id)
        except Exception as e:
            print(f" SUBMIT_FAIL: {e}", flush=True)
            results.append({"prompt": slug, "ok": False, "error": str(e)[:200]})
            continue
        status, elapsed, entry = wait_for(pid)
        if status != "success" or entry is None:
            print(f" FAIL status={status} elapsed={elapsed}s", flush=True)
            results.append({"prompt": slug, "ok": False, "error": status, "elapsed": elapsed})
            continue
        fetched = fetch_first_image(entry)
        if fetched is None:
            print(f" FAIL no output ({elapsed}s)", flush=True)
            results.append({"prompt": slug, "ok": False, "error": "no_output", "elapsed": elapsed})
            continue
        bytes_, _ = fetched
        out_path = OUT_DIR / f"{slug}__hidream-i1.png"
        out_path.write_bytes(bytes_)
        print(f" OK {elapsed:>4}s -> {out_path.name}", flush=True)
        results.append({"prompt": slug, "ok": True, "elapsed": elapsed, "out": out_path.name})

    print("\n=== SUMMARY ===", flush=True)
    for r in results:
        marker = "OK  " if r.get("ok") else "FAIL"
        elapsed = r.get("elapsed", "?")
        extra = r.get("out") or r.get("error", "")
        print(f"  {marker} {r['prompt']:<22} {elapsed}s  {extra}", flush=True)

    all_ok = all(r.get("ok") for r in results)
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())
