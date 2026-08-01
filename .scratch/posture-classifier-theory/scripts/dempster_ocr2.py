import sys, os, subprocess
from pypdf import PdfReader

pdf = sys.argv[1]
outdir = sys.argv[2]
pages = [int(x) for x in sys.argv[3].split(",")]
os.makedirs(outdir, exist_ok=True)
r = PdfReader(pdf)
for pn in pages:
    p = r.pages[pn-1]
    imgs = list(p.images)
    print(f"--- page {pn}: {len(imgs)} images", flush=True)
    for k, im in enumerate(imgs):
        ext = os.path.splitext(im.name)[1] or ".png"
        fp = os.path.join(outdir, f"q{pn:03d}_{k}{ext}")
        with open(fp, "wb") as f:
            f.write(im.data)
        base = os.path.join(outdir, f"q{pn:03d}_{k}")
        subprocess.run(["tesseract", fp, base, "-l", "eng", "--psm", "6"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        sz = os.path.getsize(fp)
        os.remove(fp)
        print(f"   img{k} {len(im.data)}B", flush=True)
