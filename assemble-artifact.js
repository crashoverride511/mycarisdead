const fs=require('fs');
const cards=fs.readFileSync('artifact-cards.html','utf8');
// The "updated" stamp is when the DATA was scraped (generatedAt in the results
// file), not when this page was assembled — rebuilding the page from an old
// results file used to stamp it "updated now" and pass stale prices off as fresh.
let dataTime=null;
try{ const g=JSON.parse(fs.readFileSync('weed-results-merged.json','utf8')).generatedAt; if(g&&!isNaN(Date.parse(g))) dataTime=new Date(g); }catch(_){}
const now=dataTime||new Date();
const mst=new Date(now.getTime()-7*3600*1000);
const stamp=mst.toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit',hour12:true,timeZone:'UTC'});
const esc=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
// Alert banner: shown whenever the cheapest qualifying pick beats $ALERT_OZ/oz.
const ALERT_OZ=Number(process.env.ALERT_MAX_PER_OZ||88);
let alertBanner='';
try{
  const merged=JSON.parse(fs.readFileSync('weed-results-merged.json','utf8')).results||[];
  if(merged.length){
    const best=merged.reduce((a,r)=>r.pricePerGram<a.pricePerGram?r:a);
    const bestOz=best.pricePerGram*28;
    if(bestOz<ALERT_OZ){
      alertBanner=`<a class="alert" href="${esc(best.url||'#')}" target="_blank" rel="noopener">🔥 <b>Deal under $${ALERT_OZ}/oz</b> — $${bestOz.toFixed(0)}/oz · ${best.thc}% · ${esc(best.name)} <span class="alert-disp">@ ${esc(best.dispensary.split('(')[0].trim())}</span> →</a>`;
    }
  }
}catch(_){}

// Store line + warning come from the run's per-store COVERAGE record (which
// stores were actually read), not from which stores happen to have a pick. A
// store that failed to load is named in a warning instead of silently looking
// like "nothing good there today". The note disappears on its own once every
// store reads again.
let jarsNote='', storeLine='<b>stores checked</b>';
try{
  const mj=JSON.parse(fs.readFileSync('weed-results-merged.json','utf8'));
  const cov=Array.isArray(mj.coverage)?mj.coverage:[];
  if(cov.length){
    const ok=cov.filter(c=>c.ok), bad=cov.filter(c=>!c.ok);
    storeLine=`<b>${ok.length} stores checked</b>`;
    if(bad.length){
      jarsNote=`<div style="display:flex;gap:9px;align-items:flex-start;background:color-mix(in srgb,var(--warn) 10%,var(--surface));border:1px solid color-mix(in srgb,var(--warn) 45%,var(--line));border-radius:12px;padding:10px 12px;margin:10px 0 2px;font-size:12px;color:var(--muted)"><span style="color:var(--warn);font-weight:800;font-size:15px;line-height:1.2">⚠</span><div><b style="color:var(--ink)">Not read this run:</b> ${bad.map(c=>esc(c.name)).join(', ')}. This board does not cover ${bad.length===1?'that store':'those stores'} today.</div></div>`;
    }
  }else{
    // older results file with no coverage record
    const disps=[...new Set((mj.results||[]).map(r=>r.dispensary))];
    storeLine=`<b>${disps.length} stores with picks</b>`;
  }
}catch(_){}

