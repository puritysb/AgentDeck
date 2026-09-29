"""Reproduce the local TripoSR study; output is NOT a runtime character.

Use the isolated TripoSR Python environment described in docs/hermes-agent.md.
Model input normalization is the upstream pipeline's standard preprocessing.
"""
import argparse
import gc
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import time

UPSTREAM = "107cefdc244c39106fa830359024f6a2f1c78871"
MODEL = "5b521936b01fbe1890f6f9baed0254ab6351c04a"
ROOT = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--source", type=Path, required=True, help="Pinned TripoSR checkout")
parser.add_argument("--input", type=Path, default=ROOT / "assets/terrarium/references/hermes-mermaid-reconstruction-v5.png")
parser.add_argument("--output", type=Path, default=ROOT / "diagnostics/hermes-mermaid/reconstruction")
parser.add_argument("--device", choices=("mps", "cpu"), default="mps")
parser.add_argument("--resolution", type=int, choices=(128, 192, 256), default=256)
args = parser.parse_args()
revision = subprocess.check_output(["git", "-C", str(args.source), "rev-parse", "HEAD"], text=True).strip()
if revision != UPSTREAM:
    parser.error(f"Expected TripoSR {UPSTREAM}, got {revision}")
if subprocess.check_output(["git", "-C", str(args.source), "diff", "HEAD", "--", "tsr"], text=True):
    parser.error("The upstream tsr package has local changes")
args.output.mkdir(parents=True, exist_ok=True)
if (args.output / "candidate.glb").exists():
    parser.error("Choose a new output directory to retain the previous experiment")
sys.path.insert(0, str(args.source.resolve()))

import numpy as np
from PIL import Image
import torch
from huggingface_hub import hf_hub_download
from torchmcubes import marching_cubes
import tsr.models.isosurface as iso
from tsr.system import TSR
from tsr.utils import resize_foreground

torch.set_num_threads(4)
torch.manual_seed(0)
if args.device == "mps" and not torch.backends.mps.is_available():
    parser.error("MPS is unavailable; choose --device cpu")
# The marching-cubes extension supports CPU/CUDA, not MPS. Neural inference
# stays on MPS; only the isosurface extraction crosses to the CPU.
iso.marching_cubes = lambda level, threshold: marching_cubes(level.cpu(), threshold)
start = time.monotonic()
config = hf_hub_download("stabilityai/TripoSR", "config.yaml", revision=MODEL)
hf_hub_download("stabilityai/TripoSR", "model.ckpt", revision=MODEL)
model = TSR.from_pretrained(str(Path(config).parent), config_name="config.yaml", weight_name="model.ckpt").eval().to(args.device)
model.renderer.set_chunk_size(8192)
rgba = Image.open(args.input)
if rgba.mode != "RGBA" or rgba.getchannel("A").getextrema()[0] != 0:
    parser.error("Input must be an RGBA character cutout with transparent background")
a = np.asarray(resize_foreground(rgba, .85), dtype=np.float32) / 255
input_rgb = a[:, :, :3] * a[:, :, 3:4] + (1 - a[:, :, 3:4]) * .5
print("Inferring geometry", flush=True)
with torch.inference_mode():
    codes = model([input_rgb], device=args.device)
for attr in ("backbone", "image_tokenizer", "tokenizer", "post_processor"):
    delattr(model, attr)
gc.collect()
if args.device == "mps":
    torch.mps.empty_cache()
print("Extracting mesh", flush=True)
with torch.inference_mode():
    mesh = model.extract_mesh(codes, True, resolution=args.resolution)[0]
mesh.export(args.output / "candidate.glb")
metadata = {
    "status": "UNREVIEWED", "method": "TripoSR", "source_revision": revision,
    "model_revision": MODEL, "input_sha256": hashlib.sha256(args.input.read_bytes()).hexdigest(),
    "vertices": len(mesh.vertices), "faces": len(mesh.faces),
    "watertight": bool(mesh.is_watertight), "device": args.device,
    "seconds": round(time.monotonic() - start, 2), "resolution": args.resolution,
    "rigged": False, "facial_blendshapes": False,
    "coordinate_system": "TripoSR x-back, y-right, z-up; not normalized for runtime glTF",
}
(args.output / "generation.json").write_text(json.dumps(metadata, indent=2) + "\n")
print(json.dumps(metadata), flush=True)
