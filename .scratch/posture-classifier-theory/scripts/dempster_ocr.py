import sys, os, subprocess
from pypdf import PdfReader

pdf = sys.argv[1]
outdir = sys.argv[2]
start = int(sys.argv[3]); end = int(sys.argv[4])
os.makedirs(outdir, exist_ok=True)
r = PdfReader(pdf)
print("pages", len(r.pages), flush=True)
for i in range(start-1, min(end, len(r.pages))):
    p = r.pages[i]
    try:
        imgs = list(p.images)
    except Exception as e:
        print(i+1, "ERR", e, flush=True); continue
    if not imgs:
        print(i+1, "noimg", flush=True); continue
    im = max(imgs, key=lambda x: len(x.data))
    ext = os.path.splitext(im.name)[1] or ".png"
    fp = os.path.join(outdir, f"p{i+1:03d}{ext}")
    with open(fp, "wb") as f:
        f.write(im.data)
    txtbase = os.path.join(outdir, f"p{i+1:03d}")
    subprocess.run(["tesseract", fp, txtbase, "-l", "eng", "--psm", "6"],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    os.remove(fp)
    print(i+1, "ok", flush=True)