const head=`<title>Tucson Flower · Best $/g</title>
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<style>
:root{--bg:#f3f5ee;--surface:#fff;--surface2:#f7f9f2;--line:#e0e5d8;--ink:#1b2216;--muted:#5c6851;--faint:#8a9680;--accent:#2f8f4e;--accent-ink:#1f7a40;--gold:#b8892a;--teal:#2a9d8a;--amber:#d1701f;--warn:#b07a1e;--shadow:0 1px 2px rgba(30,40,20,.06),0 4px 16px rgba(30,40,20,.05)}
@media (prefers-color-scheme:dark){:root{--bg:#10140d;--surface:#191f13;--surface2:#20271a;--line:#2c3423;--ink:#e9efe1;--muted:#9aa88d;--faint:#6f7c63;--accent:#6bcb7b;--accent-ink:#7ed88c;--gold:#e4b24c;--teal:#5cc2b0;--amber:#ef9042;--warn:#e0a94b;--shadow:0 1px 2px rgba(0,0,0,.3),0 6px 20px rgba(0,0,0,.28)}}
:root[data-theme="light"]{--bg:#f3f5ee;--surface:#fff;--surface2:#f7f9f2;--line:#e0e5d8;--ink:#1b2216;--muted:#5c6851;--faint:#8a9680;--accent:#2f8f4e;--accent-ink:#1f7a40;--gold:#b8892a;--teal:#2a9d8a;--amber:#d1701f;--warn:#b07a1e;--shadow:0 1px 2px rgba(30,40,20,.06),0 4px 16px rgba(30,40,20,.05)}
:root[data-theme="dark"]{--bg:#10140d;--surface:#191f13;--surface2:#20271a;--line:#2c3423;--ink:#e9efe1;--muted:#9aa88d;--faint:#6f7c63;--accent:#6bcb7b;--accent-ink:#7ed88c;--gold:#e4b24c;--teal:#5cc2b0;--amber:#ef9042;--warn:#e0a94b;--shadow:0 1px 2px rgba(0,0,0,.3),0 6px 20px rgba(0,0,0,.28)}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,system-ui,sans-serif;-webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums;line-height:1.4}
.wrap{max-width:600px;margin:0 auto;padding:0 14px 40px;padding-bottom:calc(40px + env(safe-area-inset-bottom))}
header{position:sticky;top:0;z-index:5;background:linear-gradient(var(--bg) 80%,transparent);margin:0 -14px;padding:14px 14px 8px}
.h-top{display:flex;align-items:baseline;justify-content:space-between;gap:10px}
h1{font-size:20px;font-weight:800;letter-spacing:-.02em;margin:0}
h1 small{display:block;font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--faint);margin-top:3px}
.gen{font-size:11px;color:var(--faint);text-align:right;line-height:1.35}
.criteria{font-size:12px;color:var(--muted);margin:9px 0 10px}
.criteria b{color:var(--ink);font-weight:700}
.controls{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.chipbtn{appearance:none;border:1px solid var(--line);background:var(--surface);color:var(--muted);font:inherit;font-size:12.5px;font-weight:600;padding:6px 11px;border-radius:999px;cursor:pointer;-webkit-tap-highlight-color:transparent;transition:background .12s,color .12s,border-color .12s}
.chipbtn[aria-pressed="true"]{background:var(--accent);color:#08120a;border-color:var(--accent)}
.sort{margin-left:auto}
.alert{display:block;text-decoration:none;background:linear-gradient(180deg,#e8452f,#cc3a26);color:#fff;border-radius:12px;padding:11px 13px;margin:10px 0 2px;font-size:13px;font-weight:600;line-height:1.35;box-shadow:0 2px 10px rgba(204,58,38,.35)}
.stale{background:color-mix(in srgb,var(--warn) 14%,var(--surface));border:1px solid color-mix(in srgb,var(--warn) 55%,var(--line));color:var(--ink);border-radius:12px;padding:10px 12px;margin:10px 0 2px;font-size:12.5px;font-weight:600;line-height:1.4}
.alert b{font-weight:800}
.alert .alert-disp{opacity:.9;font-weight:600}
.alert:active{filter:brightness(.95)}
.count{font-size:12px;color:var(--faint);padding:10px 2px 8px;font-weight:600}
.list{display:flex;flex-direction:column;gap:9px}
.card{display:grid;grid-template-columns:30px 1fr auto;gap:11px;align-items:stretch;background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:12px 13px;box-shadow:var(--shadow)}
.card.is-deal88{border-color:color-mix(in srgb,var(--amber) 55%,var(--line));background:linear-gradient(180deg,color-mix(in srgb,var(--amber) 9%,var(--surface)),var(--surface))}
.rank{display:flex;flex-direction:column;align-items:center;gap:3px;padding-top:1px}
.mk{font-size:15px;line-height:1;height:16px}
.mk.sativa{color:var(--gold)}.mk.inf{color:var(--teal)}
.rank .num{font-size:12px;font-weight:700;color:var(--faint)}
.body{min-width:0;display:flex;flex-direction:column;gap:5px;justify-content:center}
.prod{font-size:14.5px;font-weight:700;letter-spacing:-.01em;line-height:1.25;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.line2{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px}
.thc{font-weight:800;color:var(--accent-ink)}
.lin{color:var(--muted);font-weight:600}
.lin small{color:var(--faint);font-weight:500;margin-left:4px;font-size:11px}
.lin.sativa{color:var(--gold)}
.disp{color:var(--faint);margin-left:auto;font-size:11.5px;text-align:right}
.chips{display:flex;gap:5px;flex-wrap:wrap;margin-top:1px}
.chip{font-size:11px;font-weight:700;padding:2.5px 7px;border-radius:6px;white-space:nowrap}
.chip.deal{background:color-mix(in srgb,var(--accent) 15%,transparent);color:var(--accent-ink)}
.chip.bogo{background:color-mix(in srgb,var(--gold) 20%,transparent);color:var(--gold)}
.chip.warn{background:color-mix(in srgb,var(--warn) 16%,transparent);color:var(--warn)}
.chip.qty{background:var(--surface2);color:var(--muted);font-weight:600}
.chip.form{background:color-mix(in srgb,var(--teal) 16%,transparent);color:var(--teal)}
.chip.via{background:transparent;color:var(--faint);font-weight:500;padding-left:0;white-space:normal}
.price{display:flex;flex-direction:column;align-items:flex-end;justify-content:center;gap:1px;text-align:right}
.ppg{font-size:22px;font-weight:800;letter-spacing:-.03em;line-height:1;white-space:nowrap}
.ppg .cur{font-size:14px;font-weight:700;vertical-align:top;margin-right:-1px}
.ppg .per{font-size:12px;font-weight:600;color:var(--faint)}
.oz{font-size:11.5px;color:var(--faint);font-weight:600;margin-top:2px}
.go{margin-top:5px;font-size:11.5px;font-weight:700;color:var(--accent-ink);text-decoration:none;border:1px solid color-mix(in srgb,var(--accent) 40%,var(--line));padding:3px 9px;border-radius:7px}
.go:active{background:color-mix(in srgb,var(--accent) 12%,transparent)}
.note{font-size:11.5px;color:var(--faint);margin-top:18px;line-height:1.55}
.note b{color:var(--muted)}
.legend{display:flex;gap:14px;flex-wrap:wrap;font-size:11.5px;color:var(--muted);margin-top:12px}
.legend b{font-weight:800}
.empty{text-align:center;color:var(--faint);padding:30px;font-size:13px}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:8px}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
</style>`;

