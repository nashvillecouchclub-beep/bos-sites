/* Booked Out Solutions - website v2. Small, no libraries, no trackers. */
(function () {
  "use strict";
  var d = document, root = d.documentElement;
  var still = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  function all(s, el) { return Array.prototype.slice.call((el || d).querySelectorAll(s)); }
  function money(n) { return "$" + Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ","); }

  /* mobile menu */
  var burger = d.querySelector(".burger");
  if (burger) {
    burger.addEventListener("click", function () {
      var open = root.classList.toggle("menu-open");
      burger.setAttribute("aria-expanded", open ? "true" : "false");
    });
    all(".mobile-menu a").forEach(function (a) { a.addEventListener("click", function () { root.classList.remove("menu-open"); }); });
  }
  all(".drop > button").forEach(function (b) {
    b.addEventListener("click", function () { b.parentNode.classList.toggle("open"); });
  });

  /* count-ups */
  function countUp(el) {
    if (el.__done) return; el.__done = true;
    var end = parseFloat(el.getAttribute("data-count")), pre = el.getAttribute("data-pre") || "", suf = el.getAttribute("data-suf") || "";
    var dec = (el.getAttribute("data-count").split(".")[1] || "").length;
    function fmt(v) { var s = dec ? v.toFixed(dec) : Math.round(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ","); return pre + s + suf; }
    if (still) { el.textContent = fmt(end); return; }
    var t0 = null, dur = 1300;
    function step(t) {
      if (!t0) t0 = t;
      var p = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - p, 3);
      el.textContent = fmt(end * e);
      if (p < 1) requestAnimationFrame(step); else el.textContent = fmt(end);
    }
    requestAnimationFrame(step);
  }

  /* reveal on scroll */
  var watched = all(".rv, .chart, .weeklist, [data-count]");
  function show(el) {
    el.classList.add("in");
    if (el.hasAttribute("data-count")) countUp(el);
    all("[data-count]", el).forEach(countUp);
  }
  if (!("IntersectionObserver" in window) || still) {
    watched.forEach(show);
  } else {
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (e) { if (e.isIntersecting) { show(e.target); io.unobserve(e.target); } });
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.08 });
    watched.forEach(function (el) { io.observe(el); });
    /* safety net: never leave anything hidden */
    setTimeout(function () { watched.forEach(function (el) { var r = el.getBoundingClientRect(); if (r.top < window.innerHeight) show(el); }); }, 1200);
  }

  /* phone bar shows after the first screen */
  var bar = d.querySelector(".phonebar");
  if (bar) {
    var onScroll = function () { bar.classList.toggle("show", window.scrollY > 520); };
    window.addEventListener("scroll", onScroll, { passive: true }); onScroll();
  }

  /* package tabs */
  all("[data-tabs]").forEach(function (box) {
    var btns = all("[role=tab]", box), panels = all(".pk-panel", box);
    btns.forEach(function (b, i) {
      b.addEventListener("click", function () {
        btns.forEach(function (x, j) { x.setAttribute("aria-selected", i === j ? "true" : "false"); });
        panels.forEach(function (p, j) { p.hidden = i !== j; });
      });
    });
  });

  /* free look form: opens the owner's own email, filled in */
  var form = d.querySelector("[data-lookform]");
  if (form) {
    var q = /[?&]trade=([a-z]+)/.exec(location.search || "");
    if (q) { var map = { hvac: "Heating and air", plumbing: "Plumbing", electrical: "Electrical" }, sel = form.querySelector("[name=trade]"); if (map[q[1]] && sel) sel.value = map[q[1]]; }
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      if (form.querySelector(".hp").value) return;
      var need = ["name", "shop", "town"], ok = true;
      need.forEach(function (n) { var f = form.querySelector("[name=" + n + "]"); if (!f.value.trim()) { ok = false; f.style.borderColor = "#E5484D"; } else f.style.borderColor = ""; });
      if (!ok) { var first = form.querySelector("[name=name]"); if (first) first.focus(); return; }
      function v(n) { var f = form.querySelector("[name=" + n + "]"); return f && f.value ? f.value.trim() : ""; }
      var lines = ["Hi Rickey,", "", "Please send my free look.", "", "Name: " + v("name"), "Shop: " + v("shop"), "Trade: " + v("trade"), "Town: " + v("town")];
      if (v("jobs")) lines.push("Jobs a week: " + v("jobs"));
      lines.push("Costing me most: " + v("problem"));
      if (v("decides")) lines.push("Who decides: " + v("decides"));
      if (v("start")) lines.push("Could start this month: " + v("start"));
      if (v("note")) lines.push("Note: " + v("note"));
      var href = "mailto:" + form.getAttribute("data-to") + "?subject=" + encodeURIComponent("Free look for " + v("shop")) + "&body=" + encodeURIComponent(lines.join("\n"));
      var note = d.getElementById("sent-note"); if (note) note.hidden = false;
      try { window.location.href = href; } catch (e) { /* the note above tells them what to do */ }
    });
  }

  /* calculator on the sample check page */
  all("[data-calc]").forEach(function (c) {
    var job = c.querySelector("[name=job]"), lost = c.querySelector("[name=lost]"), out = c.querySelector("output");
    function run() {
      c.querySelector("[data-job]").textContent = money(+job.value);
      c.querySelector("[data-lost]").textContent = lost.value;
      out.textContent = money(job.value * lost.value * 52 / 12);
    }
    job.addEventListener("input", run); lost.addEventListener("input", run); run();
  });

  /* pick what you want (private price pages) */
  var pick = d.querySelector("[data-pick]");
  if (pick) {
    var data = JSON.parse(pick.getAttribute("data-pick"));
    var boxes = all("input[data-level]", pick);
    var update = function () {
      var has = {}; boxes.forEach(function (b) { if (b.checked) has[b.getAttribute("data-level")] = 1; });
      var k = has.office || (has.ads && has.metro) ? "complete" : has.ads ? "ads" : has.metro ? "metro_lock" : "core";
      all("[data-pick-name]").forEach(function (e) { e.textContent = data[k].name; });
      all("[data-pick-price]").forEach(function (e) { e.textContent = data[k].line; });
      all("[data-pick-day]").forEach(function (e) { e.textContent = data[k].day; });
      all(".pkg").forEach(function (p) { p.classList.toggle("on", p.getAttribute("data-pkg") === k); });
      var pb = d.getElementById("pay"); if (pb && data[k].pay) pb.setAttribute("data-href", data[k].pay);
    };
    boxes.forEach(function (b) { b.addEventListener("change", update); }); update();
    var agree = d.getElementById("agree"), pay = d.getElementById("pay");
    if (agree && pay) {
      var setPay = function () {
        var on = agree.checked && pay.getAttribute("data-href");
        if (on) { pay.href = pay.getAttribute("data-href"); pay.removeAttribute("aria-disabled"); pay.style.opacity = ""; pay.style.pointerEvents = ""; }
        else { pay.href = "#price"; pay.setAttribute("aria-disabled", "true"); pay.style.opacity = ".5"; pay.style.pointerEvents = "none"; }
      };
      agree.addEventListener("change", setPay);
      boxes.forEach(function (b) { b.addEventListener("change", setPay); }); setPay();
    }
  }
})();

