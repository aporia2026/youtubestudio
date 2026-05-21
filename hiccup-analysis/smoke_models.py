"""Sequential smoke test of all working local ComfyUI models.

Run after restarting ComfyUI with --disable-smart-memory --cache-classic
to verify model-swap thrashing is fixed and each model still completes.
"""
import json
import random
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

WORKFLOWS = Path(r"C:\youtubestudio-live\src\lib\comfyui\workflows")
HOST = "http://127.0.0.1:8188"
PROMPT_TEXT = "a red fox running through a snowy forest, cinematic lighting"


def submit_workflow(workflow_file: str, replacements: dict, client_id: str) -> str:
    text = (WORKFLOWS / workflow_file).read_text(encoding="utf-8")
    for placeholder, value in replacements.items():
        text = text.replace(f"<<{placeholder}>>", str(value))
    if "<<" in text:
        missing = [chunk.split(">>")[0] for chunk in text.split("<<")[1:]]
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
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = json.loads(resp.read())
            return body["prompt_id"]
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"submit HTTP {e.code}: {e.read().decode('utf-8', 'ignore')[:500]}")


def wait_for(prompt_id: str, timeout_s: int) -> tuple[str, int]:
    t0 = time.time()
    last_node = ""
    while True:
        elapsed = int(time.time() - t0)
        if elapsed > timeout_s:
            urllib.request.urlopen(urllib.request.Request(f"{HOST}/interrupt", method="POST"))
            return ("timeout", elapsed)
        try:
            with urllib.request.urlopen(f"{HOST}/history/{prompt_id}", timeout=10) as resp:
                hist = json.loads(resp.read())
            entry = hist.get(prompt_id)
            if entry and entry.get("status", {}).get("completed"):
                return (entry["status"].get("status_str", "unknown"), elapsed)
        except Exception:
            pass
        try:
            with urllib.request.urlopen(f"{HOST}/queue", timeout=10) as resp:
                q = json.loads(resp.read())
            running = q.get("queue_running", [])
            if running and isinstance(running[0], list) and len(running[0]) >= 4:
                node = running[0][3].get("node", "")
                if node and node != last_node:
                    last_node = node
                    print(f"    ... node={node} elapsed={elapsed}s", flush=True)
        except Exception:
            pass
        time.sleep(3)


def run_model(label: str, workflow_file: str, replacements: dict, timeout_s: int) -> dict:
    print(f"\n--- {label} ---", flush=True)
    print(f"  workflow={workflow_file} timeout={timeout_s}s", flush=True)
    replacements = {**replacements, "SEED": random.randint(0, 999999)}
    try:
        prompt_id = submit_workflow(workflow_file, replacements, f"smoke-{label}")
        print(f"  submitted prompt_id={prompt_id}", flush=True)
    except Exception as e:
        print(f"  SUBMIT_FAIL: {e}", flush=True)
        return {"label": label, "ok": False, "error": f"submit: {e}", "elapsed": 0}
    status, elapsed = wait_for(prompt_id, timeout_s)
    ok = status == "success"
    marker = "OK" if ok else "FAIL"
    print(f"  {marker} {label}: {elapsed}s status={status}", flush=True)
    return {"label": label, "ok": ok, "status": status, "elapsed": elapsed}


def main():
    tests = [
        ("flux-schnell", "flux-schnell-t2i.json",
         {"PROMPT": PROMPT_TEXT, "WIDTH": 1024, "HEIGHT": 576, "STEPS": 4}, 300),
        ("flux-dev",     "flux-dev-t2i.json",
         {"PROMPT": PROMPT_TEXT, "WIDTH": 1024, "HEIGHT": 576, "STEPS": 20}, 600),
        ("wan-2.2-i2v",  "wan-2.2-i2v.json",
         {"PROMPT": PROMPT_TEXT, "WIDTH": 704, "HEIGHT": 416,
          "LENGTH": 33, "STEPS": 20, "REF_IMAGE": "sample_fox.jpg"}, 900),
        ("hunyuan-i2v",  "hunyuan-i2v.json",
         {"PROMPT": PROMPT_TEXT, "WIDTH": 480, "HEIGHT": 272,
          "LENGTH": 33, "STEPS": 20, "REF_IMAGE": "sample_fox.jpg"}, 1200),
    ]

    print(f"=== Smoke test started at {time.strftime('%H:%M:%S')} ===", flush=True)
    results = []
    for label, wf, repl, timeout in tests:
        results.append(run_model(label, wf, repl, timeout))

    print("\n=== SUMMARY ===", flush=True)
    all_ok = True
    for r in results:
        mark = "OK" if r["ok"] else "FAIL"
        print(f"  {mark}  {r['label']:<15} {r.get('elapsed', '?')}s  {r.get('status', r.get('error', ''))}", flush=True)
        all_ok = all_ok and r["ok"]
    print(f"\n=== Finished at {time.strftime('%H:%M:%S')} — all_ok={all_ok} ===", flush=True)
    sys.exit(0 if all_ok else 1)


if __name__ == "__main__":
    main()
