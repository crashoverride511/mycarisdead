// Merge JARS (East Tucson + Green Valley) flower into the Dutchie scrape,
// filter to sativa/sativa-lean >=27%, rank. Writes weed-results-merged.json.
const fs=require('fs');
const m=require('./weed-value-finder.js');
(async()=>{
  const base=JSON.parse(fs.readFileSync('weed-results.json','utf8'));
  const opts=base.opts;
  const stores=[
    ['jars-east-tucson-lists.json','JARS - East Tucson'],
    ['jars-green-valley-lists.json','JARS - Green Valley'],
  ];
  let allJarsKept=[];
  for(const [file,label] of stores){
    let d; try{ d=JSON.parse(fs.readFileSync(file,'utf8')); }catch(_){ continue; }
    const nameFromUrl=(u)=>{ const s=(u||'').split('/product/')[1]||''; return s.replace(/-/g,' ').replace(/\b\w/g,c=>c.toUpperCase()).replace(/\b(\d)\b (\d)\b/g,'$1/$2').trim(); };
    const junkName=(n)=>!n || /^\d+\+?$/.test(String(n).trim()) || String(n).trim().length<4;
    const recs=(d.flower||[]).map(r=>({...r,dispensary:label,jars:true,name:(junkName(r.name)&&r.url)?nameFromUrl(r.url):r.name}));
    if(recs.length){ try{ await m.resolveLeanViaLeafly(recs,{log:()=>{}}); }catch(_){}}
    recs.forEach(m.applyLeanInference);
    const kept=m.applyFilters(recs,opts).kept;
    console.log(label+': '+d.flower.length+' flower -> '+kept.length+' qualify');
    kept.forEach(r=>console.log('  KEEP  $'+r.pricePerGram.toFixed(2)+'/g '+r.thc+'% '+r.strainLabel+' — '+(r.name==='3+'&&r.url? r.url.split('/product/')[1] : r.name)));
    allJarsKept=allJarsKept.concat(kept);
  }
  const all=base.results.concat(allJarsKept);
  const ranked=m.rankListings(all,false);
  fs.writeFileSync('weed-results-merged.json',JSON.stringify({...base,count:ranked.length,results:ranked,jarsAdded:allJarsKept.length},null,2));
  console.log('\nMERGED total:',ranked.length,'| JARS qualifiers added:',allJarsKept.length);
  ranked.slice(0,6).forEach((r,i)=>console.log('  #'+(i+1)+'  $'+r.pricePerGram.toFixed(2)+'/g  '+r.thc+'%  '+(r.jars?'[JARS] ':'')+r.dispensary.split('(')[0].trim()+' — '+r.name));
})();
