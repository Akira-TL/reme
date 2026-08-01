import numpy as np
rng = np.random.default_rng(0)
N = 400000

def mc_segment_angle(L, sig):
    """Orientation angle of a 2-point segment; A at origin, B at (L,0)."""
    A = np.zeros((N,2)) + rng.normal(0, sig, (N,2))
    B = np.array([L,0.0]) + rng.normal(0, sig, (N,2))
    v = B - A
    th = np.arctan2(v[:,1], v[:,0])
    return th.std()

def mc_joint_angle(Lu, Lw, theta_deg, sig):
    """Interior angle at vertex B between BA and BC."""
    th = np.deg2rad(theta_deg)
    B0 = np.zeros(2)
    A0 = np.array([Lu, 0.0])                                  # u = A-B along +x
    C0 = np.array([Lw*np.cos(th), Lw*np.sin(th)])             # w = C-B at angle theta
    A = A0 + rng.normal(0, sig, (N,2))
    B = B0 + rng.normal(0, sig, (N,2))
    C = C0 + rng.normal(0, sig, (N,2))
    u = A-B; w = C-B
    ang = np.arctan2(u[:,0]*w[:,1]-u[:,1]*w[:,0], u[:,0]*w[:,0]+u[:,1]*w[:,1])
    return ang.std()

print("=== segment orientation:  predicted sig*sqrt(2)/L ===")
for L,sig in [(0.30,0.01),(0.15,0.01),(0.08,0.005),(0.05,0.01)]:
    pred = np.rad2deg(sig*np.sqrt(2)/L)
    got  = np.rad2deg(mc_segment_angle(L,sig))
    print(f"  L={L:.3f} sig={sig:.4f}  pred={pred:6.2f} deg   MC={got:6.2f} deg")

print("=== 3-point joint angle: predicted sig*sqrt(2/Lu^2+2/Lw^2-2cos(th)/(Lu*Lw)) ===")
for Lu,Lw,th,sig in [(0.20,0.20,180,0.01),(0.20,0.20,90,0.01),(0.20,0.20,30,0.01),
                     (0.25,0.20,150,0.008),(0.10,0.08,120,0.01),(0.05,0.05,170,0.01)]:
    c = np.cos(np.deg2rad(th))
    pred = np.rad2deg(sig*np.sqrt(2/Lu**2 + 2/Lw**2 - 2*c/(Lu*Lw)))
    got  = np.rad2deg(mc_joint_angle(Lu,Lw,th,sig))
    print(f"  Lu={Lu:.2f} Lw={Lw:.2f} th={th:3d} sig={sig:.4f}  pred={pred:6.2f}  MC={got:6.2f}")

print("=== finite-difference derivative noise gain (white noise, sigma=1, dt=1) ===")
x = rng.normal(0,1,(N,))
fwd = np.diff(x)                       # (x[n]-x[n-1])/dt
cen = (x[2:]-x[:-2])/2.0               # central
acc = x[2:]-2*x[1:-1]+x[:-2]           # 2nd central
print(f"  forward diff : MC={fwd.std():.4f}  pred=sqrt(2)={np.sqrt(2):.4f}")
print(f"  central diff : MC={cen.std():.4f}  pred=1/sqrt(2)={1/np.sqrt(2):.4f}")
print(f"  2nd central  : MC={acc.std():.4f}  pred=sqrt(6)={np.sqrt(6):.4f}")

print("=== Savitzky-Golay velocity gain (deriv=1, dt=1 frame), noise SD out for unit white in ===")
from scipy.signal import savgol_coeffs
for w in [5,7,9,11,15,21]:
    for p in [2,3]:
        if p >= w: continue
        c = savgol_coeffs(w, p, deriv=1, delta=1.0)
        print(f"  win={w:2d} poly={p}  gain={np.linalg.norm(c):.4f}  (vs central-diff {1/np.sqrt(2):.4f})")

print("=== moving-average then central diff, gain ===")
for w in [3,5,7,9,15]:
    h = np.ones(w)/w
    # combined kernel: central diff of MA
    g = np.convolve(h, np.array([0.5,0,-0.5]))
    print(f"  MA win={w:2d} + central diff : gain={np.linalg.norm(g):.4f}")
