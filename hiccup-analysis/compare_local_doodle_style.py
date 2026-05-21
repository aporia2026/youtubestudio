"""Doodle-Explainer style comparison for the three local image models.

Parity with `scripts/style-spike.ts` (the cloud-Kie blind-rank spike) but
for the FREE local stack — same style, same chained-reference pattern,
different model set. Lets us pick the right local default for the
doodle-explainer style (the user's actual production look) rather than
the generic 4-prompt smoke ran earlier.

What this does:
  1. Uploads the strongest doodle reference image to ComfyUI's input/
     folder via the shared upload-to-input helper.
  2. For each of 4 representative prompts × 3 local models, fires an i2i
     generation against that reference. Prompt = scene description +
     `doodle_explainer.ai_image_suffix` from production_doc_styles.ts.
  3. Saves outputs to `public/model-comparison/doodle/` so the
     `/local-studio/compare` page can render them as a second
     comparison set.

Denoise: 0.7 — sweet spot for "lock the doodle style + line-weight
strongly, let the scene composition emerge." Lower (0.5) too anchored;
higher (0.85, the comfyui-local default) lets the model drift toward
its own preferred render style.

Prompts: pulled from `_plans/2026-05-21-phase-0-spike-prompts.md`
(p01, p03, p04, p06) — span the 4 failure modes the cloud spike
identified.
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
REF_DIR = PROJECT / "public" / "style-refs" / "Doodle-explainer"
OUT_DIR = PROJECT / "public" / "model-comparison" / "doodle"
OUT_DIR.mkdir(parents=True, exist_ok=True)
HOST = "http://127.0.0.1:8188"

# Long-form composition canvas — same as the cloud spike + production-doc.
WIDTH = 1920
HEIGHT = 1080
DENOISE = 0.7

# The doodle_explainer style's ai_image_suffix — copied verbatim from
# `src/lib/production-doc-styles.ts` so this script doesn't need to
# import TS. If the suffix changes there, paste the new value here.
DOODLE_SUFFIX = (
    "minimalist hand-drawn stick figure doodle, thick uneven black outlines, "
    "simple circular heads, plain white background, flat shadowless lighting, "
    "vibrant saturated accent colors, 2D flat vector animation style, "
    "clean crisp outlines, motion-graphics aesthetic, NOT photorealistic, "
    "NOT a photograph"
)

# 4 of the 10 cloud-spike prompts — one per failure mode (character study,
# two-figure scene, wide chaos, industrial scene).
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

# Strongest doodle anchor (per cloud-spike convention).
REF_FILENAME = "stick-figure-magnifying-glass-phone.png"

# (label, t2i workflow file, i2i workflow file, timeout_s)
MODELS = [
    ("flux-schnell", "flux-schnell-t2i.json", "flux-schnell-i2i.json", 240),
    ("flux-dev",     "flux-dev-t2i.json",     "flux-dev-i2i.json",     420),
    ("qwen-image",   "qwen-image-t2i.json",   "qwen-image-i2i.json",   600),
]


def upload_reference() -> str:
    ref_path = REF_DIR / REF_FILENAME
    if not ref_path.exists():
        raise FileNotFoundError(f"reference image missing: {ref_path}")
    with ref_path.open("rb") as f:
        body = f.read()
    boundary = f"----comparison-{int(time.time())}"
    # Manual multipart so we don't need `requests`. ComfyUI accepts plain
    # multipart/form-data; we attach the image, overwrite=0 (uniquify),
    # type=input.
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


def submit(workflow_file: str, prompt: str, ref_filename: str, client_id: str) -> str:
    text = (WORKFLOWS / workflow_file).read_text(encoding="utf-8")
    text = text.replace("<<PROMPT>>", prompt)
    text = text.replace("<<WIDTH>>", str(WIDTH))
    text = text.replace("<<HEIGHT>>", str(HEIGHT))
    text = text.replace("<<SEED>>", str(random.randint(0, 999999)))
    text = text.replace("<<DENOISE>>", str(DENOISE))
    text = text.replace("<<STEPS>>", "20")
    text = text.replace("<<REF_IMAGE>>", ref_filename)
    if "<<" in text:
        missing = [c.split(">>")[0] for c in text.split("<<")[1:]]
        raise RuntimeError(f"Unfilled placeholders in {workflow_file}: {missing}")
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


def wait_for(pid: str, timeout_s: int) -> tuple[str, int, dict | None]:
    t0 = time.time()
    while True:
        elapsed = int(time.time() - t0)
        if elapsed > timeout_s:
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
        time.sleep(3)


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
    print(f"=== Doodle-style comparison at {WIDTH}x{HEIGHT}, denoise={DENOISE} ===", flush=True)
    print(f"Reference: {REF_FILENAME}", flush=True)
    print(f"Models: {[m[0] for m in MODELS]}", flush=True)
    print(f"Prompts: {len(PROMPTS)}", flush=True)
    print(f"Starting at {time.strftime('%H:%M:%S')}", flush=True)

    print("Uploading reference to ComfyUI input/ ...", flush=True)
    ref_name_on_server = upload_reference()
    print(f"  uploaded as: {ref_name_on_server}", flush=True)

    results: list[dict] = []
    for model_label, _t2i, i2i_workflow, timeout_s in MODELS:
        print(f"\n--- {model_label} ({i2i_workflow}) ---", flush=True)
        for slug, scene_prompt in PROMPTS:
            full_prompt = f"{scene_prompt} {DOODLE_SUFFIX}"
            t0 = time.time()
            client_id = f"doodle-{model_label}-{slug}"
            print(f"  {slug:<22}", end="", flush=True)
            try:
                pid = submit(i2i_workflow, full_prompt, ref_name_on_server, client_id)
            except Exception as e:
                print(f" SUBMIT_FAIL: {e}", flush=True)
                results.append({"model": model_label, "prompt": slug, "ok": False, "error": str(e)[:200]})
                continue
            status, elapsed, entry = wait_for(pid, timeout_s)
            ok = status == "success" and entry is not None
            if not ok:
                print(f" FAIL status={status} elapsed={elapsed}s", flush=True)
                results.append({"model": model_label, "prompt": slug, "ok": False, "error": status, "elapsed": elapsed})
                continue
            fetched = fetch_first_image(entry)
            if fetched is None:
                print(f" FAIL no output ({elapsed}s)", flush=True)
                results.append({"model": model_label, "prompt": slug, "ok": False, "error": "no_output", "elapsed": elapsed})
                continue
            bytes_, _ = fetched
            out_path = OUT_DIR / f"{slug}__{model_label}.png"
            out_path.write_bytes(bytes_)
            print(f" OK {elapsed:>4}s -> {out_path.name}", flush=True)
            results.append({"model": model_label, "prompt": slug, "ok": True, "elapsed": elapsed, "out": out_path.name})

    print("\n=== SUMMARY ===", flush=True)
    for r in results:
        marker = "OK  " if r.get("ok") else "FAIL"
        elapsed = r.get("elapsed", "?")
        extra = r.get("out") or r.get("error", "")
        print(f"  {marker} {r['model']:<14} {r['prompt']:<22} {elapsed}s  {extra}", flush=True)

    by_model: dict[str, list[int]] = {}
    for r in results:
        if r.get("ok") and isinstance(r.get("elapsed"), int):
            by_model.setdefault(r["model"], []).append(r["elapsed"])
    print("\nWarm-time estimate (mean of successful i2i runs):", flush=True)
    for model_label, times in by_model.items():
        mean = sum(times) / len(times) if times else 0
        print(f"  {model_label:<14}  n={len(times)}  mean={mean:.1f}s  min={min(times)}s  max={max(times)}s", flush=True)

    all_ok = all(r.get("ok") for r in results)
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())
