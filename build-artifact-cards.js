const fs=require('fs');
const d=JSON.parse(fs.readFileSync('weed-results-merged.json','utf8'));
const esc=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const money=n=>Number.isInteger(n)?n:Number(n).toFixed(2);
function card(r,rank){
  const pure = r.strainBucket==='sativa' && !r.inferred;
  const mk = pure?'<span class="mk sativa">★</span>':'<span class="mk inf">≈</span>';
  const linClass = pure?'sativa':'';
  const ozEq = Math.round(r.pricePerGram*28);
  const hot = r.pricePerGram*28 < 88; // under $88/oz — the deal-alert threshold
  const chips=[];
  if(r.dealClaimed && r.dealReal) chips.push(`<span class="chip deal">✓ ${r.discountPct}% off</span>`);
  else if(r.dealClaimed && !r.dealReal) chips.push(`<span class="chip warn">⚠ unverified</span>`);
  chips.push(`<span class="chip qty">${esc(r.weightLabel)} · $${money(r.charged)}</span>`);
  let small='';
  if(r.inferred) small=`<small>${esc(String(r.inferredFrom||'inferred').replace(/^name:/,'≈ ').replace(/^leafly:/,'≈ '))}</small>`;
  return `<article class="card${hot?' is-deal88':''}" data-ppg="${r.pricePerGram.toFixed(2)}" data-thc="${r.thc}" data-pure="${pure?1:0}" data-deal="${(r.dealClaimed&&r.dealReal)?1:0}">
  <div class="rank">${mk}<span class="num">${rank}</span></div>
  <div class="body">
    <div class="prod">${esc(r.name)}</div>
    <div class="line2"><span class="thc">${r.thc}%</span><span class="lin ${linClass}">${esc(r.strainLabel)}${small}</span><span class="disp">${esc(r.dispensary)}</span></div>
    <div class="chips">${chips.join('')}</div>
  </div>
  <div class="price"><div class="ppg"><span class="cur">$</span>${r.pricePerGram.toFixed(2)}<span class="per">/g</span></div><div class="oz">$${ozEq}/oz</div><a class="go" href="${esc(r.url)}" target="_blank" rel="noopener">open ↗</a></div>
</article>`;
}
const cards=d.results.map((r,i)=>card(r,i+1)).join('\n');
fs.writeFileSync('artifact-cards.html',cards);
// distinct dispensaries
const disp=new Set(d.results.map(r=>r.dispensary));
console.log('wrote',d.results.length,'cards |',disp.size,'dispensaries with a qualifier');