const body=`<div class="wrap">
<header>
  <div class="h-top"><h1>Tucson Flower<small>best value · $ / gram</small></h1><span class="gen">updated<br>${stamp} MST</span></div>
  <p class="criteria">Sativa &amp; sativa-leaning · THC <b>&ge;27%</b> · ranked by what you actually pay. ${storeLine}.</p>
  <div class="controls">
    <button class="chipbtn" data-filter="all" aria-pressed="true">All</button>
    <button class="chipbtn" data-filter="pure">★ Pure sativa</button>
    <button class="chipbtn" data-filter="under6">&le; $6/g</button>
    <button class="chipbtn" data-filter="deal">On deal</button>
    <button class="chipbtn" data-filter="buds">Buds only</button>
    <button class="chipbtn sort" data-sort="ppg" aria-pressed="true">Sort: $/g</button>
  </div>
  <div class="stale" id="stale" hidden></div>
  ${alertBanner}
  ${jarsNote}
</header>
<div class="count" id="count"></div>
<div class="list" id="list">
${cards}
</div>
<div class="empty" id="empty" hidden>Nothing matches that filter.</div>
<div class="legend"><span><b style="color:var(--gold)">★</b> menu pure sativa</span><span><b style="color:var(--teal)">≈</b> lineage inferred</span></div>
<p class="note"><b>Reading it:</b> $/g is the single-unit price you pay (sale &divide; grams); $/oz is the 28g equivalent so sizes compare fairly. One card per product, at its best-value size — other sizes are listed on the card. ✓ = sale price and struck price both come from the store's own menu data. A gold "2 for $X" chip is a multi-buy offer: cheaper per gram if you buy that many, but it does not move the ranking. "Buds only" hides shake, pre-ground and infused. Snapshot from the update time — reconfirm in-store.</p>
</div>
<script>
(function(){
  var list=document.getElementById('list'),cards=[].slice.call(list.children);
  var count=document.getElementById('count'),empty=document.getElementById('empty');
  var filter='all',sort='ppg';
  function apply(){
    var vis=cards.filter(function(c){
      if(filter==='pure')return c.dataset.pure==='1';
      if(filter==='under6')return parseFloat(c.dataset.ppg)<=6;
      if(filter==='deal')return c.dataset.deal==='1';
      if(filter==='buds')return c.dataset.buds==='1';
      return true;
    });
    vis.sort(function(a,b){
      if(sort==='thc')return parseFloat(b.dataset.thc)-parseFloat(a.dataset.thc);
      return parseFloat(a.dataset.ppg)-parseFloat(b.dataset.ppg);
    });
    cards.forEach(function(c){c.style.display='none';});
    vis.forEach(function(c){c.style.display='';list.appendChild(c);});
    count.textContent=vis.length+' of '+cards.length+' picks · '+(sort==='thc'?'highest THC first':'cheapest first');
    empty.hidden=vis.length>0;
  }
  document.querySelectorAll('[data-filter]').forEach(function(b){b.addEventListener('click',function(){document.querySelectorAll('[data-filter]').forEach(function(x){x.setAttribute('aria-pressed','false');});b.setAttribute('aria-pressed','true');filter=b.dataset.filter;apply();});});
  // Staleness check runs in the viewer's browser, every time the page is opened:
  // if the daily refresh stops landing, the page says so itself instead of
  // quietly showing old prices under an old date.
  var scraped=${now.getTime()},ageH=(Date.now()-scraped)/36e5,st=document.getElementById('stale');
  if(ageH>26){var d=Math.floor(ageH/24);st.textContent='⚠ These prices are '+(d>=2?d+' days':Math.round(ageH)+' hours')+' old — the daily refresh has not run. Menus and deals have likely changed.';st.hidden=false;}
  var sb=document.querySelector('[data-sort]');
  sb.addEventListener('click',function(){sort=sort==='ppg'?'thc':'ppg';sb.textContent='Sort: '+(sort==='ppg'?'$/g':'THC');apply();});
  apply();
})();
</script>`;

fs.writeFileSync('tucson-flower.html',head+'\n'+body);
console.log('wrote tucson-flower.html, stamp:',stamp,'| cards bytes:',cards.length);
