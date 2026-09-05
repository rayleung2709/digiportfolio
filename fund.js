(async()=>{
'use strict';
const $=s=>document.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=(n,d=0)=>(n==null||!isFinite(n))?'–':n.toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d});
const pct=n=>n==null||!isFinite(n)?'–':(n*100).toFixed(1)+'%';
const cls=n=>n>0?'pos':n<0?'neg':'';
const DAY_MS=86400000, XIRR_MIN_AGE_DAYS=25, YEAR_MS=31557600000;
const file=document.body.dataset.file;
const charts={};

function showError(msg){
  const box=$('#upd');
  box.classList.remove('loading');
  box.innerHTML=`<span class="errbar">⚠️ ${esc(msg)} <button id="retryBtn">重試</button></span>`;
  const b=$('#retryBtn');if(b)b.onclick=()=>location.reload();
}
function showTab(id){
  document.querySelectorAll('nav[role=tablist] button').forEach(b=>{
    const on=b.dataset.t===id;b.classList.toggle('on',on);b.setAttribute('aria-selected',on);
  });
  document.querySelectorAll('section[role=tabpanel]').forEach(s=>{
    const on=s.id===id;s.classList.toggle('on',on);s.setAttribute('aria-hidden',on?'false':'true');
  });
  setTimeout(()=>Object.values(charts).forEach(c=>c?.resize()),0);
}
document.querySelectorAll('nav[role=tablist] button').forEach(b=>b.onclick=()=>showTab(b.dataset.t));

// ── Chart 共用 ──
const ZOOM={zoom:{wheel:{enabled:true},pinch:{enabled:true},mode:'x'},pan:{enabled:true,mode:'x'},limits:{x:{minRange:5}}};
const base=()=>({animation:false,interaction:{mode:'index',intersect:false},
  plugins:{zoom:JSON.parse(JSON.stringify(ZOOM)),legend:{position:'bottom'}},
  scales:{x:{ticks:{maxTicksLimit:8}},y:{ticks:{callback:v=>(v/1000).toFixed(0)+'k'}}}});
const RANGES={'1M':30,'3M':91,'6M':182,'YTD':0,'ALL':null};
function sliceR(rows,r){
  if(!rows.length||r==='ALL')return rows;
  const end=new Date(rows[rows.length-1].d);
  const from=r==='YTD'?end.getFullYear()+'-01-01':new Date(end-RANGES[r]*DAY_MS).toISOString().slice(0,10);
  return rows.filter(x=>x.d>=from);
}
function mkBar(el,active,onRange,onReset){
  el.querySelectorAll('button').forEach(b=>b.remove());
  const btns=[];
  if(onRange)for(const k of Object.keys(RANGES)){
    const b=document.createElement('button');b.textContent=k;
    const on=k===active;if(on)b.className='on';
    b.setAttribute('aria-pressed',on);
    b.onclick=()=>{btns.forEach(x=>{x.classList.remove('on');x.setAttribute('aria-pressed','false');});
      b.classList.add('on');b.setAttribute('aria-pressed','true');onRange(k);};
    btns.push(b);
  }
  const r=document.createElement('button');
  r.textContent='↺';r.title='重設縮放';r.setAttribute('aria-label','重設縮放');
  r.onclick=onReset;btns.push(r);
  el.prepend(...btns);
}

// ── 記帳核心 ──
// 第 5 個元素 =0 代表「轉換」交易，唔計做供款；undefined/其他值一律當供款
// （t[4]||'C'==='C' 呢種寫法有 0 係 falsy 嘅陷阱，已改用嚴格比較）
const isC=t=>t[4]!==0;
function newState(){return {pos:{},contributed:0,realised:0};}
function applyTx(state,t){
  const [,f,u,p]=t,amt=u*p;
  const q=state.pos[f]||(state.pos[f]={units:0,cost:0,realised:0});
  if(u>=0){q.units+=u;q.cost+=amt;}
  else{
    const cb=q.units?q.cost/q.units*-u:0;
    q.realised+=(-amt)-cb;state.realised+=(-amt)-cb;
    q.units+=u;q.cost-=cb;
    if(q.units<1e-6){q.units=0;q.cost=0;}
  }
  if(isC(t))state.contributed+=amt;
}
function fundVal(f,units,pxRow){
  const e=pxRow[f];if(!e)return 0;
  return e.bal!=null?e.bal:units*(e.px??0);
}
const valueAt=(S,pxRow)=>Object.entries(S.pos).reduce((s,[f,q])=>s+fundVal(f,q.units,pxRow),0);

