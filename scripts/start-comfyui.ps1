# Launch ComfyUI for YouTube Studio local-broll generation.
#
# Flags chosen specifically for this workload (multi-model swap between
# Flux schnell, Flux dev, Wan 2.2 I2V, HunyuanVideo I2V on 16GB VRAM):
#
#   --fast                       fp16 accumulation (RTX 40+/50-series safe).
#   --fp8_e4m3fn-text-enc        keep CLIP text encoders in fp8 to free VRAM
#                                for the UNet/diffusion model.
#   --enable-cors-header *       allow our Next.js app at localhost:3000 to
#                                hit /prompt /history /view from the browser.
#   --disable-smart-memory       force eviction of previous model from VRAM
#                                before loading the next. Without this the
#                                Wan model lingered as "10131 MB remains
#                                loaded" and Flux schnell would thrash for
#                                3+ minutes on the swap.
#   --cache-classic              don't keep extra activations cached between
#                                runs; same reasoning as above.
#
# Workspace tip: run this in its own PowerShell window. Closing the window
# stops ComfyUI cleanly. Logs stream to stdout for live debugging.

$ErrorActionPreference = "Stop"

$ComfyDir = "D:\AI\ComfyUI"
if (-not (Test-Path $ComfyDir)) {
    Write-Error "ComfyUI portable not found at $ComfyDir. Update the path in this script."
    exit 1
}

Set-Location $ComfyDir
& ".\python_embeded\python.exe" -s "ComfyUI\main.py" `
    --windows-standalone-build `
    --fast fp16_accumulation `
    --fp8_e4m3fn-text-enc `
    --enable-cors-header "*" `
    --disable-smart-memory `
    --cache-classic
