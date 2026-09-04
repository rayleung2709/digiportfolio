(async()=>{
const $=s=>document.querySelector(s);
const fmt=(n,d=0)=>n==null||!isFinite(n)?'–':n.toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d});
const pct=n=>n==null||!isFinite(n)?'–':(n*100).toFixed(1)+'%';
const cls=n=>n>0?'pos':n<0?'neg':'';
const file=document.body.dataset.file;

let D;
try{const r=await fetch(file+'?t='+Date.now());if(!r.ok)throw 0;D=await r.json();}
catch{$('#upd').textContent='讀唔到 '+file+'（檔案要存在，而且要由 GitHub Pages 網址開）';return;}
document.title=D.title||file;$('#title').textContent=D.title||file;

const F=D.funds||{},codes=Object.keys(F);
const tx=[...(D.transactions||[])].sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0);
if(!tx.length){$('#upd').textContent='未有交易 — 去 '+file+' 加一行';return;}
const isC=t=>(t[4]||'C')==='C';

// 價格序列 = prices + 每次交易當日單位價；結餘型基金用 balances
const PS={},BS={};
for(const f of codes){
  const m={...(D.prices?.[f]||{})};
  for(const [d,ff,u,p] of tx)if(ff===f&&p!=null&&!D.balances?.[f])m[d]=p;
  PS[f]=Object.entries(m).sort();
}
for(const [f,m] of Object.entries(D.balances||{}))BS[f]=Object.entries(m).sort();
const at=(arr,d)=>{let r=null;for(const [k,v] of arr){if(k>d)break;r=v;}return r;};
const pxAt=(f,d)=>at(PS[f]||[],d);
const fundVal=(f,units,d)=>BS[f]?(at(BS[f],d)??0):units*(pxAt(f,d)??0);

function replay(asOf){
  const pos={};let contributed=0;
  for(const t of tx){
    const [d,f,u,p]=t;if(d>asOf)break;
    const amt=u*p,q=pos[f]||(pos[f]={units:0,cost:0,realised:0});
    if(u>=0){q.units+=u;q.cost+=amt;}
    else{const cb=q.units?q.cost/q.units*-u:0;q.realised+=(-amt)-cb;q.units+=u;q.cost-=cb;if(q.units<1e-6){q.units=0;q.cost=0;}}
    if(isC(t))contributed+=amt;
  }
  return {pos,contributed};
}
function xirr(flows){
  if(flows.length<2)return null;
  const t0=new Date(flows[0].d),yr=f=>(new Date(f.d)-t0)/31557600000;
  let r=0.1;
  for(let i=0;i<200;i++){
    let f=0,df=0;
    for(const c of flows){const t=yr(c),b=Math.pow(1+r,t);f+=c.v/b;df-=t*c.v/(b*(1+r));}
    if(Math.abs(df)<1e-12)return null;
    const nr=r-f/df;
    if(!isFinite(nr)||nr<-0.99)return null;
    if(Math.abs(nr-r)<1e-8)return nr;
    r=nr;
  }
  return r;
}
const valueAt=(S,d)=>Object.entries(S.pos).reduce((s,[f,q])=>s+fundVal(f,q.units,d),0);
const flowsTo=d=>tx.filter(t=>t[0]<=d&&isC(t)).map(t=>({d:t[0],v:-t[2]*t[3]}));

// 每個有數據嘅日子做一個 snapshot
const dates=[...new Set([...tx.map(t=>t[0]),...Object.values(PS).flat().map(x=>x[0]),...Object.values(BS).flat().map(x=>x[0])])]
  .filter(d=>d>=tx[0][0]).sort();
const H=dates.map(d=>{
  const S=replay(d),v=valueAt(S,d),old=(new Date(d)-new Date(tx[0][0]))>25*86400000;
  return {d,cost:S.contributed,v,pl:v-S.contributed,irr:old?xirr([...flowsTo(d),{d,v}]):null};
});
const L=H[H.length-1],S=replay(L.d);
$('#upd').textContent=`最新數據：${L.d} · 全部 HKD · 數據檔 ${file}`;

// KPI
$('#kpis').innerHTML=[
  ['總供款（淨）',fmt(L.cost)],
  ['總市值',fmt(L.v)],
  ['盈虧',`<span class="${cls(L.pl)}">${fmt(L.pl)} (${pct(L.pl/L.cost)})</span>`],
  ['年化 XIRR',`<span class="${cls(L.irr)}">${pct(L.irr)}</span>`],
  ['供款次數',tx.filter(t=>isC(t)&&t[2]>0).length+' 次 · 自 '+tx[0][0]],
].map(([l,v])=>`<div class="kpi"><div class="l">${l}</div><div class="v">${v}</div></div>`).join('');

