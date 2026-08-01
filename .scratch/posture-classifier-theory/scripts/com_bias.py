"""
Model-based bias arithmetic for COCO-17 CoM estimation.
All lengths in units of stature H. Male de Leva (1996) Table 4 parameters.
NOT an empirical accuracy claim -- this is closed-form arithmetic on a rigid-link model.
"""
import numpy as np

H = 1741.0  # de Leva male mean stature, mm

# de Leva (1996) Table 4, MALES: relative mass (fraction of body mass)
m = dict(head=0.0694, trunk=0.4346, uarm=0.0271, farm=0.0162, hand=0.0061,
         thigh=0.1416, shank=0.0433, foot=0.0137)
# de Leva Table 4 MALES: CM position as fraction of segment length from proximal/cranial endpoint
c = dict(head=0.5002,      # VERT -> CERV
         trunk=0.4310,     # MIDS -> MIDH
         uarm=0.5772,      # SJC -> EJC
         farm=0.4574,      # EJC -> WJC
         hand=0.7900,      # WJC -> MET3
         thigh=0.4095,     # HJC -> KJC
         shank=0.4395,     # KJC -> AJC
         foot=0.4415)      # HEEL -> TTIP
# de Leva Table 4 MALES: segment lengths (mm) -> fractions of stature
L = {k: v / H for k, v in dict(head=242.9, trunk=515.5, uarm=281.7, farm=268.9,
                               hand=86.2, thigh=422.2, shank=440.3, foot=258.1).items()}

print("mass sum =", round(m['head'] + m['trunk'] + 2*(m['uarm']+m['farm']+m['hand'])
                          + 2*(m['thigh']+m['shank']+m['foot']), 6))

ANKLE_H = 0.039   # ankle joint height, fraction of stature (standard body proportions)
FOOT_CoM_DROP = 0.017   # foot CoM below ankle joint
FOOT_CoM_FWD = 0.045    # foot CoM forward of ankle joint
EAR_H = 0.936     # tragion height standing (Dempster: head+neck CoG level ~ supratragic notch)


def build(posture):
    """Return dict seg -> (x, y) of segment CoM, plus keypoint dict. y up, x forward."""
    kp = {}
    if posture == "standing":
        kp['ankle'] = np.array([0.0, ANKLE_H])
        kp['knee'] = kp['ankle'] + np.array([0.0, L['shank']])
        kp['hip'] = kp['knee'] + np.array([0.0, L['thigh']])
        kp['shoulder'] = kp['hip'] + np.array([0.0, L['trunk']])
        kp['elbow'] = kp['shoulder'] + np.array([0.0, -L['uarm']])
        kp['wrist'] = kp['elbow'] + np.array([0.0, -L['farm']])
        head_dir = np.array([0.0, 1.0])
        kp['ear'] = np.array([0.0, EAR_H])
        vertex = kp['hip'] + np.array([0.0, L['trunk'] + 0.0878 + L['head']])
    elif posture == "sitting":
        seat = 0.27
        kp['hip'] = np.array([0.0, seat])
        kp['knee'] = kp['hip'] + np.array([L['thigh'], 0.0])          # thigh horizontal forward
        kp['ankle'] = kp['knee'] + np.array([0.0, -L['shank']])       # shank vertical down
        kp['shoulder'] = kp['hip'] + np.array([0.0, L['trunk']])      # trunk vertical
        kp['elbow'] = kp['shoulder'] + np.array([0.0, -L['uarm']])
        kp['wrist'] = kp['elbow'] + np.array([0.0, -L['farm']])
        head_dir = np.array([0.0, 1.0])
        kp['ear'] = kp['shoulder'] + np.array([0.0, 0.0878 + L['head']*(1-0.5002) + 0.02])
        vertex = kp['shoulder'] + np.array([0.0, 0.0878 + L['head']])
    elif posture == "lying":
        # supine, long axis = +x, everything at ~0.05 H height
        base = 0.05
        kp['ear'] = np.array([EAR_H, base])
        kp['shoulder'] = np.array([0.8305, base])
        kp['hip'] = np.array([0.5344, base])
        kp['knee'] = np.array([0.5344 - L['thigh'], base])
        kp['ankle'] = np.array([0.5344 - L['thigh'] - L['shank'], base])
        kp['elbow'] = np.array([0.8305 - L['uarm'], base])
        kp['wrist'] = np.array([0.8305 - L['uarm'] - L['farm'], base])
        head_dir = np.array([1.0, 0.0])
        vertex = np.array([1.0204, base])
    elif posture == "bending":
        # standing, trunk flexed 90 deg at hip, arms hanging
        kp['ankle'] = np.array([0.0, ANKLE_H])
        kp['knee'] = kp['ankle'] + np.array([0.0, L['shank']])
        kp['hip'] = kp['knee'] + np.array([0.0, L['thigh']])
        kp['shoulder'] = kp['hip'] + np.array([L['trunk'], 0.0])      # trunk horizontal forward
        kp['elbow'] = kp['shoulder'] + np.array([0.0, -L['uarm']])
        kp['wrist'] = kp['elbow'] + np.array([0.0, -L['farm']])
        head_dir = np.array([1.0, 0.0])
        kp['ear'] = kp['shoulder'] + np.array([0.0878 + 0.05, 0.0])
        vertex = kp['shoulder'] + np.array([0.0878 + L['head'], 0.0])
    elif posture == "crouching":
        # deep squat: hips low, knees flexed, trunk leaning forward 45 deg
        kp['ankle'] = np.array([0.0, ANKLE_H])
        kp['knee'] = kp['ankle'] + np.array([L['shank']*0.6, L['shank']*0.8])
        kp['hip'] = kp['knee'] + np.array([-L['thigh']*0.85, L['thigh']*0.35])
        d = np.array([np.sin(np.pi/4), np.cos(np.pi/4)])
        kp['shoulder'] = kp['hip'] + d*L['trunk']
        kp['elbow'] = kp['shoulder'] + np.array([0.0, -L['uarm']])
        kp['wrist'] = kp['elbow'] + np.array([0.0, -L['farm']])
        head_dir = d
        kp['ear'] = kp['shoulder'] + d*(0.0878 + 0.05)
        vertex = kp['shoulder'] + d*(0.0878 + L['head'])
    else:
        raise ValueError(posture)

    seg = {}
    seg['trunk'] = kp['shoulder'] + c['trunk'] * (kp['hip'] - kp['shoulder'])
    seg['uarm'] = kp['shoulder'] + c['uarm'] * (kp['elbow'] - kp['shoulder'])
    seg['farm'] = kp['elbow'] + c['farm'] * (kp['wrist'] - kp['elbow'])
    seg['thigh'] = kp['hip'] + c['thigh'] * (kp['knee'] - kp['hip'])
    seg['shank'] = kp['knee'] + c['shank'] * (kp['ankle'] - kp['knee'])
    seg['head'] = vertex + c['head'] * (vertex - (vertex - head_dir*L['head'])) * -1 \
        if False else vertex - head_dir * (c['head'] * L['head'])
    # hand: distal to wrist along forearm direction
    fdir = kp['wrist'] - kp['elbow']
    fdir = fdir / np.linalg.norm(fdir)
    seg['hand'] = kp['wrist'] + fdir * (c['hand'] * L['hand'])
    # foot: offset from ankle (forward/down in standing frame; along -head_dir cross for lying)
    if posture == "lying":
        seg['foot'] = kp['ankle'] + np.array([-FOOT_CoM_FWD, FOOT_CoM_DROP])
    else:
        seg['foot'] = kp['ankle'] + np.array([FOOT_CoM_FWD, -FOOT_CoM_DROP])
    return kp, seg


