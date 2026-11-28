import json, math, sys

data = json.load(open(sys.argv[1] if len(sys.argv) > 1 else 'pay.json'))
glyph_d = ' '.join(g['d'] for g in data['glyphs'])

def norm(v):
    l = math.hypot(*v); return (v[0] / l, v[1] / l)

def f(v): return f"{v:.1f}".rstrip('0').rstrip('.')

def drip(PL, dL, PR, dR, cx, w0, y_neck, close, w1, y_w, R, y_b):
    """Neck piece leaves the letter along its own edge and pinches to half-width w0 at y_neck.
    Fall piece: tapered stem (w0 -> w1 at y_w), then a teardrop widest (R) at y_b."""
    (xl, yl), (xr, yr) = PL, PR
    dL, dR = norm(dL), norm(dR)
    a1 = 0.5 * abs((cx - w0) - xl) + 6; b1 = 0.55 * (y_neck - yl)
    a2 = 0.5 * abs(xr - (cx + w0)) + 6; b2 = 0.55 * (y_neck - yr)
    p1 = (xl + dL[0] * a1, yl + dL[1] * a1); p2 = (cx - w0, y_neck - b1)
    q1 = (cx + w0, y_neck - b2); q2 = (xr - dR[0] * a2, yr - dR[1] * a2)
    neck = (f"M{f(xl)} {f(yl)}C{f(p1[0])} {f(p1[1])} {f(p2[0])} {f(p2[1])} {f(cx-w0)} {f(y_neck)}"
            f"A{f(w0)} {f(w0)} 0 0 0 {f(cx+w0)} {f(y_neck)}"
            f"C{f(q1[0])} {f(q1[1])} {f(q2[0])} {f(q2[1])} {f(xr)} {f(yr)}")
    for (x, y) in close: neck += f"L{f(x)} {f(y)}"
    neck += "Z"
    top = y_neck - 6; seg = y_w - top; y_end = y_b + R * 1.08
    fall = (f"M{f(cx-w0)} {f(top)}"
            f"C{f(cx-w0)} {f(top+seg*.5)} {f(cx-w1)} {f(y_w-seg*.3)} {f(cx-w1)} {f(y_w)}"
            f"C{f(cx-w1)} {f(y_w+(y_b-y_w)*.5)} {f(cx-R)} {f(y_b-R*.62)} {f(cx-R)} {f(y_b)}"
            f"C{f(cx-R)} {f(y_b+R*.78)} {f(cx-R*.56)} {f(y_end)} {f(cx)} {f(y_end)}"
            f"C{f(cx+R*.56)} {f(y_end)} {f(cx+R)} {f(y_b+R*.78)} {f(cx+R)} {f(y_b)}"
            f"C{f(cx+R)} {f(y_b-R*.62)} {f(cx+w1)} {f(y_w+(y_b-y_w)*.5)} {f(cx+w1)} {f(y_w)}"
            f"C{f(cx+w1)} {f(y_w-seg*.3)} {f(cx+w0)} {f(top+seg*.5)} {f(cx+w0)} {f(top)}Z")
    streak = f"M{f(cx-w0*.42)} {f(y_neck+14)}C{f(cx-w0*.4)} {f(y_neck+seg*.45)} {f(cx-w1*.45)} {f(y_w-seg*.2)} {f(cx-w1*.5)} {f(y_w)}"
    shine = (cx - R * .4, y_b - R * .1, R * .18, R * .32)
    return neck, fall, shine, streak

# a: hangs from the lowest point of the stem foot (measured contour)
a_neck, a_fall, a_hl, a_st = drip(PL=(1790, 11.2), dL=(1, .3), PR=(1900, 14), dR=(1, -.22),
                            cx=1846, w0=40, y_neck=84, close=[(1900, 12), (1846, 10), (1790, 8.5)], w1=30, y_w=470, R=50, y_b=560)
# period: forms out of the bottom of the dot, leaving the circle on its own tangent
C, r, th = (3241.5, -100.5), 120.5, math.radians(40)
PL = (C[0] - r * math.sin(th), C[1] + r * math.cos(th)); PR = (C[0] + r * math.sin(th), C[1] + r * math.cos(th))
p_neck, p_fall, p_hl, p_st = drip(PL=PL, dL=(math.cos(th), math.sin(th)), PR=PR, dR=(math.cos(th), -math.sin(th)),
                            cx=C[0], w0=32, y_neck=86, close=[(PR[0] - 8, -32), (C[0], -70), (PL[0] + 8, -32)], w1=25, y_w=212, R=40, y_b=272)

VX, VY, VW, VH = -220, -1000, 3640, 1660
# one vertical gradient for the letters, a second for the drips that matches it exactly down to the baseline, then turns to blood
y1, y2 = -960, 620
def off(y): return f"{(y - y1) / (y2 - y1):.4f}"
glyph_stops = [(-960, '#ff3d93'), (-770, '#ff2d8a'), (-690, '#a8005c'), (-600, '#ff2d8a'), (-200, '#ff4f9f'), (0, '#ff6db0'), (300, '#ff9ccb'), (620, '#ffc4df')]
drip_stops = [(-960, '#ff3d93'), (-770, '#ff2d8a'), (-690, '#a8005c'), (-600, '#ff2d8a'), (-200, '#ff4f9f'), (0, '#ff6db0'), (60, '#ee3d78'), (150, '#c8143f'), (300, '#9e0b1f'), (620, '#5e000b')]
def grad(id_, stops):
    s = ''.join(f'<stop offset="{off(y)}" stop-color="{c}"/>' for y, c in stops)
    return f'<linearGradient id="{id_}" gradientUnits="userSpaceOnUse" x1="0" y1="{y1}" x2="0" y2="{y2}">{s}</linearGradient>'

def st(d): return f'<path d="{d}" fill="none" stroke="#fff" stroke-opacity=".22" stroke-width="7" stroke-linecap="round"/>'
def hl(e): return f'<ellipse cx="{f(e[0])}" cy="{f(e[1])}" rx="{f(e[2])}" ry="{f(e[3])}" fill="#fff" opacity=".5"/>'

svg = (f'<svg class="pay-svg" viewBox="{VX} {VY} {VW} {VH}" aria-hidden="true" focusable="false">'
       f'<defs>{grad("payG", glyph_stops)}{grad("payD", drip_stops)}'
       f'<linearGradient id="payS" x1="0" y1="0" x2="1" y2="0"><stop offset=".38" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity=".7"/><stop offset=".62" stop-color="#fff" stop-opacity="0"/></linearGradient>'
       f'<mask id="payM" maskUnits="userSpaceOnUse" x="{VX}" y="{VY}" width="{VW}" height="{VH}"><path fill="#fff" d="{glyph_d}"/></mask></defs>'
       f'<g fill="url(#payD)"><path d="{a_neck}"/><path d="{p_neck}"/>'
       f'<g class="fall f1"><path d="{a_fall}"/>{st(a_st)}{hl(a_hl)}</g>'
       f'<g class="fall f2"><path d="{p_fall}"/>{st(p_st)}{hl(p_hl)}</g></g>'
       f'<path fill="url(#payG)" d="{glyph_d}"/>'
       f'<g mask="url(#payM)"><rect class="pay-shine" x="{VX - 2600}" y="{VY}" width="2600" height="{VH}" fill="url(#payS)"/></g>'
       f'</svg>')
open(sys.argv[2] if len(sys.argv) > 2 else 'pay.svg.html', 'w').write(svg)
print(len(svg), 'bytes')
