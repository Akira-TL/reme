import numpy as np
rng = np.random.default_rng(1); N=400000

def circ_sd(a):
    a = np.angle(np.exp(1j*(a - np.angle(np.mean(np.exp(1j*a))))))
    return a.std()

def mc_joint(Lu,Lw,th_deg,sig):
    th=np.deg2rad(th_deg); B0=np.zeros(2)
    A0=np.array([Lu,0.0]); C0=np.array([Lw*np.cos(th),Lw*np.sin(th)])
    A=A0+rng.normal(0,sig,(N,2)); B=B0+rng.normal(0,sig,(N,2)); C=C0+rng.normal(0,sig,(N,2))
    u=A-B; w=C-B
    ang=np.arctan2(u[:,0]*w[:,1]-u[:,1]*w[:,0], u[:,0]*w[:,0]+u[:,1]*w[:,1])
    return circ_sd(ang)

print("Lu     Lw     theta  sigma   sigma/Lmin  pred(deg)  MC(deg)  ratio")
cases=[(0.20,0.20,180,0.01),(0.20,0.20,150,0.01),(0.20,0.20,90,0.01),(0.20,0.20,30,0.01),
       (0.25,0.20,150,0.008),(0.10,0.08,120,0.01),(0.05,0.05,170,0.01),(0.05,0.05,120,0.005),
       (0.30,0.30,175,0.005),(0.12,0.12,160,0.006),(0.06,0.06,90,0.004)]
for Lu,Lw,th,sig in cases:
    c=np.cos(np.deg2rad(th))
    pred=np.rad2deg(sig*np.sqrt(2/Lu**2+2/Lw**2-2*c/(Lu*Lw)))
    got=np.rad2deg(mc_joint(Lu,Lw,th,sig))
    print(f"{Lu:.3f} {Lw:.3f} {th:5d} {sig:.4f}  {sig/min(Lu,Lw):8.3f}  {pred:8.2f} {got:8.2f}  {got/pred:5.3f}")

print("\n--- validity of linearization: ratio MC/pred vs sigma/L (Lu=Lw=L, theta=170) ---")
for L in [0.40,0.30,0.20,0.15,0.10,0.08,0.06,0.05,0.04,0.03]:
    sig=0.01; c=np.cos(np.deg2rad(170))
    pred=np.rad2deg(sig*np.sqrt(4/L**2-2*c/L**2)); got=np.rad2deg(mc_joint(L,L,170,sig))
    print(f"  L={L:.3f} sigma/L={sig/L:6.3f}  pred={pred:7.2f}  MC={got:7.2f}  ratio={got/pred:5.3f}")

print("\n--- segment orientation, circular SD ---")
def mc_seg(L,sig):
    A=rng.normal(0,sig,(N,2)); B=np.array([L,0.0])+rng.normal(0,sig,(N,2)); v=B-A
    return circ_sd(np.arctan2(v[:,1],v[:,0]))
for L in [0.40,0.30,0.20,0.15,0.10,0.05]:
    sig=0.01
    print(f"  L={L:.3f}  pred={np.rad2deg(sig*np.sqrt(2)/L):7.2f}  MC={np.rad2deg(mc_seg(L,sig)):7.2f}")

print("\n--- midpoint averaging: does using (Lhip+Rhip)/2 halve variance? ---")
for rho in [0.0,0.3,0.6,0.9]:
    sig=0.01
    cov=np.array([[1,rho],[rho,1]])*sig**2
    z=rng.multivariate_normal([0,0],cov,N)
    m=z.mean(axis=1)
    print(f"  rho={rho:.1f}  SD(mid)={m.std():.5f}  vs sig/sqrt(2)={sig/np.sqrt(2):.5f}  vs sig={sig:.5f}")
