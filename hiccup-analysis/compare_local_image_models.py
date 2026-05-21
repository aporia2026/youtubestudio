"""Compare local image models on 4 representative YouTube-style prompts.

Each prompt runs through Flux schnell, Flux dev (reference — NC license),
and Qwen-Image. Outputs land in `hiccup-analysis/model-comparison/` as
`{prompt-slug}-{model}.png` so they can be eyeballed side-by-side and
committed.

Ordered by model (all 4 prompts on schnell first, then dev, then qwen)
so we only pay 3 model-swap cold-loads instead of 12. Per-generation
time then converges to the model's warm time.
"""
from __future__ import annotations

import json
import random
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

WORKFLOWS = Path(r"C:\youtubestudio-live\src\lib\comfyui\workflows")
OUT_DIR = Path(r"C:\youtubestudio-live\hiccup-analysis\model-comparison")
OUT_DIR.mkdir(parents=True, exist_ok=True)
HOST = "http://127.0.0.1:8188"

# YouTube long-form composition canvas (Phase 0 — 1920×1080 default).
WIDTH = 1920
HEIGHT = 1080

PROMPTS = [
    ("person-explainer", "a young woman in a turtleneck explaining something to camera, neutral background, soft lighting, medium close-up"),
    ("cityscape",        "aerial wide shot of Tokyo at dusk, neon reflections on wet pavement, atmospheric"),
    ("object-concept",   "a vintage typewriter on a wooden desk surrounded by crumpled paper, dramatic side light, shallow depth of field"),
    ("in-image-text",    "a vintage poster that says BREAKING NEWS in bold block letters, mid-century print style, faded paper texture"),
]

MODELS = [
    # (label,        workflow file,           timeout_s)
    ("flux-schnell", "flux-schnell-t2i.json", 240),
    ("flux-dev",     "flux-dev-t2i.json",     420),
    ("qwen-image",   "qwen-image-t2i.json",   600),
]


def submit(workflow_file: str, prompt: str, client_id: str) -> str:
    text = (WORKFLOWS / workflow_file).read_text(encoding="utf-8")
    text = text.replace("<<PROMPT>>", prompt)
    text = text.replace("<<WIDTH>>", str(WIDTH))
    text = text.replace("<<HEIGHT>>", str(HEIGHT))
    text = text.replace("<<SEED>>", str(random.randint(0, 999999)))
    text = text.replace("<<STEPS>>", "20")  # ignored by workflows without the placeholder
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


def wait_for_completion(prompt_id: str, timeout_s: int) -> tuple[str, int, dict | None]:
    t0 = time.time()
    while True:
        elapsed = int(time.time() - t0)
        if elapsed > timeout_s:
            urllib.request.urlopen(urllib.request.Request(f"{HOST}/interrupt", method="POST"))
            return ("timeout", elapsed, None)
        try:
            with urllib.request.urlopen(f"{HOST}/history/{prompt_id}", timeout=10) as r:
                hist = json.loads(r.read())
            entry = hist.get(prompt_id)
            if entry and entry.get("status", {}).get("completed"):
                return (entry["status"].get("status_str", "unknown"), elapsed, entry)
        except Exception:
            pass
        time.sleep(3)


def fetch_first_image(entry: dict) -> tuple[bytes, str] | None:
    outputs = entry.get("outputs", {}) or {}
    for node_out in outputs.values():
        for img in node_out.get("images", []):
            url = f"{HOST}/view?filename={urllib.parse.quote(img['filename'])}&subfolder={urllib.parse.quote(img.get('subfolder', ''))}&type={urllib.parse.quote(img['type'])}"
            with urllib.request.urlopen(url, timeout=30) as r:
                return r.read(), img["filename"]
    return None


def main() -> int:
    import urllib.parse  # noqa: F401 — used inside fetch_first_image

    results: list[dict] = []
    print(f"=== Comparing local image models at {WIDTH}x{HEIGHT} ===", flush=True)
    print(f"Models: {[m[0] for m in MODELS]}", flush=True)
    print(f"Prompts: {len(PROMPTS)}", flush=True)
    print(f"Starting at {time.strftime('%H:%M:%S')}", flush=True)

    for model_label, workflow_file, timeout_s in MODELS:
        print(f"\n--- {model_label} ({workflow_file}) ---", flush=True)
        for slug, prompt in PROMPTS:
            t0 = time.time()
            client_id = f"compare-{model_label}-{slug}"
            print(f"  {slug:<18}", end="", flush=True)
            try:
                pid = submit(workflow_file, prompt, client_id)
            except Exception as e:
                print(f" SUBMIT_FAIL: {e}", flush=True)
                results.append({"model": model_label, "prompt": slug, "ok": False, "error": f"submit: {e}"})
                continue
            status, elapsed, entry = wait_for_completion(pid, timeout_s)
            ok = status == "success" and entry is not None
            if ok:
                fetched = fetch_first_image(entry)
                if fetched is None:
                    print(f" FAIL no output (status={status}, {elapsed}s)", flush=True)
                    results.append({"model": model_label, "prompt": slug, "ok": False, "error": "no_output", "elapsed": elapsed})
                    continue
                bytes_, src_filename = fetched
                out_path = OUT_DIR / f"{slug}__{model_label}.png"
                out_path.write_bytes(bytes_)
                print(f" OK {elapsed:>4}s -> {out_path.name}", flush=True)
                results.append({"model": model_label, "prompt": slug, "ok": True, "elapsed": elapsed, "out": str(out_path.name)})
            else:
                print(f" FAIL status={status} elapsed={elapsed}s", flush=True)
                results.append({"model": model_label, "prompt": slug, "ok": False, "error": status, "elapsed": elapsed})

    print("\n=== SUMMARY ===", flush=True)
    for r in results:
        marker = "OK  " if r.get("ok") else "FAIL"
        elapsed = r.get("elapsed", "?")
        extra = r.get("out") or r.get("error", "")
        print(f"  {marker} {r['model']:<14} {r['prompt']:<18} {elapsed}s  {extra}", flush=True)

    by_model: dict[str, list[int]] = {}
    for r in results:
        if r.get("ok") and isinstance(r.get("elapsed"), int):
            by_model.setdefault(r["model"], []).append(r["elapsed"])
    print("\nWarm-time estimate (mean of successful runs):", flush=True)
    for model_label, times in by_model.items():
        mean = sum(times) / len(times) if times else 0
        print(f"  {model_label:<14}  n={len(times)}  mean={mean:.1f}s  min={min(times)}s  max={max(times)}s", flush=True)

    all_ok = all(r.get("ok") for r in results)
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())
