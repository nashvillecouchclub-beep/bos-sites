/* Booker, our AI assistant: a helper button in the corner, not the opening act.
   In the private preview his brain and voice are Claude's stand-ins; at go-live
   they switch to our Amazon setup. Text answers always work (fallback lines). */
(function () {
  "use strict";
  var d = document;
  var html =
    '<button class="bk-fab" type="button" aria-expanded="false" aria-controls="bk-panel"><span class="bk-dot">B</span><span>Ask Booker<small>Questions, any time</small></span></button>' +
    '<div class="bk-panel" id="bk-panel" role="dialog" aria-label="Chat with Booker, our AI assistant">' +
    '<div class="bk-head"><span class="bk-dot" style="width:38px;height:38px;border-radius:50%;background:var(--goldgrad);display:grid;place-items:center;color:var(--ink);font:800 16px/1 var(--disp)">B</span><span><b>Booker</b><small>Booked Out\'s AI assistant</small></span><button type="button" aria-label="Close chat">&times;</button></div>' +
    '<div class="bk-log" id="bk-log" aria-live="polite"></div>' +
    '<form class="bk-row" id="bk-form"><label for="bk-in" class="sr">Message Booker</label><input id="bk-in" autocomplete="off" placeholder="Type a question"><button class="talk" type="button" id="bk-talk">Talk</button><button type="submit">Send</button></form>' +
    '<p class="bk-fine">Booker is an AI assistant, never a person. He never asks for anything private and hands anything he can\'t answer to Rickey by email.</p></div>';
  var wrap = d.createElement("div"); wrap.innerHTML = html; while (wrap.firstChild) d.body.appendChild(wrap.firstChild);
  var fab = d.querySelector(".bk-fab"), panel = d.getElementById("bk-panel"), log = d.getElementById("bk-log");
  var form = d.getElementById("bk-form"), input = d.getElementById("bk-in"), talkBtn = d.getElementById("bk-talk");

  /* show the button once the visitor has started reading, never on top of the first screen */
  function onScroll() { if (window.scrollY > window.innerHeight * 0.75) { fab.classList.add("up"); window.removeEventListener("scroll", onScroll); } }
  window.addEventListener("scroll", onScroll, { passive: true }); onScroll();
  setTimeout(function () { fab.classList.add("up"); }, 20000);

  var opened = false;
  function toggle(open) {
    panel.classList.toggle("open", open); fab.setAttribute("aria-expanded", open ? "true" : "false");
    if (open && !opened) { opened = true; add("b", OPENING); }
    if (open) setTimeout(function () { input.focus({ preventScroll: true }); }, 300);
  }
  fab.addEventListener("click", function () { toggle(!panel.classList.contains("open")); });
  panel.querySelector(".bk-head button").addEventListener("click", function () { toggle(false); });
  d.addEventListener("keydown", function (e) { if (e.key === "Escape") toggle(false); });
  window.bosOpenChat = function () { toggle(true); };
  d.querySelectorAll('[data-booker]').forEach(function (a) { a.addEventListener("click", function (e) { e.preventDefault(); toggle(true); }); });

  var OPENING = "Hey, I'm Booker, the AI assistant here at Booked Out Solutions. Ask me anything about what we do for your shop. You can type, or tap Talk and just say it. What's going on with your business?";
  var FACTS = [
    "You are Booker, the AI assistant for Booked Out Solutions (Smyrna, Tennessee). Always say you are Booker, our AI assistant, if asked who or what you are. Never claim or imply you are a person.",
    "Personality: a calm, friendly shop foreman in his late 40s. Plain words, a little dry humor, never pushy. Speak in 1 to 3 short sentences. End with one simple question when it helps.",
    "Reply in the language the visitor writes in (Spanish and others).",
    "What we do for heating and air, plumbing and electrical shops: old quotes from the last 90 days followed up from the shop in its own style; every new quote gets a first note within 2 business days; every customer asked for a Google review and every review answered in the shop's style; Google profile filled in and posted on weekly; email and website inquiries answered the same day; past customers reached in season; 100 postcards a month; a report every Friday. Bigger packages add Google Ads and Local Services Ads managed, an AI receptionist that answers the shop's calls when nobody can, a full website, and the area locked to one shop per trade.",
    "Price, only if asked, and only for these trades (heating and air, plumbing, electrical): Booked Out Core: Start free for 30 days. Then $497 for your second 30 days, and $997 every 30 days after that. No contract. Cancel anytime with one reply. For other packages or other trades, say Rickey sends the exact price page by email. Never invent or discount a price.",
    "The free report: a free one-page report on their own shop built from their real Google listing. Ask for it on the Free report page or by emailing hello@getbookedoutsolutions.com with shop name and town. It arrives within 1 business day.",
    "Rules: we promise the work, never results; never promise jobs, rankings or numbers. We never write or buy reviews. Everything happens by email; no sales calls. Rickey Hallor owns the company and owned four dry cleaners before. Never ask for health, payment, password or other private details. If you can't answer, or they want a person, say you'll pass it to Rickey by email and give rickey@getbookedoutsolutions.com."
  ].join("\n");
  var FALLBACK = [
    [/price|cost|how much|cuesta|precio/i, "For heating and air, plumbing and electrical shops: start free for 30 days, then $497 for your second 30 days, and $997 every 30 days after that. No contract, cancel anytime with one reply. Which trade are you in?"],
    [/contract|cancel/i, "No contract. Reply \"cancel\" to any email and nothing more is charged. Anything else on your mind?"],
    [/human|person|real|ai\b|robot/i, "I'm Booker, Booked Out's AI assistant, not a person. If you'd like Rickey, email rickey@getbookedoutsolutions.com and he'll write back."],
    [/free report|free look|free/i, "The free report is a one-page report on your own shop, built from your real Google listing. Ask for it on the Free report page and it lands in your inbox within 1 business day."],
    [/./, "Good question. My full brain switches on when the site goes live. For now, Rickey can answer that by email at rickey@getbookedoutsolutions.com. What trade is your shop in?"]
  ];
  var history = [];
  function add(who, text) {
    var b = d.createElement("div"); b.className = "bubble " + (who === "b" ? "b" : "u");
    var s = d.createElement("small"); s.textContent = who === "b" ? "Booker, AI assistant" : "You"; b.appendChild(s);
    var p = d.createElement("span"); p.textContent = text; b.appendChild(p); log.appendChild(b); log.scrollTop = log.scrollHeight; return p;
  }
  var has = window.claude && claude.use;
  var ttsP = has ? claude.use("tts").catch(function () { return null; }) : Promise.resolve(null);
  var dicP = has ? claude.use("dictation").catch(function () { return null; }) : Promise.resolve(null);
  var smpP = has ? claude.use("sample").catch(function () { return null; }) : Promise.resolve(null);
  function speak(text) { return ttsP.then(function (t) { if (t) return t.speak(text, { voice: "rounded", rate: 0.95 }).catch(function () {}); }); }
  var dic = null, listening = false, partialEl = null, talking = false;
  dicP.then(function (x) { dic = x; if (!x) return;
    x.onPartial(function (e) { if (!partialEl) partialEl = add("u", ""); partialEl.textContent = e.text; });
    x.onFinal(function (e) { var t = e.text.trim(); if (partialEl) { partialEl.textContent = t; partialEl = null; } else if (t) add("u", t); if (t) ask(t, true); });
    x.onState(function (e) { listening = e.state === "listening"; talkBtn.textContent = listening ? "Stop" : "Talk"; });
  });
  talkBtn.addEventListener("click", function () {
    if (!dic) { add("b", "Talking out loud isn't on in this browser yet. Just type below and I'll answer."); input.focus(); return; }
    if (listening) { dic.stop().catch(function () {}); return; }
    talking = true; dic.start().catch(function () { add("b", "I couldn't hear you just then. Tap Talk again, or type below."); });
  });
  form.addEventListener("submit", function (e) { e.preventDefault(); var t = input.value.trim(); if (!t) return; input.value = ""; add("u", t); ask(t, false); });
  var busy = false;
  function ask(text, spoken) {
    if (busy) return; busy = true; history.push({ role: "user", content: text });
    var el = add("b", "…");
    smpP.then(function (sample) {
      if (!sample) throw 0;
      var msgs = [{ role: "user", content: "INSTRUCTIONS (follow exactly):\n" + FACTS + "\n\nThe conversation so far follows. Reply as Booker to the last visitor message only." }, { role: "assistant", content: "Understood. I am Booker, Booked Out's AI assistant." }].concat(history.slice(-10));
      return sample(msgs, { modelTier: "quick", cache: false, onText: function (u) { el.textContent = u.text; log.scrollTop = log.scrollHeight; } }).then(function (r) { return r.text; });
    }).catch(function () { for (var i = 0; i < FALLBACK.length; i++) if (FALLBACK[i][0].test(text)) return FALLBACK[i][1]; })
      .then(function (a) { el.textContent = a; history.push({ role: "assistant", content: a }); busy = false; if (spoken || talking) speak(a); });
  }
})();
