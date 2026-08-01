import numpy as np
rng = np.random.default_rng(0)

# mass weights (de Leva male, 8 lumped groups incl. paired doubling)
w = np.array([0.0694, 0.4346, 2*0.0271, 2*0.0162, 2*0.0061,
              2*0.1416, 2*0.0433, 2*0.0137])
w = w / w.sum()

def err_for(D, depth_spread, lateral_spread, n=20000):
    """max/rms discrepancy between projection-of-centroid and centroid-of-projections,
    expressed as a fraction of the body's projected lateral extent."""
    out = []
    for _ in range(n):
        X = rng.uniform(-lateral_spread/2, lateral_spread/2, size=8)
        Zd = rng.uniform(-depth_spread/2, depth_spread/2, size=8)
        Z = D + Zd
        f = 1.0
        proj_of_centroid = f * (w @ X) / (w @ Z)
        centroid_of_proj = w @ (f * X / Z)
        extent = f * (X.max() - X.min()) / D
        out.append(abs(proj_of_centroid - centroid_of_proj) / extent)
    out = np.array(out)
    return out.mean(), np.percentile(out, 95), out.max()

for D in [2.0, 3.0, 5.0, 8.0]:
    m_, p95, mx = err_for(D, depth_spread=0.6, lateral_spread=0.6)
    print(f"D={D:>4.1f} m  depth spread 0.6 m, lateral 0.6 m -> "
          f"err/projected-extent: mean {m_*100:5.2f}%  p95 {p95*100:5.2f}%  max {mx*100:5.2f}%")
print()
for ds in [0.2, 0.4, 0.6, 1.0]:
    m_, p95, mx = err_for(3.0, depth_spread=ds, lateral_spread=0.6)
    print(f"D=3.0 m depth spread {ds:.1f} m -> mean {m_*100:5.2f}%  p95 {p95*100:5.2f}%  max {mx*100:5.2f}%")