/* Nov 11: website chat. Shows a small "Questions?" bubble after 2 minutes on the site.
   Only runs when the page has data-chat (the answer service address). The assistant says it is automated. */
(function () {
  var url = document.body && document.body.getAttribute("data-chat");
  if (!url) return;
  var trade = document.body.getAttribute("data-chat-trade") || "";
  var KEY = "bos-chat-seen", msgs = [];
  function el(t, c, h) { var e = document.createElement(t); if (c) e.className = c; if (h) e.innerHTML = h; return e; }
  var box = el("div", "chat"), bubble = el("button", "chat-bubble", "Questions? Ask me anything about Booked Out");
  bubble.type = "button";
  var panel = el("div", "chat-panel");
  panel.innerHTML = '<div class="chat-head"><b>Booker</b><span>Booked Out&rsquo;s AI assistant. Rickey reads every chat.</span><button type="button" class="chat-x" aria-label="Close chat">&times;</button></div>' +
    '<div class="chat-log" aria-live="polite"></div><form class="chat-form"><input class="chat-in" maxlength="600" placeholder="Type your question" aria-label="Your question"><button class="btn small" type="submit">Send</button></form>';
  box.appendChild(panel); box.appendChild(bubble);
  var log = panel.querySelector(".chat-log");
  function add(who, text) { var m = el("div", "chat-m " + who); m.textContent = text; log.appendChild(m); log.scrollTop = log.scrollHeight; }
  function open() { box.classList.add("open"); try { sessionStorage.setItem(KEY, "1"); } catch (e) {} if (!log.children.length) add("bot", "Hi, I'm Booker, Booked Out's AI assistant. Ask me anything: what we do, the packages, the free look, how it works."); panel.querySelector(".chat-in").focus(); }
  bubble.addEventListener("click", open);
  window.bosOpenChat = function () { box.classList.add("show"); open(); };
  panel.querySelector(".chat-x").addEventListener("click", function () { box.classList.remove("open"); });
  panel.querySelector(".chat-form").addEventListener("submit", function (ev) {
    ev.preventDefault(); var inp = panel.querySelector(".chat-in"), q = inp.value.trim(); if (!q) return;
    inp.value = ""; add("me", q); msgs.push({ role: "user", content: q }); add("bot wait", "...");
    fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: msgs.slice(-12), trade: trade, page: location.pathname }) })
      .then(function (r) { return r.json(); })
      .then(function (d) { log.lastChild.remove(); var a = (d && d.answer) || "Sorry, I couldn't answer that just now. Email hello@getbookedoutsolutions.com and Rickey will write back."; add("bot", a); msgs.push({ role: "assistant", content: a }); })
      .catch(function () { log.lastChild.remove(); add("bot", "Sorry, the chat isn't reachable right now. Email hello@getbookedoutsolutions.com and Rickey will write back."); });
  });
  document.body.appendChild(box);
  var seen = false; try { seen = sessionStorage.getItem(KEY) === "1"; } catch (e) {}
  setTimeout(function () { box.classList.add("show"); }, seen ? 1000 : 120000);
})();

/* Nov 11: tap a line in the one-week list to open its details */
(function(){
  document.addEventListener("click", function(ev){
    var li = ev.target.closest ? ev.target.closest(".weeklist li.wl-x") : null; if (!li) return;
    var on = !li.classList.contains("open"); li.classList.toggle("open", on); li.setAttribute("aria-expanded", on ? "true" : "false");
  });
  document.addEventListener("keydown", function(ev){
    if (ev.key !== "Enter" && ev.key !== " ") return;
    var li = ev.target.closest ? ev.target.closest(".weeklist li.wl-x") : null; if (!li) return;
    ev.preventDefault(); li.click();
  });
})();

/* Nov 11: "Ask Booker" buttons open the chat when it's live; otherwise they call Booker's line or email */
document.addEventListener("click", function (ev) {
  var a = ev.target.closest ? ev.target.closest("[data-booker]") : null; if (!a) return;
  if (window.bosOpenChat) { ev.preventDefault(); window.bosOpenChat(); }
});
