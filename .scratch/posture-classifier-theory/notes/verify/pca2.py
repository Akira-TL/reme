import numpy as np
rng=np.random.default_rng(3); N=200000
def circ_sd(a):
    a=np.angle(np.exp(1j*(a-np.angle(np.mean(np.exp(1j*a))))));return a.std()
def axis_sd(a):            # a is mod-pi (axis) angle
    return circ_sd(2*a)/2
def mc_axis(ys,sig,w=None):
    P=len(ys); base=np.stack([np.zeros(P),np.array(ys)],1)
    pts=base[None]+rng.normal(0,sig,(N,P,2))
    w=np.ones(P) if w is None else np.asarray(w,float)
    w=w/w.sum()
    c=(pts*w[None,:,None]).sum(1,keepdims=True); d=pts-c; dw=d*np.sqrt(w)[None,:,None]
    cxx=(dw[:,:,0]**2).sum(1); cyy=(dw[:,:,1]**2).sum(1); cxy=(dw[:,:,0]*dw[:,:,1]).sum(1)
    return axis_sd(0.5*np.arctan2(2*cxy,cxx-cyy))
D=np.rad2deg
print("uniform P points over L=1H, sigma_p=0.01H ; pred = sigma*sqrt(12/P)/L")
for P in [4,6,8,10,13,17]:
    ys=np.linspace(0,1,P); sig=0.01
    print(f"  P={P:2d}  pred={D(sig*np.sqrt(12/P)):6.3f}  MC={D(mc_axis(ys,sig)):6.3f}")
print("\ngeneral pred = sigma / sqrt(sum (y_k - ybar)^2)")
core=[0.936,0.818,0.818,0.530,0.530,0.285,0.285,0.039,0.039]
sig=0.01; ys=np.array(core); Sxx=((ys-ys.mean())**2).sum()
print(f"  COCO core 9 pts (standing): Sxx={Sxx:.4f}  pred={D(sig/np.sqrt(Sxx)):.3f} deg  MC={D(mc_axis(core,sig)):.3f} deg")
core5=[0.818,0.818,0.530,0.530,0.936]
ys=np.array(core5);Sxx=((ys-ys.mean())**2).sum()
print(f"  head+shoulders+hips only : Sxx={Sxx:.4f}  pred={D(sig/np.sqrt(Sxx)):.3f}  MC={D(mc_axis(core5,sig)):.3f}")
sh_hip=[0.818,0.818,0.530,0.530]
ys=np.array(sh_hip);Sxx=((ys-ys.mean())**2).sum()
print(f"  shoulders+hips (4 pts)   : Sxx={Sxx:.4f}  pred={D(sig/np.sqrt(Sxx)):.3f}  MC={D(mc_axis(sh_hip,sig)):.3f}")
print(f"\n  2-pt trunk L=0.288H : {D(sig*np.sqrt(2)/0.288):.3f} deg")
print(f"  2-pt midsh->midankle L=0.779H : {D(sig*np.sqrt(2)/0.779):.3f} deg")
print("\nsensitivity: same but sigma scaled per keypoint using COCO relative sigmas (nose .026 ... ankle .089), sigma_ref=0.01H at hip(.107)")