function xirr(flows){
  if(flows.length<2)return null;
  const t0=new Date(flows[0].d),yr=f=>(new Date(f.d)-t0)/YEAR_MS;
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
  return null; // 200 次未收斂就放棄，唔扔假值
}

// 價格／結餘序列
function buildSeries(D,codes,tx){
  const PS={},BS={};
  for(const f of codes){
    const m={...(D.prices?.[f]||{})};
    if(!D.balances?.[f])for(const t of tx)if(t[1]===f&&t[3]!=null)m[t[0]]=t[3];
    PS[f]=Object.entries(m).sort((a,b)=>a[0]<b[0]?-1:1);
  }
  for(const [f,m] of Object.entries(D.balances||{}))BS[f]=Object.entries(m).sort((a,b)=>a[0]<b[0]?-1:1);
  return {PS,BS};
}
// 一次過順序掃描（O(dates+tx)），唔再逐日 replay 全部交易
function buildTimeline(D,codes,tx){
  const {PS,BS}=buildSeries(D,codes,tx);
  const dateSet=new Set(tx.map(t=>t[0]));
  for(const f of codes){(PS[f]||[]).forEach(([d])=>dateSet.add(d));(BS[f]||[]).forEach(([d])=>dateSet.add(d));}
  const dates=[...dateSet].filter(d=>d>=tx[0][0]).sort();
  const state=newState(),last={},ptr={};
  for(const f of codes)ptr[f]={ps:0,bs:0};
  let ti=0;const flowsSoFar=[],snaps=[];
  for(const d of dates){
    for(const f of codes){
      const ps=PS[f]||[];while(ptr[f].ps<ps.length&&ps[ptr[f].ps][0]<=d){(last[f]??={}).px=ps[ptr[f].ps][1];ptr[f].ps++;}
      const bs=BS[f]||[];while(ptr[f].bs<bs.length&&bs[ptr[f].bs][0]<=d){(last[f]??={}).bal=bs[ptr[f].bs][1];ptr[f].bs++;}
    }
    while(ti<tx.length&&tx[ti][0]<=d){
      const t=tx[ti];applyTx(state,t);
      if(isC(t))flowsSoFar.push({d:t[0],v:-t[2]*t[3]});
      ti++;
    }
    snaps.push({d,S:structuredClone(state),px:{...last},flows:flowsSoFar.slice()});
  }
  return snaps;
}

let D;
try{
  const r=await fetch(file+'?t='+Date.now());
  if(!r.ok)throw new Error(`HTTP ${r.status}`);
  D=await r.json();
}catch(e){showError(`讀唔到 ${file}（${e.message}）`);console.error(e);return;}

document.title=D.title||file;$('#title').textContent=D.title||file;
const F=D.funds||{},codes=Object.keys(F);
const tx=[...(D.transactions||[])].sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0);
if(!tx.length){showError(`未有交易 — 去 ${file} 加一行`);return;}

const snaps=buildTimeline(D,codes,tx);
const L=snaps[snaps.length-1],value=valueAt(L.S,L.px),pl=value-L.S.contributed;
const irr=xirr([...L.flows,{d:L.d,v:value}]);
const H=snaps.map(({d,S:st,px,flows})=>{
  const v=valueAt(st,px),old=(new Date(d)-new Date(tx[0][0]))>XIRR_MIN_AGE_DAYS*DAY_MS;
  return {d,cost:st.contributed,v,pl:v-st.contributed,irr:old?xirr([...flows,{d,v}]):null};
});

