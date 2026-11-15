/* Booked Out Solutions - calendar logo engine (shared by stage.html, the website hero and the render kit).
   Same look as r8.html (Nov 14 final logo), but every tile can be animated.
   BOLogo.css  -> CSS text (needs fonts "Brico" 800 and "Man" 800 defined by the page)
   BOLogo.months(date, back=5, ahead=2) -> [{label, kind:'past'|'book'|'open', off}]
   BOLogo.build(boardEl, opts) -> api {tiles, set(i, state), setAll(fn)}
     opts: {date, back, ahead, side (layers per tile, default 14), thick (board layers, default 16)}
     state: {lift, past, open, book (face opacities 0-1), stamp (0-1 slam progress, 1 = landed),
             x (0-2 stroke progress), flip (deg), glow (0-1), sheen (-1..2 band position), burst (0-1)} */
(function(G){
const MN=['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
const css=`
.bo-board{position:relative;width:700px;padding:86px 34px 34px;border-radius:38px;transform-style:preserve-3d;background:linear-gradient(160deg,#fffdf7,#efe6d3 60%,#e2d6bd)}
.bo-thick{position:absolute;inset:0;border-radius:38px}
.bo-head{position:absolute;left:0;right:0;top:0;height:78px;border-radius:38px 38px 0 0;background:linear-gradient(180deg,#2d3e86,#16204A);display:flex;align-items:center;justify-content:center;font-family:Brico;font-weight:800;font-size:38px;letter-spacing:6px;color:#EDB547;text-shadow:0 2px 0 #7a5512}
.bo-rings{position:absolute;top:-34px;left:0;right:0;display:flex;justify-content:space-around;padding:0 120px;transform:translateZ(14px)}
.bo-ring{width:26px;height:64px;border-radius:13px;background:linear-gradient(90deg,#7a5a1a,#ffe7a6 40%,#EDB547 60%,#6b4c14);box-shadow:0 8px 12px #0009}
.bo-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:18px;transform-style:preserve-3d}
.bo-t{position:relative;height:112px;border-radius:18px;transform-style:preserve-3d}
.bo-sd{position:absolute;inset:0;border-radius:18px}
.bo-top{position:absolute;inset:0;border-radius:18px;transform-style:preserve-3d}
.bo-f{position:absolute;inset:0;border-radius:18px;overflow:hidden}
.bo-m{height:30px;display:flex;align-items:center;justify-content:center;font-family:Brico;font-weight:800;font-size:19px;letter-spacing:2px}
.bo-past{background:linear-gradient(160deg,#f4ede0,#e2d8c4);box-shadow:inset 0 2px 0 #fff}.bo-past .bo-m{background:#16204A;color:#8E96B3}
.bo-book{background:linear-gradient(150deg,#fff0bd,#EDB547 45%,#c08a23 80%,#9c6c18);box-shadow:inset 0 2px 0 #fff8}.bo-book .bo-m{background:#0A0F26;color:#EDB547}
.bo-open{background:linear-gradient(160deg,#ffffff,#f1ebdf);box-shadow:inset 0 2px 0 #fff}.bo-open .bo-m{background:#2d3e86;color:#F6F1E7}
.bo-stamp{position:absolute;left:0;right:0;top:44px;text-align:center;font-family:Brico;font-weight:800;font-size:26px;letter-spacing:2px;color:#0A0F26;text-shadow:0 1px 0 #ffe9a8}
.bo-openlbl{position:absolute;left:0;right:0;top:50px;text-align:center;font-family:Man;font-weight:800;font-size:15px;letter-spacing:3px;color:#16204A66}
.bo-sheen{position:absolute;inset:0;background:linear-gradient(105deg,transparent 38%,rgba(255,255,255,.75) 50%,transparent 62%);background-size:300% 100%;background-repeat:no-repeat;mix-blend-mode:soft-light;pointer-events:none}
.bo-x{position:absolute;left:50%;top:62%;width:60px;transform:translate(-50%,-50%);filter:drop-shadow(0 3px 0 #8e1f24) drop-shadow(0 6px 6px #0006);overflow:visible}
.bo-burst{position:absolute;left:50%;top:50%;width:140px;height:140px;margin:-70px 0 0 -70px;border-radius:50%;border:4px solid #FFD56B;opacity:0;pointer-events:none}
`;
function months(date,back=5,ahead=2){const s=new Date(date.getFullYear(),date.getMonth()-back,1),out=[];
 for(let i=0;i<12;i++){const d=new Date(s.getFullYear(),s.getMonth()+i,1),off=i-back;
  out.push({label:MN[d.getMonth()]+(d.getMonth()===0||i===0?' ’'+String(d.getFullYear()).slice(2):''),kind:off<0?'past':off<=ahead?'book':'open',off,date:d});}
 return out;}
function yearLabel(date,back=5){const s=new Date(date.getFullYear(),date.getMonth()-back,1),e=new Date(s.getFullYear(),s.getMonth()+11,1);
 return s.getFullYear()===e.getFullYear()?String(s.getFullYear()):s.getFullYear()+' – '+e.getFullYear();}
function build(board,o={}){
 const date=o.date||new Date(),back=o.back??5,ahead=o.ahead??2,NS=o.side??14,NT=o.thick??16;
 board.classList.add('bo-board');
 let h='';for(let k=1;k<=NT;k++)h+=`<div class="bo-thick" style="transform:translateZ(${(-k*1.6*16/NT).toFixed(2)}px);background:${k<NT*.25?'#d9ccb0':k<NT*.6?'#b9a985':'#8f7f5d'}"></div>`;
 h+=`<div class="bo-rings">${'<div class="bo-ring"></div>'.repeat(4)}</div><div class="bo-head">${yearLabel(date,back)}</div><div class="bo-grid">`;
 const M=months(date,back,ahead);
 const xs=`<svg class="bo-x" viewBox="0 0 24 24"><path d="M5 5L19 19" pathLength="1" stroke="#E5484D" stroke-width="3.4" stroke-linecap="round" fill="none" stroke-dasharray="1 1"/><path d="M19 5L5 19" pathLength="1" stroke="#E5484D" stroke-width="3.4" stroke-linecap="round" fill="none" stroke-dasharray="1 1"/></svg>`;
 for(const m of M){h+=`<div class="bo-t">${'<div class="bo-sd"></div>'.repeat(NS)}<div class="bo-top">
  <div class="bo-f bo-open"><div class="bo-m">${m.label}</div><div class="bo-openlbl">OPEN</div></div>
  <div class="bo-f bo-past"><div class="bo-m">${m.label}</div>${xs}</div>
  <div class="bo-f bo-book"><div class="bo-m">${m.label}</div><div class="bo-stamp">BOOKED</div><div class="bo-sheen"></div></div>
  </div><div class="bo-burst"></div></div>`;}
 board.innerHTML=h+'</div>';
 const tiles=[...board.querySelectorAll('.bo-t')].map((el,i)=>({el,m:M[i],sides:[...el.querySelectorAll('.bo-sd')],top:el.querySelector('.bo-top'),
  fo:el.querySelector('.bo-open'),fp:el.querySelector('.bo-past'),fb:el.querySelector('.bo-book'),stamp:el.querySelector('.bo-stamp'),
  sheen:el.querySelector('.bo-sheen'),xp:[...el.querySelectorAll('.bo-x path')],burst:el.querySelector('.bo-burst'),_c:null}));
 function rest(kind){return kind==='past'?{lift:4,past:1,open:0,book:0,stamp:1,x:2}:kind==='book'?{lift:26,past:0,open:0,book:1,stamp:1,x:0}:{lift:10,past:0,open:1,book:0,stamp:1,x:0};}
 function set(i,s){const t=tiles[i];s=Object.assign({glow:0,sheen:-1,burst:0,flip:0,pop:1},s);
  const L=s.lift,col=s.book>.5?null:(s.past>.5?'#bfb399':'#cbbfa6');
  t.sides.forEach((d,k)=>{const z=((k+1)/NS)*L;d.style.transform=`translateZ(${z.toFixed(2)}px)`;
   d.style.background=col||((k+1)/NS<.4?'#6b4810':'#8f6216');d.style.opacity=s.pop<1?s.pop:'';});
  t.top.style.transform=`translateZ(${(L+.6).toFixed(2)}px) rotateX(${s.flip}deg) scale(${s.pop})`;
  t.fo.style.opacity=s.open;t.fp.style.opacity=s.past;
  // stamp slam: book face drops from 1.55x, lands with a small squash
  const k=s.stamp,sc=k>=1?1:k<.55?1.55-0.55*(k/.55)**2:1-0.06*Math.sin((k-.55)/.45*Math.PI);
  t.fb.style.opacity=s.book*Math.min(1,k/.35);t.fb.style.transform=`scale(${sc.toFixed(4)})`;
  t.fb.style.boxShadow=`inset 0 2px 0 #fff8, 0 0 ${30+40*s.glow}px rgba(237,181,71,${(.4+.5*s.glow)*s.book})`;
  t.sheen.style.backgroundPosition=`${(100-s.sheen*100).toFixed(1)}% 0`;
  t.xp[0].style.strokeDashoffset=1-Math.min(1,Math.max(0,s.x));t.xp[1].style.strokeDashoffset=1-Math.min(1,Math.max(0,s.x-1));
  const b=s.burst;t.burst.style.opacity=b>0&&b<1?(1-b)*.9:0;t.burst.style.transform=`translateZ(${L+2}px) scale(${.6+b*1.5})`;}
 return {tiles,months:M,set,rest,count:tiles.length};}
G.BOLogo={css,months,build,yearLabel};
})(typeof window!=='undefined'?window:globalThis);