(function(){
  try{if("scrollRestoration" in history)history.scrollRestoration="manual";}catch(e){}
  function top(){try{window.scrollTo({top:0,left:0,behavior:"instant"});document.body.scrollIntoView({block:"start",behavior:"instant"});}catch(e){}}
  if(!location.hash){top();window.addEventListener("load",top);}
  document.querySelectorAll("a[href$='.html']").forEach(function(a){a.addEventListener("click",function(){try{window.scrollTo({top:0,left:0,behavior:"instant"});}catch(e){}});});
  var btn=document.getElementById('menuBtn'),nav=document.getElementById('mainNav');
  if(btn){btn.addEventListener('click',function(){var o=nav.classList.toggle('open');btn.setAttribute('aria-expanded',o);btn.setAttribute('aria-label',o?'Close menu':'Open menu')});}
  var tn=document.getElementById('tnCheck');
  if(tn){var ans=document.getElementById('tnAnswer');tn.querySelectorAll('[data-tn]').forEach(function(b){b.addEventListener('click',function(){
    ans.hidden=false;ans.textContent=b.dataset.tn==='yes'?"Great. Telehealth works for you. You can book a free 15-minute consult to get started.":"I can only see people who are physically in Tennessee during the session. If you'll be in Tennessee some weeks, we can meet then, or in person in Murfreesboro. Otherwise I'm glad to help you find a therapist licensed where you'll be.";});});}
  document.querySelectorAll("a[href^='mailto:']").forEach(function(a){a.addEventListener("click",function(){
    var addr=a.getAttribute("href").slice(7).split("?")[0];
    try{if(navigator.clipboard)navigator.clipboard.writeText(addr);}catch(e){}
    var t=document.getElementById("copyToast");
    if(!t){t=document.createElement("div");t.id="copyToast";t.className="copy-toast";t.setAttribute("role","status");document.body.appendChild(t);}
    t.textContent="Email copied: "+addr;t.classList.add("show");clearTimeout(t._h);t._h=setTimeout(function(){t.classList.remove("show")},3500);
  });});
})();