const upd=$('#upd');upd.classList.remove('loading');
upd.textContent=`最新數據：${L.d} · 全部 HKD · 數據檔 ${file}`;

$('#kpis').innerHTML=[
  ['總供款（淨）',fmt(L.S.contributed)],
  ['總市值',fmt(value)],
  ['盈虧',`<span class="${cls(pl)}">${fmt(pl)} (${pct(pl/L.S.contributed)})</span>`],
  ['年化 XIRR',`<span class="${cls(irr)}">${pct(irr)}</span>`],
  ['轉換已實現',`<span class="${cls(L.S.realised)}">${L.S.realised?fmt(L.S.realised):'–'}</span>`],
  ['供款次數',tx.filter(t=>isC(t)&&t[2]>0).length+' 次 · 自 '+tx[0][0]],
].map(([l,v])=>`<div class="kpi"><div class="l">${l}</div><div class="v">${v}</div></div>`).join('');

// ── 持倉 ──
let rows='',tc=0,tv=0;
for(const f of codes){
  const q=L.S.pos[f];if(!q)continue;
  const e=L.px[f]||{},bal=e.bal!=null,mv=fundVal(f,q.units,L.px),open=bal||q.units>0,u=mv-q.cost;
  if(open){tc+=q.cost;tv+=mv;}
  rows+=`<tr data-code="${esc(f)}" class="${open?'':'closed'}"><td>${esc(f)}</td><td class="l">${esc(F[f]||'')}</td>
    <td>${bal?'結餘':open?fmt(q.units,4):'–'}</td><td>${open?fmt(q.cost):'–'}</td><td>${bal||!open?'–':fmt(q.cost/q.units,4)}</td>
    <td>${bal?'–':fmt(e.px,4)}</td><td>${open?fmt(mv):'–'}</td>
    <td class="${cls(u)}">${open?fmt(u):'–'}</td><td class="${cls(u)}">${open?pct(u/q.cost):'–'}</td>
    <td class="${cls(q.realised)}">${q.realised?fmt(q.realised):'–'}</td></tr>`;
}
$('#holdT').innerHTML=`<table><thead><tr><th>基金</th><th class="l">名稱</th><th>單位</th><th>成本</th><th>平均價</th><th>現價</th><th>市值</th><th>未實現</th><th>%</th><th>轉換已實現</th></tr></thead>
  <tbody>${rows}</tbody><tfoot><tr><td colspan="3">合計</td><td>${fmt(tc)}</td><td></td><td></td><td>${fmt(tv)}</td>
  <td class="${cls(tv-tc)}">${fmt(tv-tc)}</td><td class="${cls(tv-tc)}">${pct((tv-tc)/tc)}</td><td class="${cls(L.S.realised)}">${L.S.realised?fmt(L.S.realised):'–'}</td></tr></tfoot></table>
  <div class="sub" style="margin-top:6px">「成本」係該基金累計投入（轉換入嘅按轉換日市值計）；總盈虧以頂部「總供款」為準。</div>`;
$('#holdT').querySelectorAll('tr[data-code]').forEach(r=>r.onclick=()=>{fundSel.value=r.dataset.code;drawFund();showTab('fund');});

// ── 交易 ──
$('#txT').innerHTML=`<table><thead><tr><th>日期</th><th class="l">基金</th><th class="l">類型</th><th>單位</th><th>單位價</th><th>金額</th></tr></thead><tbody>${
  [...tx].reverse().map(t=>`<tr><td>${esc(t[0])}</td><td class="l">${esc(t[1])}</td><td class="l">${isC(t)?(t[2]>=0?'供款':'提款'):(t[2]>=0?'轉入':'轉出')}</td><td>${fmt(t[2],4)}</td><td>${fmt(t[3],4)}</td><td>${fmt(t[2]*t[3])}</td></tr>`).join('')
}</tbody></table>`;

