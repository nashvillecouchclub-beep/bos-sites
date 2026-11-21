# Free report: the two checkers (Nov 16 night)

Rickey does not check free reports (his rule, Nov 16 4:46 pm). Two separate Claude agents do. Checker 1 and checker 2 are
different agents in different runs. Neither one may see the other's notes before it gives its own verdict. A report goes to
the owner only after both pass the same version (`hash`), and only when LIVE is on.

How each checker works:
1. `GET /api/free-report/review?k=STATUS_KEY` and take the items whose `needs` is your slot ("checker 1" or "checker 2").
   Soonest `due` first.
2. Open the item's `report` link and read the whole page. Compare it with the item's `sections` (the lookup data) and
   its form fields (`first_name`, `business_name`, `town`, `trade`, `revenue`).
3. Send one mark: `POST /api/free-report/check`
   `{"id","k","checker":1|2,"agent":"checker-<slot>-<run id>","result":"pass"|"fail","hash":"<the hash you read>","notes":"..."}`.
   Fail notes say exactly what is wrong and what the fix is, in one or two lines.
4. A fail holds the report and puts it on the watch list. The fixing agent corrects the data with `/fill`, which makes a new
   version, and then both checkers read it again from the start.

## Checker 1: facts and data (the doer's check)
Fail the report if any of these is not true:
- Every number and fact on the page traces to the lookup data or the owner's own form answers: stars, review count, rank,
  the top 3 names and counts, the review gap, the newest review text and date, whether it got a reply, the ChatGPT and
  Gemini result and question, the booking score and fixes, and the main category. If a fact isn't in `sections`, fail it.
- No guessed numbers. The budget line shows only when the owner picked a revenue range, and its math is right:
  6% of the low end and 8% of the high end, divided by 12. "Rather not say" or blank means no budget line.
- No section says "Pending check" (`pending` is empty and `complete` is true).
- The owner's first name, business name, town and trade are right everywhere, with the same spelling as the form.
  The report belongs to this request, not another one.
