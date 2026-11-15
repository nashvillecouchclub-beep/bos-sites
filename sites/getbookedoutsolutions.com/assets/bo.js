/* Booked Out Solutions - motion layer v3 (Nov 14 2026 night build).
   GSAP + ScrollTrigger + SplitText + Lenis, all self-hosted. Everything degrades:
   no JS or "reduce motion" shows the full page, still, with every word on it. */
(function () {
  "use strict";
  var d = document, root = d.documentElement, W = window;
  /* Nov 14 9:04 pm (Rickey): a new page always opens at the top, unless the link points to a section */
  try { history.scrollRestoration = "manual"; } catch (e) {}
  var touched = false; ["wheel", "touchstart", "keydown", "mousedown"].forEach(function (ev) { W.addEventListener(ev, function () { touched = true; }, { passive: true, once: true }); });
  var toTop = function () { if (location.hash || touched) return; if (W.boLenis) W.boLenis.scrollTo(0, { immediate: true, force: true }); W.scrollTo(0, 0); };
  toTop();
  W.addEventListener("DOMContentLoaded", toTop);
  W.addEventListener("load", function () { toTop(); setTimeout(toTop, 80); setTimeout(toTop, 300); });
  W.addEventListener("pageshow", function (e) { if (!e.persisted) toTop(); });
  var reduce = W.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var fine = W.matchMedia("(pointer: fine)").matches;
  var desk = function () { return W.innerWidth >= 1000; };
  var G = W.gsap, ST = W.ScrollTrigger;
  if (G) { G.registerPlugin(ST); if (W.SplitText) G.registerPlugin(W.SplitText); if (W.ScrambleTextPlugin) G.registerPlugin(W.ScrambleTextPlugin); }
  function $(s, el) { return (el || d).querySelector(s); }
  function $$(s, el) { return Array.prototype.slice.call((el || d).querySelectorAll(s)); }
  var clamp = function (v, a, b) { return Math.min(b === undefined ? 1 : b, Math.max(a || 0, v)); };
  var o3 = function (k) { return 1 - Math.pow(1 - k, 3); };

  /* ---------- 1. loader: first visit in a session only */
  var loader = $("#bo-loader"), seen = false;
  try { seen = sessionStorage.getItem("bo-seen") === "1"; sessionStorage.setItem("bo-seen", "1"); } catch (e) { seen = true; }
  var introDone = new Promise(function (res) {
    if (!loader || seen || reduce || !G || performance.now() > 1400) { res(); return; }
    loader.classList.add("on");
    var ring = $("#bl-ring", loader), pct = $(".bl-pct", loader), st = { p: 0 }, len = 289;
    var t0 = performance.now();
    G.to(st, { p: 100, duration: 0.85, ease: "power2.inOut", onUpdate: function () {
      if (ring) ring.style.strokeDashoffset = len * (1 - st.p / 100);
      if (pct) pct.textContent = String(Math.round(st.p)).padStart(3, "0");
    }, onComplete: function () {
      (d.fonts && d.fonts.ready ? Promise.race([d.fonts.ready, new Promise(function (r) { setTimeout(r, 350); })]) : Promise.resolve()).then(function () {
        G.to(loader, { yPercent: -100, duration: 0.9, ease: "expo.inOut", onComplete: function () { loader.remove(); } });
        setTimeout(res, 350);
      });
    } });
  });

  if (!G || !ST) { $$(".sstep").forEach(function (s) { s.classList.add("on"); }); $$(".msg").forEach(function (m) { m.classList.add("show"); }); return; }

  /* ---------- 2. smooth scroll (mouse and trackpad only; phones keep native scroll) */
  var lenis = null;
  if (!reduce && fine && W.Lenis) {
    lenis = new W.Lenis({ lerp: 0.095, smoothWheel: true, anchors: { offset: 0 } }); W.boLenis = lenis; toTop();
    lenis.on("scroll", ST.update);
    G.ticker.add(function (t) { lenis.raf(t * 1000); });
    G.ticker.lagSmoothing(0);
  }

  /* ---------- 3. header that steps aside, and a hairline of progress */
  var top = $(".top"), lastY = 0, prog = d.createElement("div");
  prog.className = "bo-prog"; d.body.appendChild(prog);
  function onScroll() {
    var y = W.scrollY, H = root.scrollHeight - W.innerHeight;
    prog.style.transform = "scaleX(" + (H > 0 ? y / H : 0) + ")";
    if (top && !root.classList.contains("menu-open")) {
      if (y > lastY + 6 && y > 240) top.classList.add("bo-hide");
      else if (y < lastY - 6 || y < 120) top.classList.remove("bo-hide");
    }
    lastY = y;
  }
  W.addEventListener("scroll", onScroll, { passive: true });

  /* ---------- 4. headlines rise word by word (masked) */
  var heads = $$("main h1, main .sec h2, main .story h2, main .world h2").filter(function (h) { return !h.closest(".faq") && !h.closest(".dash") && !h.closest(".ui"); });
  heads.forEach(function (h) { h.classList.remove("rv"); });
  function splitRise(h, delay, immediate) {
    if (reduce || !W.SplitText) return;
    var sp = W.SplitText.create(h, { type: "words", mask: "words", wordsClass: "bo-wd" });
    var tw = { yPercent: 112, rotate: 3, duration: 1.05, ease: "power4.out", stagger: 0.045, delay: delay || 0 };
    if (!immediate) tw.scrollTrigger = { trigger: h, start: "top 88%", once: true };
    G.from(sp.words, tw);
  }

  /* ---------- 5. magnetic buttons, cursor, card spotlight (fine pointers only) */
  if (fine && !reduce) {
    $$(".btn, .w-trade, .bk-fab").forEach(function (el) {
      var strength = el.classList.contains("w-trade") ? 0.12 : 0.3;
      el.addEventListener("pointermove", function (e) {
        var r = el.getBoundingClientRect();
        G.to(el, { x: (e.clientX - r.left - r.width / 2) * strength, y: (e.clientY - r.top - r.height / 2) * strength, duration: 0.4, ease: "power3.out" });
      });
      el.addEventListener("pointerleave", function () { G.to(el, { x: 0, y: 0, duration: 0.9, ease: "elastic.out(1,0.4)" }); });
    });
    var c1 = d.createElement("div"), c2 = d.createElement("div");
    c1.className = "bo-cur"; c2.className = "bo-cur2"; d.body.appendChild(c1); d.body.appendChild(c2); root.classList.add("bo-cursor");
    var mx = -100, my = -100, rx = -100, ry = -100;
    W.addEventListener("pointermove", function (e) { mx = e.clientX; my = e.clientY; c1.style.transform = "translate(" + mx + "px," + my + "px)"; }, { passive: true });
    G.ticker.add(function () { rx += (mx - rx) * 0.18; ry += (my - ry) * 0.18; c2.style.transform = "translate(" + rx + "px," + ry + "px)"; });
    d.addEventListener("pointerover", function (e) { c2.classList.toggle("big", !!(e.target.closest && e.target.closest("a,button,summary,.cell,input,select,label,.w-trade"))); });
    $$(".cell").forEach(function (c) {
      c.addEventListener("pointermove", function (e) { var r = c.getBoundingClientRect(); c.style.setProperty("--mx", (e.clientX - r.left) + "px"); c.style.setProperty("--my", (e.clientY - r.top) + "px"); });
    });
  }

  /* ---------- 6. THE WORLD: the live calendar stamps BOOKED as you scroll */
  var world = $(".world"), wc = $(".w-cal");
  var worldReady = function () {};
  if (world && wc && W.BOLogo) {
    var css = d.createElement("style"); css.textContent = W.BOLogo.css; d.head.appendChild(css);
    var stage = $(".bo-stage", wc), board = $(".bo-board", wc), sc = $(".sc", wc), ringo = $(".ringo", wc);
    var api = W.BOLogo.build(board, { date: new Date(), side: fine ? 12 : 6, thick: fine ? 14 : 8 });
    var R = api.rest, fut = [];
    api.months.forEach(function (m, i) { if (m.off >= 0) fut.push(i); });
    var N = fut.length, meter = $(".w-meter b", world);
    function fit() { stage.style.transform = "scale(" + (wc.clientWidth / 1080) + ")"; }
    fit(); W.addEventListener("resize", fit);
    var state = { p: 0, x: 0 }, last = [];
    function render() {
      var stamped = 0;
      for (var i = 0; i < api.count; i++) {
        var m = api.months[i], s;
        if (m.off < 0) s = Object.assign(R("past"), { x: state.x });
        else {
          var j = fut.indexOf(i), k = clamp(state.p * N - j);
          if (k <= 0) s = R("open");
          else {
            s = Object.assign(R("book"), { stamp: k, open: 1 - clamp(k * 3), lift: 10 + 16 * o3(clamp(k * 1.3)), burst: k < 1 ? clamp((k - 0.55) / 0.45) : 0, glow: k < 1 ? 0.8 : 0.15 });
            if (k > 0.6) stamped++;
          }
        }
        var key = JSON.stringify(s); if (key !== last[i]) { api.set(i, s); last[i] = key; }
      }
      if (meter) meter.textContent = stamped + " of " + N;
    }
    var base = Math.min(3, N) / N;
    if (reduce) { state.p = 1; state.x = 2; render(); }
    else {
      render();
      worldReady = function () {
        /* Nov 14 8:39 pm (Rickey): starts at one booked month and fills the rest in on its own, no scrolling needed */
        var one = 1 / N, tl = G.timeline({ repeat: -1, repeatDelay: 0.4, paused: true }), started = false, onScreen = true;
        G.timeline().to(state, { x: 2, duration: 1.2, ease: "power2.inOut", onUpdate: render })
          .to(state, { p: one, duration: 0.7, ease: "power1.inOut", onUpdate: render }, "-=0.3")
          .from(".w-cap i", { scaleX: 0, duration: 1, ease: "expo.out", stagger: 0.15 }, "-=0.6")
          .from(".w-cap", { opacity: 0, duration: 0.6, stagger: 0.15 }, "<")
          .add(function () { started = true; if (onScreen) tl.play(0); });
        tl.to({}, { duration: 1.1 });
        for (var n = 2; n <= N; n++) tl.to(state, { p: n / N, duration: 0.6, ease: "power1.inOut", onUpdate: render }).to({}, { duration: 0.75 });
        tl.to({}, { duration: 2.6 }).to(state, { p: one, duration: 0.9, ease: "power2.inOut", onUpdate: render });
        if ("IntersectionObserver" in W) new IntersectionObserver(function (es) { onScreen = es[0].isIntersecting; if (started) onScreen ? tl.resume() : tl.pause(); }).observe(wc);
      };
      /* the board leans toward the pointer, and the gold ring turns slowly */
      var tx = 0, ty = 0, cx = 0, cy = 0, ra = 200;
      if (fine) world.addEventListener("pointermove", function (e) { var r = wc.getBoundingClientRect(); tx = clamp((e.clientX - r.left - r.width / 2) / r.width, -1, 1); ty = clamp((e.clientY - r.top - r.height / 2) / r.height, -1, 1); });
      G.ticker.add(function () {
        cx += (tx - cx) * 0.06; cy += (ty - cy) * 0.06; ra += 0.12;
        board.style.transform = "rotateX(" + (28 - cy * 9) + "deg) rotateY(" + (cx * 12) + "deg) rotateZ(-6deg)";
        if (ringo) ringo.style.setProperty("--ra", ra + "deg");
      });
    }
  }

  /* ---------- 7. the five leaks light up one at a time */
  var leaks = $(".leaks");
  if (leaks && !reduce) {
    leaks.classList.add("bo-live");
    $$(".leak", leaks).forEach(function (l) { ST.create({ trigger: l, start: "top 66%", end: "bottom 34%", toggleClass: "on" }); });
  }

  /* ---------- 8. STORY: the phone plays the quote that went quiet */
  $$(".story").forEach(function (story) {
    var steps = $$(".sstep", story), msgs = $$(".msg", story), cur = -1, cap = null;
    /* Nov 14 9:12 pm: on phones the current step's heading sits above the big phone, so nothing hides behind it */
    var sp = $(".story-phone", story);
    if (sp && !desk() && !reduce && steps.length) {
      cap = d.createElement("div"); cap.className = "sp-cap"; cap.setAttribute("aria-hidden", "true");
      cap.innerHTML = '<span class="t"></span><b></b>'; sp.insertBefore(cap, sp.firstChild); story.classList.add("cap-mode");
    }
    function setCap(n) {
      if (!cap) return; var st = steps.filter(function (s) { return +s.dataset.s === n; })[0] || steps[0];
      var t = st.querySelector(".t"), h = st.querySelector("h3");
      cap.firstChild.textContent = t ? t.textContent : ""; cap.lastChild.textContent = h ? h.textContent : "";
      if (G) G.fromTo(cap, { autoAlpha: 0.2, y: 6 }, { autoAlpha: 1, y: 0, duration: 0.35 });
    }
    function show(n) {
      if (n === cur) return; cur = n; setCap(n);
      steps.forEach(function (s) { s.classList.toggle("on", +s.dataset.s === n); });
      msgs.forEach(function (m) { m.classList.toggle("show", +m.dataset.s <= n); });
    }
    if (reduce) { steps.forEach(function (s) { s.classList.add("on"); }); msgs.forEach(function (m) { m.classList.add("show"); }); return; }
    /* the step nearest the reading line (55% down the screen) drives the phone */
    function pick() {
      var line = W.innerHeight * (desk() ? 0.55 : 0.72), best = cap ? +steps[0].dataset.s : 0, bd = 1e9;
      var r0 = story.getBoundingClientRect(); if (r0.bottom < 0 || r0.top > W.innerHeight) return;
      steps.forEach(function (s) { var r = s.getBoundingClientRect(), c = r.top + r.height / 2, dd = Math.abs(c - line); if (r.top < line + 40 && dd < bd) { bd = dd; best = +s.dataset.s; } });
      show(best);
    }
    W.addEventListener("scroll", pick, { passive: true }); W.addEventListener("resize", pick); pick();
  });

  /* ---------- 9. small details: callout hairlines, them-vs-us strike, gentle photo parallax */
  if ("IntersectionObserver" in W) {
    var io = new IntersectionObserver(function (es) { es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } }); }, { threshold: 0.3 });
    $$(".bo-callout").forEach(function (el) { io.observe(el); });
  } else $$(".bo-callout").forEach(function (el) { el.classList.add("in"); });
  if (!reduce && desk()) {
    $$(".pic img, .hero-photo img, .cell.photo img, .bo-strip img").forEach(function (img) {
      G.fromTo(img, { yPercent: -6, scale: 1.12 }, { yPercent: 6, scale: 1.12, ease: "none", scrollTrigger: { trigger: img.parentNode, start: "top bottom", end: "bottom top", scrub: true } });
    });
  }
  /* numbers in the Friday report decode like a counter, then land */
  if (!reduce && W.ScrambleTextPlugin) {
    $$(".bo-scramble").forEach(function (el) {
      var txt = el.textContent;
      G.from(el, { scrambleText: { text: txt, chars: "0123456789$", speed: 0.6 }, duration: 1.1, scrollTrigger: { trigger: el, start: "top 85%", once: true } });
    });
  }

  /* ---------- 9a. big statements fill in, word by word, as you read them */
  if (!reduce && W.SplitText) {
    $$(".leak-foot, .about blockquote").forEach(function (el) {
      var sp = W.SplitText.create(el, { type: "words" });
      G.fromTo(sp.words, { opacity: 0.16 }, { opacity: 1, stagger: 0.08, ease: "none", scrollTrigger: { trigger: el, start: "top 85%", end: "bottom 55%", scrub: true } });
    });
  }

  /* ---------- 9b. old-quotes calculator: your numbers, plain math, a pump-style total */
  $$("[data-oq]").forEach(function (box) {
    var q = $("#cq", box), a = $("#ca", box), r = $("#cr", box), cur = { v: 0 }, first = true;
    var money = function (n) { return "$" + Math.round(n).toLocaleString("en-US"); };
    function upd() {
      var Q = +q.value, A = +a.value, Rr = +r.value, jobs = Q * Rr / 20, tot = jobs * A;
      $('[data-v="q"]', box).textContent = Q; $('[data-v="a"]', box).textContent = money(A); $('[data-v="r"]', box).textContent = Rr + " in 20";
      $('[data-v="m"]', box).innerHTML = Q + " " + (box.getAttribute("data-w") || "quotes") + " &times; " + Rr + " in 20 = " + (Math.round(jobs * 10) / 10) + " " + (box.getAttribute("data-j") || "jobs") + "<br>" + (Math.round(jobs * 10) / 10) + " " + (box.getAttribute("data-j") || "jobs") + " &times; " + money(A) + " = " + money(tot);
      var out = $('[data-v="t"]', box);
      if (reduce) { out.textContent = money(tot); return; }
      G.to(cur, { v: tot, duration: first ? 1.6 : 0.6, ease: "power2.out", overwrite: true, onUpdate: function () { out.textContent = money(cur.v); }, onComplete: function () { out.textContent = money(tot); } });
      first = false;
    }
    [q, a, r].forEach(function (i) { i.addEventListener("input", upd); });
    ST.create({ trigger: box, start: "top 80%", once: true, onEnter: upd });
    $('[data-v="t"]', box).textContent = "$0";
  });

  /* ---------- 10. start: headline in, calendar stamps, then everything listens to scroll */
  introDone.then(function () {
    var h1 = $("main h1");
    if (h1) splitRise(h1, 0.05, true);
    heads.forEach(function (h) { if (h !== h1) splitRise(h, 0, false); });
    if (!reduce && world) G.from(".w-copy .lead, .w-copy .kicker, .w-trade, .w-cta > *, .w-ticks li", { y: 24, autoAlpha: 0, duration: 0.9, ease: "expo.out", stagger: 0.06, delay: 0.35, clearProps: "opacity,visibility,transform" });
    worldReady();
    if (d.fonts && d.fonts.ready) d.fonts.ready.then(function () { ST.refresh(); });
    W.addEventListener("load", function () { ST.refresh(); });
  });
})();