// ── 歷史 + 圖（可縮放／拖曳／揀時間段）──
let histRange='ALL';
$('#histT').innerHTML=`<table><thead><tr><th>日期</th><th>總供款</th><th>總市值</th><th>盈虧</th><th>%</th><th>XIRR</th></tr></thead><tbody>${
  [...H].reverse().map(h=>`<tr><td>${esc(h.d)}</td><td>${fmt(h.cost)}</td><td>${fmt(h.v)}</td><td class="${cls(h.pl)}">${fmt(h.pl)}</td><td class="${cls(h.pl)}">${pct(h.pl/h.cost)}</td><td class="${cls(h.irr)}">${pct(h.irr)}</td></tr>`).join('')
}</tbody></table>`;
const drawHist=rg=>{
  histRange=rg;charts.hist?.destroy();const Dv=sliceR(H,rg);
  const o=base();
  o.scales.y1={position:'right',grid:{drawOnChartArea:false},ticks:{callback:v=>(v/1000).toFixed(0)+'k'},title:{display:true,text:'盈虧',font:{size:10}}};
  charts.hist=new Chart($('#chart'),{type:'line',data:{labels:Dv.map(h=>h.d),datasets:[
    {label:'總市值',data:Dv.map(h=>h.v),borderColor:'#0a7d3b',pointRadius:0,tension:.2,yAxisID:'y'},
    {label:'總供款',data:Dv.map(h=>h.cost),borderColor:'#999',borderDash:[4,4],pointRadius:0,stepped:true,yAxisID:'y'},
    {label:'盈虧',data:Dv.map(h=>h.pl),pointRadius:0,tension:.2,borderWidth:1.5,yAxisID:'y1',borderColor:'#0a7d3b',
      segment:{borderColor:c=>c.p1.parsed.y>=0?'#0a7d3b':'#c0392b'},
      fill:{target:'origin',above:'rgba(10,125,59,.10)',below:'rgba(192,57,43,.10)'}}]},options:o});
};
mkBar($('#histBar'),histRange,drawHist,()=>charts.hist?.resetZoom());
drawHist(histRange);

// ── 基金（撳持倉行 / 揀 dropdown 睇個別基金）──
const fundSel=$('#fundSel');
const held=codes.filter(f=>L.S.pos[f]);
fundSel.innerHTML=`<option value="">全部 · 價格重設為 100</option>`+
  held.map(f=>`<option value="${esc(f)}">${esc(f)} · ${esc(F[f]||'')}</option>`).join('');
fundSel.onchange=drawFund;
mkBar($('#fundBar'),null,null,()=>charts.fund?.resetZoom());