- The "No Google profile" wording appears only when `has_google_profile` is false. When it does, there is no rank line.
- The 3 fixes fit what was found. For example, there is no "reply to your newest review" fix when it already has a reply.
- The trade's price link is right (hvac, plumbing or electrical price page; free-look page for other trades).
- Nov 20 sections (item 215, item 211, the Nov 19 diagnosis):
  - The "In one line" diagnosis matches the data: no profile (`has_google_profile` false) or not in the first 20 (rank null AND
    `rank_checked` true) = "Not found"; number 4 or lower = "Found but not chosen"; top 3 with no answer, or an unanswered after-hours
    test = "Chosen but never followed up"; an answer over 60 minutes = "Chosen but slow to follow up"; 6 to 60 minutes = "Found and
    chosen, but slow to answer". The minutes or hours match the speed section word for word. The three fixes are always three, none twice.
    The fix that matches his speed result is always among them: no answer or a slow answer has the 5-minute fix; a fast answer
    with an unanswered after-hours test has the after-hours fix for that channel. The kept fix is the one the diagnosis line points at (same rule in the
    code); when he was slow (or did not answer) AND missed the after-hours test, both speed fixes are kept. There is never more than
    one 5-minute fix, always worded "Call or text back every new lead within 5 minutes, even after hours.", and it only comes from
    the speed result (never for a shop that answered within 5 minutes; always for a slow or missing answer).
  - Booking fixes (section 4, the first booking fix in the three fixes, and the follow-ups' booking_fix_1) all come from one
    filtered list: no fix that mentions any time unit (seconds, minutes, hours, in any spelling, digits, look-alike letters or
    hidden characters), no copy of the speed sentence, no blank fix, no repeats. If section 4, the three fixes and the follow-up
    disagree on the booking fix, fail it.
  - The answer speed line (channel, when, minutes or hours waited, after-hours result) is in `sections.speed`. Each estimate is
    labeled as an estimate and has its source line; the after-hours estimate shows only for heating and air, and a calls-a-month
    number only when `leads_source` is "owner".
  - The known-for words and counts come from the 4 and 5 star reviews in `sections.known_for.reviews` (each word in 3 or more of
    them), and "We read N" is `scanned`. No complaint word shows. "The review fix below" appears only when the review fix is one of
    the three fixes.
  - The competitor is in the google top 3, shows above him, and its stars and reviews match the top 3 data. The side by side
    rows and the 3 gaps match `sections.competitor`.
  - The six listing rows and the fix for each weak one match `sections.listings`.
  - The spot line shows only when `sections.spot.open` is true and names the right zone and trade. The Quote Guarantee names his
    business exactly as on the form, and its sentences are word for word from the terms page. No spot or guarantee for "Something else".
  - The ChatGPT, Gemini and Google AI answers match `sections.ai`; any business named there is in that engine's `top` list.

## Checker 2: wording, rules and risk (the second agent)
Fail the report if any of these is not true:
- The locked free report wording is unchanged. It is called the "free report", never "free look" or "free check".
  The header line is "Built from your real Google listing and a few quick checks. It is yours to keep."
  The next step reads "Start your free 30 days" and "Nothing is charged for 30 days. Cancel any time with one reply."
  The budget line reads "Shops your size spend 6 to 8% of revenue to grow; for you that's ... Core is $997."
- Nothing promises or implies jobs, calls, revenue, a ranking or a result ("you will rank", "more jobs guaranteed", and so on).
- There are no long dashes and no emojis anywhere in what the owner sees, including review text.
- It doesn't lead with AI, names none of our tools or how we run (no Claude, no agents, no stack), and says
  "example business" for any example.
- Nothing is rude about the owner, his competitors or his reviewers. A competitor is only named when it is in the top 3
  lookup data, or when ChatGPT, Gemini or Google AI named it (its `top` list in `sections.ai`).
- Every outside number carries its source (Harvard Business Review 2011, the 2007 lead response study, or ServiceTitan June 2026)
  and is labeled "(outside research, not your numbers)" or "(estimate)". Nothing calls the research a booking rate, and none of it is
  turned into a promise. The Quote Guarantee says "Once your first paid month starts", and the terms lines "We never promise jobs,
  revenue or a spot on Google." and "There are no guarantees during a free period, because nothing is being charged." are there.
- The "One honest question" line is gentle (a question, no number, no pitch).
- No health, legal or personal details beyond what the owner gave. Nothing from the owner's private note
  ("What's going on?") is shown on the page.
- It is not a fake TEST shop sent as real (the review list shows `test`), and the owner's email looks like a real
  business or personal address.
- Then re-check checker 1's two riskiest facts yourself (rank and review gap) against `sections`.

## Running it by hand (Nov 21 2026)
Until the scheduled task exists, a live chat runs `workers/freereport-checkers.mjs` (dry run first, then `--apply`). It fills what it
can (answer speed is always "not tested"; the spot comes from `workers/data/zone-locks.json`; the rest from the research file the
chat gathers from public pages), runs the checker 1 and checker 2 lists above as script checks, and posts both marks. For the two
separate Claude checkers, the chat starts two sub-agents (checker 2 never sees checker 1's notes) and passes their verdicts with
`--verdicts`; a script fail always wins. Details: DEPLOY.md, "The Free report checkers runner".

## Timing (scheduled task, created only when GO LIVE is near)
- One cloud scheduled task, "Free report checkers", runs every hour from 7 am to 7 pm Central on weekdays, plus once at
  9 pm, 5 am and 7 am. The clock is 1 business day and the cron builds a report within 15 minutes, so a request is checked
  within about 1 to 2 hours on a weekday and long before 75% of its clock.
- Each run starts two fresh sub-agents one after the other: checker 1, then checker 2 (a new agent that does not see
  checker 1's notes). The run itself sends nothing. The worker sends after the second pass.
- If an item is past 75% of its clock and still needs a fill, the run fills it first (AI test with ChatGPT, Gemini and Google AI,
  booking test, category, known_for with stars, competitor, listings, spot), always through `workers/freereport-fill.mjs`
  (see DEPLOY.md, "Free report fill jobs"), by running `node workers/freereport-checkers.mjs --apply`. It never runs the answer speed test.
  If it can't, it writes the problem to the watchdog inbox. Overdue items show as `problems` in `/status`, and the
  watchdog picks them up.
- The prompt must include: "Never ask Rickey for an Allow: if a step needs one, skip it and list it at the end."
  Rickey gets no email from this task.