PAIRED = {'uarm', 'farm', 'hand', 'thigh', 'shank', 'foot'}


def com(seg, subset, renorm=False, lump=None):
    tot = 0.0
    acc = np.zeros(2)
    for k in subset:
        w = m[k] * (2 if k in PAIRED else 1)
        acc += w * seg[k]
        tot += w
    if lump:
        for k, p in lump.items():
            w = m[k] * (2 if k in PAIRED else 1)
            acc += w * p
            tot += w
    return acc / tot if renorm else acc / tot, tot


ALL = list(m.keys())
KEPT = ['trunk', 'uarm', 'farm', 'thigh', 'shank']

rows = []
for posture in ["standing", "sitting", "lying", "bending", "crouching"]:
    kp, seg = build(posture)
    true_com, _ = com(seg, ALL)
    drop_com, wkept = com(seg, KEPT, renorm=True)
    lump_pts = {'head': kp['ear'], 'hand': kp['wrist'], 'foot': kp['ankle']}
    lump_com, _ = com(seg, KEPT, lump=lump_pts)
    hipmid = kp['hip']
    trunkmid = 0.5 * (kp['hip'] + kp['shoulder'])
    print(f"\n=== {posture} ===  (units = fraction of stature H; +x forward, +y up)")
    print(f"  retained mass fraction W_R = {wkept:.4f}   missing = {1-wkept:.4f}")
    print(f"  TRUE  CoM            = ({true_com[0]:+.4f}, {true_com[1]:+.4f})")
    for name, est in [("drop+renormalize", drop_com), ("lump-onto-keypoint", lump_com),
                      ("hip midpoint", hipmid), ("trunk midpoint", trunkmid)]:
        d = est - true_com
        print(f"  {name:20s} = ({est[0]:+.4f}, {est[1]:+.4f})  bias=({d[0]:+.4f},{d[1]:+.4f})"
              f"  |bias|={np.linalg.norm(d):.4f} H = {np.linalg.norm(d)*H:6.1f} mm")

# Dempster vs de Leva thigh weight sensitivity, standing + sitting
print("\n\n=== table-choice sensitivity: Dempster/Winter vs de Leva ===")
winter = dict(head=0.081, trunk=0.497, uarm=0.028, farm=0.016, hand=0.006,
              thigh=0.100, shank=0.0465, foot=0.0145)
print("Winter/Dempster sum =", round(winter['head']+winter['trunk']
      + 2*(winter['uarm']+winter['farm']+winter['hand'])
      + 2*(winter['thigh']+winter['shank']+winter['foot']), 4))
for posture in ["standing", "sitting"]:
    kp, seg = build(posture)
    a = sum((m[k]*(2 if k in PAIRED else 1))*seg[k] for k in ALL)
    b = sum((winter[k]*(2 if k in PAIRED else 1))*seg[k] for k in ALL)
    d = b - a
    print(f"  {posture}: deLeva=({a[0]:+.4f},{a[1]:+.4f})  Winter=({b[0]:+.4f},{b[1]:+.4f})"
          f"  diff=({d[0]:+.4f},{d[1]:+.4f}) = {np.linalg.norm(d)*H:.1f} mm")
