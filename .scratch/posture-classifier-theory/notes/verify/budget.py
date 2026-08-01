import numpy as np
d=np.rad2deg
# segment fractions of stature H (Drillis&Contini via Winter Fig 4.1) -- prior only
LAM = dict(trunk=0.288, shoulder_w=0.259, hip_w=0.191, thigh=0.245, shank=0.246,
           upperarm=0.186, forearm=0.146, head_neck=0.182)

def seg_sd(sig_over_H, lam):
    return d(sig_over_H*np.sqrt(2)/lam)

def joint_sd(sig_over_H, lu, lw, th):
    c=np.cos(np.deg2rad(th))
    return d(sig_over_H*np.sqrt(2/lu**2+2/lw**2-2*c/(lu*lw)))

sigs=[0.005,0.010,0.020,0.030]
print("## A. 2-point segment orientation SD (deg), as function of sigma_p/H")
print("| quantity | lambda(L/H) | " + " | ".join(f"s/H={s}" for s in sigs) + " |")
print("|---|---|"+ "---|"*len(sigs))
for k in ["trunk","shoulder_w","hip_w","thigh","shank","upperarm","forearm","head_neck"]:
    print(f"| {k} | {LAM[k]:.3f} | " + " | ".join(f"{seg_sd(s,LAM[k]):.1f}" for s in sigs) + " |")

print()
print("## B. 3-point joint angle SD (deg)")
combos=[("knee (hip-knee-ankle) ext 170", "thigh","shank",170),
        ("knee flexed 90","thigh","shank",90),
        ("hip (trunk-hip-knee) ext 175","trunk","thigh",175),
        ("hip flexed 90","trunk","thigh",90),
        ("elbow ext 170","upperarm","forearm",170),
        ("elbow flexed 90","upperarm","forearm",90)]
print("| joint | Lu/H | Lw/H | "+" | ".join(f"s/H={s}" for s in sigs)+" |")
print("|---|---|---|"+"---|"*len(sigs))
for name,a,b,th in combos:
    print(f"| {name} | {LAM[a]:.3f} | {LAM[b]:.3f} | " + " | ".join(f"{joint_sd(s,LAM[a],LAM[b],th):.1f}" for s in sigs)+" |")

print()
print("## C. minimum usable scale: person height H_norm (fraction of frame height) required")
print("assume sigma_p = c_rel * H_person  -> angle SD independent of H  (relative-noise regime)")
print("assume sigma_p = sigma_abs (absolute floor, normalized img units) -> SD ~ 1/H")
print()
print("| sigma_abs | target SD | trunk tilt: min H | knee angle(170): min H |")
print("|---|---|---|---|")
for sa in [0.002,0.004,0.008]:
    for tgt in [5.0,10.0,15.0]:
        # trunk: SD = deg(sa*sqrt2/(0.288*H)) = tgt -> H = deg(sa*sqrt2/0.288)/tgt
        Ht = d(sa*np.sqrt(2)/LAM["trunk"])/tgt
        c=np.cos(np.deg2rad(170))
        Hk = d(sa*np.sqrt(2/LAM["thigh"]**2+2/LAM["shank"]**2-2*c/(LAM["thigh"]*LAM["shank"])))/tgt
        print(f"| {sa} | {tgt:.0f} deg | {Ht:.2f} | {Hk:.2f} |")

print()
print("## D. velocity noise budget, 30 FPS")
print("| estimator | noise gain g (per frame) | sigma_v/(sigma_p*fs) | sigma_v [H/s] @ sigma_p=0.02H | window (frames/s) | one-sided latency |")
print("|---|---|---|---|---|---|")
from scipy.signal import savgol_coeffs
fs=30.0
rows=[("forward diff", np.array([1.0,-1.0]),2),
      ("central diff", np.array([0.5,0,-0.5]),3)]
for w,p in [(5,2),(7,2),(9,2),(11,2),(15,2),(9,3),(15,3)]:
    rows.append((f"Sav-Golay w={w} p={p}", savgol_coeffs(w,p,deriv=1,delta=1.0), w))
for name,c,w in rows:
    g=np.linalg.norm(c)
    sv=g*fs*0.02
    lat=(w-1)/2/fs
    print(f"| {name} | {g:.4f} | {g:.4f} | {sv:.3f} | {w} / {w/fs:.2f}s | {lat*1000:.0f} ms |")

print()
print("## E. SNR check for a fall-like descent")
print("reference: trunk mid-hip descends ~0.5 H in 0.5 s -> 1.0 H/s peak vertical speed")
for sp in [0.01,0.02,0.03]:
    for name,g in [("central diff",1/np.sqrt(2)),("SG w=9 p=2",0.1291),("SG w=15 p=2",0.0598)]:
        sv=g*fs*sp
        print(f"  sigma_p={sp}H  {name:14s}  sigma_v={sv:.3f} H/s   SNR(1.0 H/s)={1.0/sv:5.2f}")

print()
print("## F. acceleration noise (2nd central diff), 30 FPS")
for sp in [0.01,0.02,0.03]:
    sa_=np.sqrt(6)*fs*fs*sp
    print(f"  sigma_p={sp}H -> sigma_a={sa_:.1f} H/s^2  (gravity 9.81 m/s2 on H=1.7m body = {9.81/1.7:.2f} H/s^2)")

print()
print("## G. COCO OKS sigma -> relative per-keypoint weights (normalised to nose)")
coco={"nose":.026,"eye":.025,"ear":.035,"shoulder":.079,"elbow":.072,"wrist":.062,"hip":.107,"knee":.087,"ankle":.089}
for k,v in coco.items():
    print(f"  {k:9s} sigma={v:.3f}  w_i=sigma/sigma_nose={v/0.026:.2f}  2*sigma*s (RMS 2D at OKS=0.61) ")
print()
print("## H. what OKS=0.5 means in distance: d = s*k*sqrt(2*ln2), k=2*sigma")
for k,v in coco.items():
    kk=2*v
    print(f"  {k:9s}: d(OKS=0.5) = {kk*np.sqrt(2*np.log(2)):.3f} * s ;  d(OKS=0.9)={kk*np.sqrt(2*np.log(1/0.9)):.3f} * s")
