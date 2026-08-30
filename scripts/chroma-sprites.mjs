import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// Use sharp if present; otherwise fall back to a python one-shot.
const ROOT = "/workspace";
const OUT = path.join(ROOT, "public/sprites");

const singles = {
  "units/leaf.png": "befa1aff-48d2-4a55-b509-44ac2ec78e83.jpg",
  "units/sand.png": "533bbf35-a5a1-4672-8993-fcbec72b25ce.jpg",
  "units/mist.png": "04619eee-7a6d-4d2b-a858-39fc0a2e3264.jpg",
  "units/cloud.png": "71039708-9920-4716-9bf8-026b161ff1bc.jpg",
  "units/stone.png": "4a8bec76-d21b-45d1-83c2-38faa64fad56.jpg",
  "units/missing.png": "0f3afd51-b1b0-44e7-8236-04a028a60053.jpg",
  "commanders/leaf.png": "e77f8568-7af1-4dd2-b5e3-86f55c572845.jpg",
  "commanders/sand.png": "5d0d4869-c025-4837-a277-6c0dfdb45a36.jpg",
  "commanders/mist.png": "31a9e1e4-e61c-497a-8880-36b55226d803.jpg",
  "commanders/cloud.png": "3dcba63a-7eee-434c-bebe-1df63dc2c1ff.jpg",
  "commanders/stone.png": "8b2f2eba-e9ac-49ab-a880-7fdcfb93defd.jpg",
  "bases/leaf.png": "d7623d44-7208-4457-9e02-d17f40a7e242.jpg",
  "bases/sand.png": "563075eb-73cc-4f5d-9567-99692683bea4.jpg",
  "bases/mist.png": "29a2e9f9-9c8b-4d26-b351-7e56f6f8571f.jpg",
  "bases/cloud.png": "2fc730ca-ae87-4d51-b989-9bff3982827a.jpg",
  "bases/stone.png": "a8856022-479f-4586-9d08-074125ba1842.jpg",
  "bases/settlement.png": "15d88c90-9ac4-4a04-a47e-cbafdfa6e513.jpg",
};

console.log("write py");
fs.writeFileSync(
  "/tmp/chroma.py",
  `
from pathlib import Path
import numpy as np
from PIL import Image

SRC = Path("/workspace/artifacts/imagine_images")
OUT = Path("/workspace/public/sprites")

def chroma(im: Image.Image) -> Image.Image:
    arr = np.array(im.convert("RGBA"))
    r = arr[:,:,0].astype(np.int16)
    g = arr[:,:,1].astype(np.int16)
    b = arr[:,:,2].astype(np.int16)
    # magenta key with JPEG slop
    mag = (r > 170) & (b > 170) & (g < 140) & (np.abs(r - b) < 90)
    near = (r > 140) & (b > 140) & (g < 170) & (np.abs(r - b) < 110)
    arr[mag, 3] = 0
    fade = near & (~mag)
    # soften fringe
    arr[:,:,3] = np.where(fade, np.minimum(arr[:,:,3], 40), arr[:,:,3])
    # kill leftover pink fringe
    pink = (r > 160) & (b > 120) & (g < 160) & (arr[:,:,3] > 0) & (r - g > 40)
    arr[pink, 3] = np.minimum(arr[pink, 3], 80)
    alpha = arr[:,:,3]
    ys, xs = np.where(alpha > 24)
    if len(xs) == 0:
        return Image.fromarray(arr)
    pad = 8
    x0, x1 = max(0, xs.min()-pad), min(arr.shape[1], xs.max()+pad+1)
    y0, y1 = max(0, ys.min()-pad), min(arr.shape[0], ys.max()+pad+1)
    cropped = arr[y0:y1, x0:x1]
    return Image.fromarray(cropped)

def save(name, src_name):
    im = Image.open(SRC / src_name)
    out = chroma(im)
    dest = OUT / name
    dest.parent.mkdir(parents=True, exist_ok=True)
    out.save(dest)
    print(name, out.size)

singles = ${JSON.stringify(singles)}
for name, src in singles.items():
    save(name, src)

# buildings 2x3
b = chroma(Image.open(SRC / "5ef9715b-c00f-4947-973d-182f4a92eb59.jpg"))
bw, bh = b.size
cw, ch = bw // 3, bh // 2
labels = ["academy","market","wall","temple","hospital","tower"]
arr = np.array(b)
for i, lab in enumerate(labels):
    col, row = i % 3, i // 3
    cell = Image.fromarray(arr[row*ch:(row+1)*ch, col*cw:(col+1)*cw])
    cell2 = chroma(cell)
    dest = OUT / f"buildings/{lab}.png"
    dest.parent.mkdir(parents=True, exist_ok=True)
    cell2.save(dest)
    print("building", lab, cell2.size)

# icons 2x2
ic = chroma(Image.open(SRC / "daa8d875-d1c8-4add-84db-a27459572695.jpg"))
iw, ih = ic.size
cw, ch = iw // 2, ih // 2
ilabs = ["genin","chunin","cavalry","siege"]
arr = np.array(ic)
for i, lab in enumerate(ilabs):
    col, row = i % 2, i // 2
    cell = Image.fromarray(arr[row*ch:(row+1)*ch, col*cw:(col+1)*cw])
    cell2 = chroma(cell)
    dest = OUT / f"icons/{lab}.png"
    dest.parent.mkdir(parents=True, exist_ok=True)
    cell2.save(dest)
    print("icon", lab, cell2.size)
`,
);

import { spawnSync } from "node:child_process";
const r = spawnSync("python3", ["/tmp/chroma.py"], { stdio: "inherit" });
process.exit(r.status ?? 1);
