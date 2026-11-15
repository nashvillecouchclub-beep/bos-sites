/* Booked Out v3 round 2: picker, split-flap, recordings, job presets, before/after */
(function(){
var RM=matchMedia('(prefers-reduced-motion: reduce)').matches;
function $$(s,r){return Array.prototype.slice.call((r||document).querySelectorAll(s))}
// phones get the zoomed-in recordings, cut to follow the action
var PHONE=matchMedia('(max-width:700px)').matches;
function phoneSrc(){if(!PHONE)return;$$('video[data-m]').forEach(function(v){v.setAttribute('poster',v.dataset.mp);v.setAttribute('src',v.dataset.m)})}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',phoneSrc);else phoneSrc();
function fullScreen(v){try{if(v.requestFullscreen)v.requestFullscreen();else if(v.webkitEnterFullscreen)v.webkitEnterFullscreen();else if(v.webkitRequestFullscreen)v.webkitRequestFullscreen()}catch(e){}v.play().catch(function(){})}
// business picker: type-to-search dropdown, grouped
$$('.bp').forEach(function(bp){
  var d=JSON.parse(bp.getAttribute('data-bp')),line=bp.querySelector('.bp-line'),go=bp.querySelector('.bp-go'),
      inp=bp.querySelector('#bp-in'),list=bp.querySelector('.bp-list'),tog=bp.querySelector('.bp-tog'),act=-1,shown=[];
  function esc(t){return t.replace(/&/g,'&amp;').replace(/</g,'&lt;')}
  function render(q){
    q=(q||'').trim().toLowerCase();
    shown=d.filter(function(o){return !q||o.n.toLowerCase().indexOf(q)>-1||o.g.toLowerCase().indexOf(q)>-1});
    if(!shown.length)shown=d.filter(function(o){return o.n==='Something else'});
    var h='',g=null;
    shown.forEach(function(o,i){if(o.g!==g){g=o.g;h+='<li class="bp-g" role="presentation">'+esc(g)+'</li>'}
      h+='<li role="option" id="bpo'+i+'" data-i="'+i+'" class="bp-o'+(o.open?' open':'')+'">'+esc(o.n)+(o.open?'<em>Own page</em>':'')+'</li>'});
    list.innerHTML=h;act=-1;
  }
  function open(){render(inp.value);list.hidden=false;inp.setAttribute('aria-expanded','true');bp.classList.add('is-open')}
  function close(){list.hidden=true;inp.setAttribute('aria-expanded','false');bp.classList.remove('is-open')}
  function pick(o){
    inp.value=o.n;close();
    line.innerHTML='<b>For '+esc(o.n.toLowerCase())+':</b> <span>'+esc(o.l)+'.</span>';
    if(window.gsap&&!RM)gsap.fromTo(line,{autoAlpha:0,y:8},{autoAlpha:1,y:0,duration:.4});
    go.href=o.u;
    go.firstChild.nodeValue=o.open?('See it on a '+o.n.toLowerCase()+' shop '):'Get a free report on your business ';
    $$('.bp-quick button',bp).forEach(function(b){b.classList.toggle('on',b.dataset.n===o.n)});
    try{sessionStorage.setItem('bo-biz',JSON.stringify({n:o.n,g:o.g}))}catch(e){}
    if(window.boApplyBiz)boApplyBiz(o);
  }
  function hi(i){var els=$$('.bp-o',list);els.forEach(function(e){e.classList.remove('act')});if(els[i]){els[i].classList.add('act');els[i].scrollIntoView({block:'nearest'});inp.setAttribute('aria-activedescendant',els[i].id)}act=i}
  inp.addEventListener('focus',open);inp.addEventListener('click',open);
  inp.addEventListener('input',function(){open()});
  inp.addEventListener('keydown',function(e){
    if(e.key==='ArrowDown'){e.preventDefault();if(list.hidden)open();hi(Math.min(act+1,shown.length-1))}
    else if(e.key==='ArrowUp'){e.preventDefault();hi(Math.max(act-1,0))}
    else if(e.key==='Enter'){e.preventDefault();if(shown.length)pick(shown[act<0?0:act])}
    else if(e.key==='Escape'){close()}});
  tog.addEventListener('click',function(){if(list.hidden){inp.value='';open();inp.focus()}else close()});
  list.addEventListener('mousedown',function(e){e.preventDefault()});
  list.addEventListener('click',function(e){var li=e.target.closest('.bp-o');if(li)pick(shown[+li.dataset.i])});
  document.addEventListener('click',function(e){if(!bp.contains(e.target))close()});
  $$('.bp-quick button',bp).forEach(function(b){b.addEventListener('click',function(){var o=d.filter(function(x){return x.n===b.dataset.n})[0];if(o)pick(o)})});
  var first=d.filter(function(x){return x.n==='Heating & air'})[0];if(first)$$('.bp-quick button',bp)[0].classList.add('on');
});
// split-flap board
$$('.flap').forEach(function(f){
  var words=JSON.parse(f.dataset.words),w=f.querySelector('.flap-w'),L=0;
  words.forEach(function(x){L=Math.max(L,x.length)});
  L=Math.min(L,13);
  for(var i=0;i<L;i++){var c=document.createElement('i');c.textContent=' ';w.appendChild(c)}
  var cells=$$('i',w),A='ABCDEFGHIJKLMNOPQRSTUVWXYZ&',k=0;
  function show(word){word=word.slice(0,L);var pad=word+' '.repeat(L-word.length);
    cells.forEach(function(c,i){var t=pad[i];c.classList.toggle('sp',t===' '&&i>=word.length);
      if(RM){c.textContent=t;return}
      var n=0,max=4+i%5;var iv=setInterval(function(){c.textContent=n++>=max?t:A[Math.random()*A.length|0];if(n>max)clearInterval(iv)},55)})}
  show(words[0]);setInterval(function(){k=(k+1)%words.length;show(words[k])},2600);
});
// recordings: tabs, play only while on screen, auto-advance
$$('.rec').forEach(function(sec){
  var tabs=$$('.rec-tab',sec),vids=$$('.rec-v',sec),cur=0,seen=false;
  function bar(i,p){var b=tabs[i].querySelector('.bar i');if(b)b.style.width=(p*100)+'%'}
  function go(i,play){vids[cur].pause();bar(cur,0);tabs[cur].classList.remove('on');vids[cur].classList.remove('on');
    cur=i;tabs[i].classList.add('on');vids[i].classList.add('on');vids[i].preload='auto';
    try{vids[i].currentTime=0}catch(e){}
    if(play&&seen)vids[i].play().catch(function(){})}
  tabs.forEach(function(t,i){t.addEventListener('click',function(){go(i,true)})});
  var fs=sec.querySelector('.rec-fs');if(fs)fs.addEventListener('click',function(){fullScreen(vids[cur])});
  sec.querySelector('.rec-stage').addEventListener('click',function(){if(PHONE)fullScreen(vids[cur])});
  vids.forEach(function(v,i){
    v.addEventListener('timeupdate',function(){if(v.duration)bar(i,v.currentTime/v.duration)});
    v.addEventListener('ended',function(){setTimeout(function(){go((i+1)%vids.length,true)},900)});
  });
  if('IntersectionObserver' in window){new IntersectionObserver(function(es){es.forEach(function(e){
    seen=e.isIntersecting;if(seen)vids[cur].play().catch(function(){});else vids[cur].pause()})},{threshold:.35}).observe(sec.querySelector('.rec-screen'))}
});
// job presets in the old-quotes calculator
$$('.oq-pre').forEach(function(p){
  var calc=p.closest('[data-oq]'),inp=calc&&calc.querySelector('#ca');
  $$('button',p).forEach(function(b){b.addEventListener('click',function(){
    $$('button',p).forEach(function(x){x.classList.remove('on')});b.classList.add('on');
    if(!inp)return;inp.value=b.dataset.v;inp.dispatchEvent(new Event('input',{bubbles:true}));inp.dispatchEvent(new Event('change',{bubbles:true}))})});
});
// before / after drag
$$('.ba-x').forEach(function(x){var r=x.querySelector('input');
  function set(){x.style.setProperty('--p',r.value+'%')}r.addEventListener('input',set);set();
  if(window.gsap&&window.ScrollTrigger&&!RM){var o={v:50};gsap.fromTo(o,{v:0},{v:0,ease:'none',scrollTrigger:{trigger:x,start:'top 80%',end:'top 30%',scrub:true,once:false},onUpdate:function(){if(!x.dataset.touched){r.value=o.v;set()}}});
    r.addEventListener('pointerdown',function(){x.dataset.touched=1})}
});

// Booker welcome: first visit to the site, once per browser

// calculator: hide the slide hint once a bar is used, and nudge the bars once when first seen
$$('[data-oq]').forEach(function(c){
  $$('input[type=range]',c).forEach(function(r){r.addEventListener('input',function(){r.closest('.field').classList.add('used')})});
  if('IntersectionObserver' in window){var io=new IntersectionObserver(function(es){if(es[0].isIntersecting){c.classList.add('nudge');io.disconnect()}},{threshold:.5});io.observe(c)}
});

// Nov 14 9:27 pm (brains fix 5): the business a visitor picks changes the examples on the home page
var BID=['Roofing','Pools','Custom homes','Kitchens & baths','Windows & doors','Foundation repair','Docks','Painting','Fencing','Decks','Concrete','Flooring','Cabinets','Gutters','Landscaping','Commercial landscaping','Tree service','Irrigation','Hot tubs','Solar','Generators','Hardscaping and patios','Outdoor lighting','Septic services','Well drilling','Excavation and grading','Land clearing','Outdoor kitchens','Pergolas and sunrooms','Playground and turf installers','Commercial cleaning','Commercial electricians'];
var INQ=['Offices and clinics','Events, care and style'];
window.boApplyBiz=function(o){
  if(!o||!document.querySelector('.bp'))return;           // home page only
  var mode=INQ.indexOf(o.g)>-1?'inq':(BID.indexOf(o.n)>-1?'bid':'quote');
  var w={quote:['quotes and bids','Quotes or bids','quote or bid'],bid:['bids','Bids','bid'],inq:['inquiries','Inquiries','new client']}[mode];
  var h=document.querySelector('#worth h2'); if(h)h.textContent=mode==='inq'?'What are your unanswered inquiries worth?':'What are your old '+w[0]+' worth?';
  var lq=document.querySelector('label[for=cq]'); if(lq)lq.lastChild.nodeValue=w[1]+' from the last 90 days that never booked';
  var la=document.querySelector('label[for=ca]'); if(la)la.lastChild.nodeValue=mode==='inq'?'What a new client is worth to you':'Your average '+w[2];
  var steps=document.querySelectorAll('.calc-how li span');
  if(steps[0])steps[0].textContent='Slide the first bar to how many '+(mode==='inq'?'inquiries never turned into a booking':w[0]+' went quiet')+' in the last 90 days.';
  if(steps[1])steps[1].textContent='Slide the second bar to '+(mode==='inq'?'what a new client is worth to you.':'your average '+w[2]+'.');
  var cb=document.querySelector('[data-oq]'); if(cb){cb.setAttribute('data-w',mode==='inq'?'inquiries':(mode==='bid'?'bids':'quotes'));cb.setAttribute('data-j',mode==='inq'?'new clients':'jobs');var r=cb.querySelector('#cq');if(r)r.dispatchEvent(new Event('input',{bubbles:true}));}
  var sec=document.querySelector('.rec'); if(!sec)return;
  var tab=sec.querySelector('.rec-tab'), v=sec.querySelector('.rec-v'); if(!tab||!v)return;
  if(!v.dataset.orig)v.dataset.orig=JSON.stringify([tab.querySelector('b').textContent,tab.querySelector('small').textContent,v.getAttribute('src'),v.getAttribute('poster'),v.dataset.m,v.dataset.mp]);
  var org=JSON.parse(v.dataset.orig), P=matchMedia('(max-width:700px)').matches, src, pos;
  if(mode==='inq'){tab.querySelector('b').textContent='New inquiry answered';tab.querySelector('small').textContent='A new inquiry gets a full answer the same day, with times to pick. It gets booked.';
    src='assets/rec/office-inquiry'+(P?'-p':'')+'.mp4';pos='assets/rec/office-inquiry'+(P?'-p':'')+'.jpg';}
  else{tab.querySelector('b').textContent=mode==='bid'?'Old bid followed up':org[0];tab.querySelector('small').textContent=mode==='bid'?'A bid that went quiet gets a note from you, the customer writes back, and the job is booked.':org[1];
    src=P?org[4]:org[2];pos=P?org[5]:org[3];}
  if(v.getAttribute('src')!==src){v.setAttribute('src',src);v.setAttribute('poster',pos);try{v.load()}catch(e){}}
  var lead=sec.querySelector('.head .lead'); if(lead&&!lead.dataset.orig)lead.dataset.orig=lead.textContent;
  if(lead)lead.textContent=mode==='inq'?'Recorded from example screens for Smith & Reed Law and Smith Heating, example businesses with made-up customers and numbers. Yours would carry your name and your way of writing.':lead.dataset.orig;
};
function boBizInit(){var o=null;try{o=JSON.parse(sessionStorage.getItem('bo-biz')||'null')}catch(e){}
  if(o){var bp=document.querySelector('.bp');if(bp){var d=JSON.parse(bp.getAttribute('data-bp'));var m=d.filter(function(x){return x.n===o.n})[0];if(m){var inp=bp.querySelector('#bp-in');if(inp)inp.value=m.n;var line=bp.querySelector('.bp-line');if(line)line.innerHTML='<b>For '+m.n.toLowerCase().replace(/&/g,'&amp;')+':</b> <span>'+m.l+'.</span>';boApplyBiz(m);}}}}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boBizInit);else boBizInit();
function boWelcome(){
  var bw=document.getElementById('bw');if(!bw)return;
  var vid=bw.querySelector('video'),ty=bw.querySelector('.bw-type'),full=ty.dataset.t,timer=null,lastFocus=null;
  function seen(){try{return sessionStorage.getItem('bo-hi')==='1'}catch(e){return false}}
  function mark(){try{sessionStorage.setItem('bo-hi','1')}catch(e){}}
  function type(){clearInterval(timer);if(RM){ty.textContent=full;return}var i=0;ty.textContent='';
    timer=setInterval(function(){i+=2;ty.textContent=full.slice(0,i);if(i>=full.length)clearInterval(timer)},22)}
  function show(){lastFocus=document.activeElement;bw.hidden=false;document.documentElement.classList.add('bw-on');if(window.boLenis)boLenis.stop();
    requestAnimationFrame(function(){bw.classList.add('in')});type();mark();
    vid.preload='auto';setTimeout(function(){vid.play().catch(function(){})},RM?0:900);
    bw.querySelector('.bw-go').focus({preventScroll:true})}
  function hide(go){vid.pause();bw.classList.remove('in');document.documentElement.classList.remove('bw-on');if(window.boLenis)boLenis.start();
    setTimeout(function(){bw.hidden=true},350);
    if(go){var t=document.getElementById('week')||document.querySelector('main section:nth-of-type(2)');if(t){if(window.boLenis)boLenis.scrollTo(t,{offset:0});else t.scrollIntoView({behavior:RM?'auto':'smooth'})}}
    else if(lastFocus&&lastFocus.focus)lastFocus.focus({preventScroll:true})}
  $$('[data-x]',bw).forEach(function(x){x.addEventListener('click',function(){hide(false)})});
  bw.querySelector('.bw-go').addEventListener('click',function(){hide(true)});
  bw.querySelector('.bw-ask').addEventListener('click',function(){hide(false);setTimeout(function(){if(window.bosOpenChat)bosOpenChat()},380)});
  // when Booker finishes, he leaves on his own so the site shows
  vid.addEventListener('click',function(){if(PHONE)fullScreen(vid)});
  vid.addEventListener('ended',function(){if(!bw.hidden)setTimeout(function(){if(!bw.hidden)hide(false)},1200)});
  document.addEventListener('keydown',function(e){if(e.key==='Escape'&&!bw.hidden)hide(false)});
  $$('.bw-replay').forEach(function(b){b.addEventListener('click',function(){try{vid.currentTime=0}catch(e){}show()})});
  if(!seen()&&!/[?&]nohi/.test(location.search)){
    var t0=Date.now();(function wait(){var l=document.getElementById('bo-loader');
      if((l&&document.body.contains(l)&&l.classList.contains('on'))&&Date.now()-t0<6000)return setTimeout(wait,200);
      setTimeout(show,3000)})();
  }
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boWelcome);else boWelcome();
})();
// Nov 14 9:27 pm (brains fix 7): one bottom bar on phones, with the free report and Ask Booker side by side
(function(){
  function go(){
    if(!matchMedia('(max-width:700px)').matches)return;
    var bar=document.querySelector('.phonebar'); if(!bar||bar.querySelector('.pb-ask'))return;
    var sp=bar.querySelector('span'); if(sp)sp.textContent='Free report. Nothing to pay.';
    var b=document.createElement('button'); b.type='button'; b.className='pb-ask'; b.innerHTML='<span class="bk-dot">B</span>Ask Booker';
    b.addEventListener('click',function(){if(window.bosOpenChat)bosOpenChat()});
    var g=bar.querySelector('.btn'); bar.insertBefore(b,g); document.documentElement.classList.add('one-bar');
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',go);else go();
})();