function drawFund(){
  const code=fundSel.value;
  charts.fund?.destroy();
  if(!code){
    const ds=held.map((f,i)=>{let b=null;return {label:f,borderColor:`hsl(${Math.round(i*360/held.length)} 60% 45%)`,
      pointRadius:0,tension:.2,spanGaps:true,borderWidth:1.5,
      data:snaps.map(s=>{const e=s.px[f];const p=e?.bal??e?.px;if(p==null)return null;b??=p;return p/b*100;})};});
    const o=base();o.scales.y.ticks.callback=v=>v.toFixed(0);
    charts.fund=new Chart($('#fundChart'),{type:'line',data:{labels:snaps.map(s=>s.d),datasets:ds},options:o});
    $('#fundKpi').innerHTML='';
    const rowsF=held.map(f=>{
      const q=L.S.pos[f],e=L.px[f]||{},bal=e.bal!=null,mv=fundVal(f,q.units,L.px),u=mv-q.cost;
      const first=snaps.find(s=>s.px[f]!=null)?.px[f],firstP=first?.bal??first?.px;
      const curP=bal?e.bal:e.px;
      return {f,chg:firstP?curP/firstP-1:null,u,r:q.realised,tot:u+q.realised,w:mv/value};
    }).sort((a,b)=>b.tot-a.tot);
    $('#fundT').innerHTML=`<table><thead><tr><th>基金</th><th class="l">名稱</th><th>價格變動</th><th>未實現</th><th>轉換已實現</th><th>合計貢獻</th><th>佔倉</th></tr></thead><tbody>${
      rowsF.map(x=>`<tr data-code="${esc(x.f)}"><td>${esc(x.f)}</td><td class="l">${esc(F[x.f]||'')}</td>
        <td class="${cls(x.chg)}">${pct(x.chg)}</td><td class="${cls(x.u)}">${fmt(x.u)}</td><td class="${cls(x.r)}">${x.r?fmt(x.r):'–'}</td>
        <td class="${cls(x.tot)}">${fmt(x.tot)}</td><td>${pct(x.w)}</td></tr>`).join('')
    }</tbody></table>`;
    $('#fundT').querySelectorAll('tr[data-code]').forEach(r=>r.onclick=()=>{fundSel.value=r.dataset.code;drawFund();});
    return;
  }
  const rowsD=[];
  for(const s of snaps){
    const q=s.S.pos[code],e=s.px[code];if(!q||!e)continue;
    const mv=fundVal(code,q.units,s.px);
    rowsD.push({d:s.d,units:q.units,cost:q.cost,avg:q.units?q.cost/q.units:null,px:e.bal??e.px,mv,u:mv-q.cost,realised:q.realised});
  }
  const o=base();
  o.scales.y1={position:'right',grid:{drawOnChartArea:false},ticks:{callback:v=>(v/1000).toFixed(0)+'k'},title:{display:true,text:'盈虧',font:{size:10}}};
  charts.fund=new Chart($('#fundChart'),{type:'line',data:{labels:rowsD.map(x=>x.d),datasets:[
    {label:'市值',data:rowsD.map(x=>x.mv),borderColor:'#0a7d3b',pointRadius:0,tension:.2,yAxisID:'y'},
    {label:'成本',data:rowsD.map(x=>x.cost),borderColor:'#999',borderDash:[4,4],pointRadius:0,stepped:true,yAxisID:'y'},
    {label:'未實現盈虧',data:rowsD.map(x=>x.u),pointRadius:0,tension:.2,borderWidth:1.5,yAxisID:'y1',borderColor:'#0a7d3b',
      segment:{borderColor:c=>c.p1.parsed.y>=0?'#0a7d3b':'#c0392b'},
      fill:{target:'origin',above:'rgba(10,125,59,.10)',below:'rgba(192,57,43,.10)'}}]},options:o});
  const last=rowsD[rowsD.length-1]||{};
  $('#fundKpi').innerHTML=[
    ['單位',fmt(last.units,4)],
    ['平均成本 / 現價',`${fmt(last.avg,4)} / ${fmt(last.px,4)}`],
    ['市值',fmt(last.mv)],
    ['未實現',`<span class="${cls(last.u)}">${fmt(last.u)} (${pct(last.u/last.cost)})</span>`],
    ['轉換已實現',`<span class="${cls(last.realised)}">${last.realised?fmt(last.realised):'–'}</span>`],
  ].map(([l,v])=>`<div class="kpi"><div class="l">${l}</div><div class="v">${v}</div></div>`).join('');
  $('#fundT').innerHTML=`<table><thead><tr><th>日期</th><th>單位</th><th>成本</th><th>平均價</th><th>現價</th><th>市值</th><th>未實現</th><th>%</th><th>轉換已實現</th></tr></thead><tbody>${
    [...rowsD].reverse().map(x=>`<tr><td>${esc(x.d)}</td><td>${fmt(x.units,4)}</td><td>${fmt(x.cost)}</td><td>${fmt(x.avg,4)}</td><td>${fmt(x.px,4)}</td>
      <td>${fmt(x.mv)}</td><td class="${cls(x.u)}">${fmt(x.u)}</td><td class="${cls(x.u)}">${pct(x.u/x.cost)}</td><td class="${cls(x.realised)}">${x.realised?fmt(x.realised):'–'}</td></tr>`).join('')
  }</tbody></table>`;
}
drawFund();
})().catch(e=>{document.querySelector('#upd')?.classList.remove('loading');document.querySelector('#upd').textContent='未預期的錯誤：'+e.message;console.error(e);});
