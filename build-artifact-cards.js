// Build the phone page's cards from weed-results-merged.json.
// One card per PRODUCT per store: a product sold in several weights used to get
// a card for each weight (one deli-weight strain = five near-identical cards).
// The card shows its best $/g size; the other sizes ride along in a chip.
const fs=require('fs');
const d=JSON.parse(fs.readFileSync('weed-results-merged.json','utf8'));
const esc=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const money=n=>Number.isInteger(n)?n:Number(n).toFixed(2);

// What kind of "flower" this is, read off the product name / menu subcategory.
// Shake, pre-ground and infused all sit in the flower category but are not
// whole buds — say so on the card, and let the page filter them out.
function formOf(r){
  const t=`${r.name||''} ${r.subcategory||''}`;
  if(/\bshake\b|\btrim\b/i.test(t)) return 'shake';
  if(/pre-?ground|\bground\b/i.test(t)) return /infused/i.test(t)?'infused ground':'pre-ground';
  if(/infused|supercharged|snow\s?caps?|moon\s?rocks?|\bcharged\b/i.test(t)) return 'infused';
  if(/\bsmalls?\b|\bminis?\b|popcorn|\blittles\b/i.test(t)) return 'smalls';
  return '';
}

// group rows -> products (results are already ranked best $/g first, so the
// first row seen for a product is its best size)
const groups=[]; const byKey=new Map();
for(const r of d.results){
  const key=`${r.dispensaryId||r.dispensary}|${r.url||r.name}`;
  let g=byKey.get(key);
  if(!g){ g={best:r,others:[]}; byKey.set(key,g); groups.push(g); }
  else g.others.push(r);
}

function card(g,rank){
  const r=g.best;
  const pure = r.strainBucket==='sativa' && !r.inferred;
  const mk = pure?'<span class="mk sativa">★</span>':(r.inferred?'<span class="mk inf">≈</span>':'<span class="mk"></span>');
  const linClass = pure?'sativa':'';
  const ozEq = Math.round(r.pricePerGram*28);
  const hot = r.pricePerGram*28 < 88; // under $88/oz — the deal-alert threshold
  const form=formOf(r);
  const chips=[];
  // name the store special behind a discount, so it can be recognised on the menu
  const via = (r.specials||[]).find(s=>!r.bundle || s!==r.bundle.special);
  if(r.dealClaimed && r.dealReal) chips.push(`<span class="chip deal">✓ ${r.discountPct}% off · was $${money(r.original)}</span>`);
  else if(r.dealClaimed && !r.dealReal) chips.push(`<span class="chip warn">⚠ unverified</span>`);
  chips.push(`<span class="chip qty">${esc(r.weightLabel)} · $${money(r.charged)}</span>`);
  if(form) chips.push(`<span class="chip form">${form}</span>`);
  // Multi-buy special the store advertises (e.g. "2 for $70"): shown, not ranked —
  // the card's $/g is always the single-unit price.
  if(r.bundle && r.bundle.pricePerGram) chips.push(`<span class="chip bogo">${esc(r.bundle.label)} → $${r.bundle.pricePerGram.toFixed(2)}/g</span>`);
  if(r.stock!=null && r.stock>0 && r.stock<=5) chips.push(`<span class="chip warn">only ${r.stock} left</span>`);
  if(r.thcNote) chips.push(`<span class="chip warn" title="${esc(r.thcNote)}">⚠ THC unit</span>`);
  if(g.others.length) chips.push(`<span class="chip qty">also ${g.others.map(o=>`${esc(o.weightLabel)} $${o.pricePerGram.toFixed(2)}/g`).join(' · ')}</span>`);
  if(via && r.dealReal) chips.push(`<span class="chip via">${esc(String(via).slice(0,48))}</span>`);
  let small='';
  // a name-dictionary match is already spelled out in the label ("Sativa-lean ≈trop cherry");
  // only a Leafly match needs the matched strain shown beside it
  if(r.inferred && /^leafly:/.test(r.inferredFrom||'')) small=`<small>${esc(String(r.inferredFrom).replace(/^leafly:/,''))}</small>`;
  const buds = form===''||form==='smalls';
  return `<article class="card${hot?' is-deal88':''}" data-ppg="${r.pricePerGram.toFixed(2)}" data-thc="${r.thc}" data-pure="${pure?1:0}" data-deal="${(r.dealClaimed&&r.dealReal)?1:0}" data-buds="${buds?1:0}">
  <div class="rank">${mk}<span class="num">${rank}</span></div>
  <div class="body">
    <div class="prod">${esc(r.name)}</div>
    <div class="line2"><span class="thc">${r.thc}%</span><span class="lin ${linClass}">${esc(r.strainLabel)}${small}</span><span class="disp">${esc(r.dispensary)}</span></div>
    <div class="chips">${chips.join('')}</div>
  </div>
  <div class="price"><div class="ppg"><span class="cur">$</span>${r.pricePerGram.toFixed(2)}<span class="per">/g</span></div><div class="oz">$${ozEq}/oz</div>${r.url?`<a class="go" href="${esc(r.url)}" target="_blank" rel="noopener">open ↗</a>`:''}</div>
</article>`;
}
const cards=groups.map((g,i)=>card(g,i+1)).join('\n');
fs.writeFileSync('artifact-cards.html',cards);
const disp=new Set(d.results.map(r=>r.dispensary));
console.log('wrote',groups.length,'cards from',d.results.length,'priced options |',disp.size,'dispensaries with a qualifier');
