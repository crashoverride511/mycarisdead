import sys, json
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.boundsPen import BoundsPen
import uharfbuzz as hb

src = sys.argv[1]
f = TTFont(src)
print('axes', [(a.axisTag, a.minValue, a.defaultValue, a.maxValue) for a in f['fvar'].axes])
inst = instancer.instantiateVariableFont(f, {"wght": 400, "opsz": 96})
inst.flavor = None
inst.save(sys.argv[2])
upm = inst['head'].unitsPerEm
hhea = inst['hhea']; os2 = inst['OS/2']
print('upm', upm, 'hhea asc/desc', hhea.ascent, hhea.descent, 'typo', os2.sTypoAscender, os2.sTypoDescender, 'win', os2.usWinAscent, os2.usWinDescent, 'xh', getattr(os2,'sxHeight',None))

blob = hb.Blob.from_file_path(sys.argv[2])
face = hb.Face(blob); font = hb.Font(face)
buf = hb.Buffer(); buf.add_str("pay."); buf.guess_segment_properties()
hb.shape(font, buf, {"kern": True, "liga": True})
gs = inst.getGlyphSet(); order = inst.getGlyphOrder()
x = 0; out = []
for info, pos in zip(buf.glyph_infos, buf.glyph_positions):
    name = order[info.codepoint]
    bp = BoundsPen(gs); gs[name].draw(bp)
    pen = SVGPathPen(gs)
    tp = TransformPen(pen, (1, 0, 0, -1, x + pos.x_offset, 0))  # y down, baseline at 0
    gs[name].draw(tp)
    out.append({"name": name, "x": x + pos.x_offset, "adv": pos.x_advance, "bounds": bp.bounds, "d": pen.getCommands()})
    x += pos.x_advance
print('total advance', x)
for g in out: print(g['name'], 'x', g['x'], 'adv', g['adv'], 'bounds', g['bounds'])
json.dump({"upm": upm, "glyphs": out, "advance": x}, open(sys.argv[3], 'w'))