// 圖：市值 + 成本（左軸），盈虧（右軸，綠／紅）
new Chart($('#chart'),{type:'line',data:{labels:H.map(h=>h.d),datasets:[
  {label:'總市值',data:H.map(h=>h.v),borderColor:'#0a7d3b',pointRadius:2,tension:.2,yAxisID:'y'},
  {label:'總供款',data:H.map(h=>h.cost),borderColor:'#999',borderDash:[4,4],pointRadius:0,stepped:true,yAxisID:'y'},
  {label:'盈虧',data:H.map(h=>h.pl),pointRadius:0,tension:.2,borderWidth:1.5,yAxisID:'y1',borderColor:'#0a7d3b',
    segment:{borderColor:c=>c.p1.parsed.y>=0?'#0a7d3b':'#c0392b'},
    fill:{target:'origin',above:'rgba(10,125,59,.10)',below:'rgba(192,57,43,.10)'}}]},
  options:{animation:false,interaction:{mode:'index',intersect:false},plugins:{legend:{position:'bottom'}},
    scales:{x:{ticks:{maxTicksLimit:8}},y:{ticks:{callback:v=>(v/1000).toFixed(0)+'k'}},
      y1:{position:'right',grid:{drawOnChartArea:false},ticks:{callback:v=>(v/1000).toFixed(0)+'k'},title:{display:true,text:'盈虧',font:{size:10}}}}}});

// 持倉
let rows='',tc=0,tv=0;
for(const f of codes){
  const q=S.pos[f];if(!q)continue;
  const bal=!!BS[f],mv=fundVal(f,q.units,L.d),open=bal||q.units>0,u=mv-q.cost,px=pxAt(f,L.d);
  if(open){tc+=q.cost;tv+=mv;}
  rows+=`<tr class="${open?'':'closed'}"><td>${f}</td><td class="l">${F[f]}</td>
    <td>${bal?'結餘':open?fmt(q.units,4):'–'}</td><td>${open?fmt(q.cost):'–'}</td><td>${bal||!open?'–':fmt(q.cost/q.units,4)}</td>
    <td>${bal?'–':fmt(px,4)}</td><td>${open?fmt(mv):'–'}</td>
    <td class="${cls(u)}">${open?fmt(u):'–'}</td><td class="${cls(u)}">${open?pct(u/q.cost):'–'}</td>
    <td class="${cls(q.realised)}">${q.realised?fmt(q.realised):'–'}</td></tr>`;
}
$('#holdT').innerHTML=`<table><thead><tr><th>基金</th><th class="l">名稱</th><th>單位</th><th>成本</th><th>平均價</th><th>現價</th><th>市值</th><th>未實現</th><th>%</th><th>轉換已實現</th></tr></thead>
  <tbody>${rows}</tbody><tfoot><tr><td colspan="3">合計</td><td>${fmt(tc)}</td><td></td><td></td><td>${fmt(tv)}</td>
  <td class="${cls(tv-tc)}">${fmt(tv-tc)}</td><td class="${cls(tv-tc)}">${pct((tv-tc)/tc)}</td><td></td></tr></tfoot></table>
  <div class="sub" style="margin-top:6px">「成本」係該基金累計投入（轉換入嘅按轉換日市值計）；總盈虧以頂部「總供款」為準。</div>`;

// 歷史
$('#histT').innerHTML=`<table><thead><tr><th>日期</th><th>總供款</th><th>總市值</th><th>盈虧</th><th>%</th><th>XIRR</th></tr></thead><tbody>${
  [...H].reverse().map(h=>`<tr><td>${h.d}</td><td>${fmt(h.cost)}</td><td>${fmt(h.v)}</td><td class="${cls(h.pl)}">${fmt(h.pl)}</td><td class="${cls(h.pl)}">${pct(h.pl/h.cost)}</td><td class="${cls(h.irr)}">${pct(h.irr)}</td></tr>`).join('')
}</tbody></table>`;

// 交易
$('#txT').innerHTML=`<table><thead><tr><th>日期</th><th class="l">基金</th><th class="l">類型</th><th>單位</th><th>單位價</th><th>金額</th></tr></thead><tbody>${
  [...tx].reverse().map(t=>`<tr><td>${t[0]}</td><td class="l">${t[1]}</td><td class="l">${isC(t)?(t[2]>=0?'供款':'提款'):(t[2]>=0?'轉入':'轉出')}</td><td>${fmt(t[2],4)}</td><td>${fmt(t[3],4)}</td><td>${fmt(t[2]*t[3])}</td></tr>`).join('')
}</tbody></table>`;
})().catch(e=>{document.querySelector('#upd').textContent='錯誤：'+e.message;console.error(e);});
