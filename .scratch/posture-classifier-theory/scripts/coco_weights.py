"""Collapse the segment model into per-COCO-keypoint linear weights a_j, so that
   CoM_proxy = sum_j a_j * p_j   (p_j = (x_norm, y_norm) of COCO keypoint j)."""
import numpy as np
from collections import defaultdict

KP = ["nose","left_eye","right_eye","left_ear","right_ear","left_shoulder","right_shoulder",
      "left_elbow","right_elbow","left_wrist","right_wrist","left_hip","right_hip",
      "left_knee","right_knee","left_ankle","right_ankle"]

def build(mass, cm, head_anchor="ears"):
    a = defaultdict(float)
    for side in ("left","right"):
        S, E, W = f"{side}_shoulder", f"{side}_elbow", f"{side}_wrist"
        Hp, K, A = f"{side}_hip", f"{side}_knee", f"{side}_ankle"
        # head -> split over both ears (each side contributes half of half)
        a[f"{side}_ear"] += mass["head"]/2.0
        # trunk: MIDS -> MIDH, mass counted once, split half per side of each midpoint
        a[S] += mass["trunk"] * (1-cm["trunk"]) / 2.0
        a[Hp] += mass["trunk"] * cm["trunk"] / 2.0
        # upper arm (one per side)
        a[S] += mass["uarm"] * (1-cm["uarm"]); a[E] += mass["uarm"] * cm["uarm"]
        # forearm
        a[E] += mass["farm"] * (1-cm["farm"]); a[W] += mass["farm"] * cm["farm"]
        # hand lumped at wrist
        a[W] += mass["hand"]
        # thigh
        a[Hp] += mass["thigh"] * (1-cm["thigh"]); a[K] += mass["thigh"] * cm["thigh"]
        # shank
        a[K] += mass["shank"] * (1-cm["shank"]); a[A] += mass["shank"] * cm["shank"]
        # foot lumped at ankle
        a[A] += mass["foot"]
    return a

MALE = (dict(head=0.0694, trunk=0.4346, uarm=0.0271, farm=0.0162, hand=0.0061,
             thigh=0.1416, shank=0.0433, foot=0.0137),
        dict(trunk=0.4310, uarm=0.5772, farm=0.4574, thigh=0.4095, shank=0.4395))
FEMALE = (dict(head=0.0668, trunk=0.4257, uarm=0.0255, farm=0.0138, hand=0.0056,
               thigh=0.1478, shank=0.0481, foot=0.0129),
          dict(trunk=0.3782, uarm=0.5754, farm=0.4559, thigh=0.3612, shank=0.4352))
# Winter/Dempster variant (trunk = greater trochanter -> glenohumeral, CoM 0.50 proximal)
WINTER = (dict(head=0.081, trunk=0.497, uarm=0.028, farm=0.016, hand=0.006,
               thigh=0.100, shank=0.0465, foot=0.0145),
          dict(trunk=0.50, uarm=0.436, farm=0.430, thigh=0.433, shank=0.433))

for name, (mass, cm) in [("de Leva MALE", MALE), ("de Leva FEMALE", FEMALE),
                         ("Winter/Dempster", WINTER)]:
    a = build(mass, cm)
    tot = sum(a.values())
    print(f"\n=== {name} ===  sum a_j = {tot:.6f}")
    for k in KP:
        if a[k] > 0:
            print(f"  {k:16s} {a[k]:.6f}")
    v = np.array([a[k] for k in KP])
    print(f"  noise gain sqrt(sum a^2) = {np.sqrt((v**2).sum()):.4f}"
          f"   (hip-midpoint-only estimator = {np.sqrt(2*0.25):.4f})")
    # unisex average of the two de Leva sexes handled below

ma, ca = MALE; mf, cf = FEMALE
uni_m = {k: (ma[k]+mf[k])/2 for k in ma}
uni_c = {k: (ca[k]+cf[k])/2 for k in ca}
a = build(uni_m, uni_c); tot = sum(a.values())
print(f"\n=== de Leva SEX-AVERAGED (recommended default) ===  sum a_j = {tot:.6f}")
for k in KP:
    if a[k] > 0:
        print(f"  {k:16s} {a[k]:.6f}   (rounded 4dp: {round(a[k],4)})")
v = np.array([a[k] for k in KP])
print(f"  noise gain sqrt(sum a^2) = {np.sqrt((v**2).sum()):.4f}")
print("  mass coverage if BOTH hips missing:", round(1-2*a['left_hip'],4))
print("  mass coverage if BOTH shoulders missing:", round(1-2*a['left_shoulder'],4))
print("  mass coverage if BOTH ears missing:", round(1-2*a['left_ear'],4))
print("  mass coverage if one whole leg missing (hip+knee+ankle):",
      round(1-(a['left_hip']+a['left_knee']+a['left_ankle']),4))
