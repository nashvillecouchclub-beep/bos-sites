// Free report follow-up sequence, LOCKED wording (do not edit by hand; source: Drive "FREE REPORT FOLLOW-UP SEQUENCE - locked v4 (Nov 20)").
// Cold = owner asked from the website form or after a cold email. Warm = came through a person we know.
export default {
 "subject": "Re: + the report email subject (no subject field per step)",
 "day_rule": "day = business day after day 0 (the report send day); weeks_after_last = weeks after the last main-sequence send (c5 or w3) or the day he replied 'later', not after the previous ladder step",
 "fallback_rule": "go to the fallback when this node's 'when' is false, OR any of its needs is missing, OR its fact is already in facts-used",
 "fact_rule": "a step whose fact is already in this thread's facts-used list goes to its fallback",
 "holidays_slide_next_business_day": [
  "2026-11-26",
  "2026-12-25",
  "2027-11-25",
  "2027-12-25"
 ],
 "max_emails_per_owner_per_day": 1,
 "send_hour": "hour the report went out, owner's time zone",
 "stop_on": [
  "any reply incl. forward/CC",
  "stop",
  "no",
  "remove me",
  "close my file",
  "bounce",
  "angry",
  "paid or started"
 ],
 "later_or_check_back_routes_to": "ladder",
 "out_of_office": "pause until return date",
 "signature": "Rickey Hallor\nBooked Out Solutions\nP.O. Box 1166, Smyrna, TN 37167",
 "footer": {
  "cold_website": "You got this because you asked for a free report on our website.\nReply \"stop\" and we will not email you again.",
  "cold_email": "You got this because you asked for a free report.\nReply \"stop\" and we will not email you again.",
  "warm": "You got this because you asked for a free report.\nReply \"stop\" and we will not email you again."
 },
 "cold": [
  {
   "step": "c1",
   "day": 1,
   "needs": [
    "business",
    "first_name",
    "report_link",
    "review_count",
    "review_gap",
    "top3_avg",
    "town",
    "trade_word"
   ],
   "body": "Hi {first_name},\n\nHere's the one number from your report I'd look at first.\n\nThe top 3 shops on Google for \"{trade_word} {town}\" average {top3_avg} reviews. {business} has {review_count}. That's a gap of {review_gap}.\n\nYour report lists three fixes, and it's here if you want it again: {report_link}\n\nIs closing that gap something you'd want to work on this month?",
   "fallback": {
    "if_missing": [
     "top3_avg",
     "review_count",
     "review_gap"
    ],
    "needs": [
     "first_name",
     "fix_1",
     "report_link"
    ],
    "body": "Hi {first_name},\n\nHere's the one thing from your report I'd look at first.\n\nThe first of its three fixes is {fix_1}.\n\nYour report is here if you want it again: {report_link}\n\nIs that one you'd want to work on this month?",
    "fallback": {
     "skip": true
    }
   }
  },
  {
   "step": "c2",
   "day": 3,
   "when": "ai_named == 'no'",
   "needs": [
    "business",
    "first_name",
    "town",
    "trade_word",
    "ai_named"
   ],
   "body": "Hi {first_name},\n\nHere's one part of your report you can't see by looking at your own Google listing.\n\nWe asked ChatGPT and Gemini to recommend a {trade_word} in {town}. {business} wasn't named in either answer.\n\nYou can check it yourself in under a minute: open ChatGPT on your phone and ask it for a {trade_word} in {town}.\n\nWant me to write out what I'd change first, so you can see it?",
   "fallback": {
    "if_missing": [
     "ai_named"
    ],
    "needs": [
     "business",
     "first_name",
     "rank",
     "town",
     "trade_word"
    ],
    "body": "Hi {first_name},\n\nHere's one more number from your report.\n\nWhen we searched \"{trade_word} {town}\" on the Google map, {business} came up at #{rank}. The shops above you show up first.\n\nYou can check it on your phone in under a minute, searching from a customer's address, not your shop.\n\nWant me to write out the one change I'd make first to your listing?",
    "when": "rank is a number",
    "fallback": {
     "if_missing": [
      "rank"
     ],
     "needs": [
      "business",
      "first_name",
      "town",
      "trade_word"
     ],
     "body": "Hi {first_name},\n\nHere's one more thing from your report.\n\nWhen we searched \"{trade_word} {town}\" on the Google map, {business} didn't show up in the results we checked.\n\nYou can check it on your phone in under a minute, searching from a customer's address, not your shop.\n\nWant me to write out the one change I'd make first to your listing?",
     "when": "rank == 'not found'",
     "fallback": {
      "if_missing": [
       "rank"
      ],
      "needs": [
       "ai_named",
       "business",
       "first_name",
       "town",
       "trade_word"
      ],
      "body": "Hi {first_name},\n\nHere's one part of your report you can't see by looking at your own Google listing.\n\nWe asked ChatGPT and Gemini to recommend a {trade_word} in {town}, and {business} was named. That's worth knowing, and you can check it yourself in under a minute.\n\nWant me to run the same test again now and send you today's answer?",
      "when": "ai_named == 'yes'",
      "fallback": {
       "skip": true
      }
     }
    }
   }
  },
  {
   "step": "c3",
   "day": 7,
   "needs": [
    "booking_fix_1",
    "booking_score",
    "business",
    "first_name"
   ],
   "body": "Hi {first_name},\n\nI don't expect you to take my word for any of this, so here's one fix from your report written out.\n\nOn the phone booking test in your report, {business} scored {booking_score} out of 10. Here's the first fix, ready to hand to whoever answers your phone:\n\n{booking_fix_1}\n\nNothing to buy or install.\n\nWant me to write the rest of your fixes out the same way?",
   "fallback": {
    "if_missing": [
     "booking_score",
     "booking_fix_1"
    ],
    "needs": [
     "first_name",
     "newest_review_replied"
    ],
    "body": "Hi {first_name},\n\nI don't expect you to take my word for any of this, so here's something you can check in a minute.\n\nWhen we ran your report, your newest Google review had no reply yet. I can write that reply in your voice, so all you do is paste it in. Nothing to buy or install.\n\nWant me to write it for you?",
    "when": "newest_review_replied == 'no'",
    "fallback": {
     "skip": true
    }
   }
  },
  {
   "step": "c4",
   "day": 12,
   "needs": [
    "first_name",
    "fix_2"
   ],
   "body": "Hi {first_name},\n\nOne more piece of your report, in case it got buried:\n\n{fix_2}\n\nIf someone else would make this change, I can write it out for them so it's ready to go.\n\nIs this one you'd do yourself, or should I write it out for whoever would make the change?",
   "fallback": {
    "if_missing": [
     "fix_2"
    ],
    "needs": [
     "first_name",
     "fix_3"
    ],
    "body": "Hi {first_name},\n\nOne more piece of your report, in case it got buried:\n\n{fix_3}\n\nIf someone else would make this change, I can write it out for them so it's ready to go.\n\nIs this one you'd do yourself, or should I write it out for whoever would make the change?",
    "fallback": {
     "skip": true
    }
   }
  },
  {
   "step": "c5",
   "day": 18,
   "needs": [
    "business",
    "first_name",
    "fix_1",
    "report_link"
   ],
   "body": "Hi {first_name},\n\nI'll keep this one short.\n\nYour report stays yours: {report_link}. Use the fixes in it whether or not we ever work together.\n\nThe first fix on its list was {fix_1}. From here I'll only write now and then, when I have something useful for {business}. If it's a no, reply \"no\" and I'll stop.\n\nShould I close your file, or is that fix still on your list?",
   "fallback": {
    "if_missing": [
     "fix_1"
    ],
    "needs": [
     "business",
     "first_name",
     "report_link"
    ],
    "body": "Hi {first_name},\n\nI'll keep this one short.\n\nYour report stays yours: {report_link}. Use the fixes in it whether or not we ever work together.\n\nFrom here I'll only write now and then, when I have something useful for {business}. If it's a no, reply \"no\" and I'll stop.\n\nShould I close your file, or are the fixes in your report still on your list?",
    "fallback": {
     "skip": true
    }
   }
  }
 ],
 "warm": [
  {
   "step": "w1",
   "day": 2,
   "needs": [
    "business",
    "first_name",
    "report_link",
    "review_count",
    "review_gap",
    "top3_avg",
    "town",
    "trade_word"
   ],
   "body": "Hi {first_name},\n\nSince {introducer} put us in touch, I wanted to make sure your report reached you. Here it is again: {report_link}\n\nOne number in it worth a look: the top 3 on Google for \"{trade_word} {town}\" average {top3_avg} reviews, and {business} has {review_count}. That gap of {review_gap} is where I'd start.\n\nIs that gap something you'd want to work on this month?",
   "line_rules": [
    {
     "if_missing": "introducer",
     "replace": "Since {introducer} put us in touch, I wanted",
     "with": "I wanted"
    },
    {
     "if_missing": "introducer",
     "replace": "\n\nThank you to {introducer} for putting us in touch.",
     "with": ""
    }
   ],
   "fallback": {
    "if_missing": [
     "top3_avg",
     "review_count",
     "review_gap"
    ],
    "needs": [
     "first_name",
     "fix_1",
     "report_link"
    ],
    "body": "Hi {first_name},\n\nSince {introducer} put us in touch, I wanted to make sure your report reached you. Here it is again: {report_link}\n\nOne thing in it worth a look: the first fix, {fix_1}. That's where I'd start.\n\nIs that one you'd want to work on this month?",
    "fallback": {
     "skip": true
    },
    "optional": [
     "introducer"
    ]
   },
   "optional": [
    "introducer"
   ]
  },
  {
   "step": "w2",
   "day": 7,
   "needs": [
    "booking_fix_1",
    "booking_score",
    "business",
    "first_name"
   ],
   "body": "Hi {first_name},\n\nHere's one fix from your report, written out so you can see exactly what it looks like.\n\nOn the phone booking test, {business} scored {booking_score} out of 10. The first fix:\n\n{booking_fix_1}\n\nIt's written so you can hand it straight to whoever answers your phone. Nothing to buy or install.\n\nWant me to write the rest of your fixes out the same way?",
   "fallback": {
    "if_missing": [
     "booking_score",
     "booking_fix_1"
    ],
    "needs": [
     "first_name",
     "newest_review_replied"
    ],
    "body": "Hi {first_name},\n\nHere's one thing from your report you can check in a minute.\n\nWhen we ran it, your newest Google review had no reply yet. I can write that reply in your voice, so all you do is paste it in. Nothing to buy or install.\n\nWant me to write it for you?",
    "when": "newest_review_replied == 'no'",
    "fallback": {
     "if_missing": [
      "newest_review_replied"
     ],
     "needs": [
      "first_name",
      "fix_2"
     ],
     "body": "Hi {first_name},\n\nHere's one more fix from your report:\n\n{fix_2}\n\nI can write it out step by step for whoever would make the change, so it's ready to go.\n\nWant me to write it out for you?",
     "fallback": {
      "skip": true
     }
    }
   }
  },
  {
   "step": "w3",
   "day": 12,
   "needs": [
    "first_name",
    "fix_1",
    "report_link"
   ],
   "body": "Hi {first_name},\n\nThis is my last note for now, so I'll keep it short.\n\nYour report stays yours: {report_link}. Use the fixes in it whether or not we ever work together. The first one on its list was {fix_1}. If the timing isn't right, that's completely fine.\n\nThank you to {introducer} for putting us in touch.\n\nWould you like me to check back in a few weeks, or close your file for now?",
   "line_rules": [
    {
     "if_missing": "introducer",
     "replace": "Since {introducer} put us in touch, I wanted",
     "with": "I wanted"
    },
    {
     "if_missing": "introducer",
     "replace": "\n\nThank you to {introducer} for putting us in touch.",
     "with": ""
    }
   ],
   "fallback": {
    "if_missing": [
     "fix_1"
    ],
    "needs": [
     "first_name",
     "report_link"
    ],
    "body": "Hi {first_name},\n\nThis is my last note for now, so I'll keep it short.\n\nYour report stays yours: {report_link}. Use the fixes in it whether or not we ever work together. If the timing isn't right, that's completely fine.\n\nThank you to {introducer} for putting us in touch.\n\nWould you like me to check back in a few weeks, or close your file for now?",
    "fallback": {
     "skip": true
    },
    "optional": [
     "introducer"
    ]
   },
   "optional": [
    "introducer"
   ]
  }
 ],
 "ladder": [
  {
   "step": "n1",
   "weeks_after_last": 2,
   "when": "newest_review_replied == 'no'",
   "needs": [
    "first_name",
    "report_date",
    "newest_review_replied"
   ],
   "body": "Hi {first_name},\n\nWhen we ran your report on {report_date}, your newest Google review had no reply yet. If that's still true, I can write the reply in your voice so all you do is paste it in.\n\nWant me to write it?",
   "fallback": {
    "if_missing": [
     "newest_review_replied"
    ],
    "needs": [
     "first_name",
     "fix_3"
    ],
    "body": "Hi {first_name},\n\nHere's one fix from your report I haven't sent you yet:\n\n{fix_3}\n\nIs that one done, or still open?",
    "fallback": {
     "skip": true
    }
   }
  },
  {
   "step": "n2",
   "weeks_after_last": 6,
   "when": "rank is a number",
   "needs": [
    "business",
    "first_name",
    "rank",
    "report_date",
    "town",
    "trade_word"
   ],
   "body": "Hi {first_name},\n\nHere's one number from your report I haven't sent you yet. On {report_date}, {business} came up at #{rank} on the Google map for \"{trade_word} {town}\".\n\nYou can check today's spot yourself: search \"{trade_word} {town}\" on your phone from a customer's address, not your shop, and look at the map.\n\nHas it moved since then?",
   "fallback": {
    "if_missing": [
     "rank"
    ],
    "needs": [
     "business",
     "first_name",
     "report_date",
     "town",
     "trade_word"
    ],
    "body": "Hi {first_name},\n\nHere's one thing from your report I haven't sent you yet. On {report_date}, {business} didn't show up in the Google map results we checked for \"{trade_word} {town}\".\n\nYou can check it yourself: search \"{trade_word} {town}\" on your phone from a customer's address, not your shop, and look at the map.\n\nDo you show up there now?",
    "when": "rank == 'not found'",
    "fallback": {
     "if_missing": [
      "rank"
     ],
     "needs": [
      "ai_result",
      "business",
      "first_name",
      "report_date",
      "town",
      "trade_word"
     ],
     "body": "Hi {first_name},\n\nHere's one thing from your report I haven't sent you yet. On {report_date}, we asked ChatGPT and Gemini to recommend a {trade_word} in {town}, and {business} {ai_result}.\n\nYou can check it yourself in under a minute: ask ChatGPT on your phone for a {trade_word} in {town}.\n\nWant me to run it again and send you today's answer?",
     "when": "ai_named is set",
     "fallback": {
      "skip": true
     }
    }
   }
  },
  {
   "step": "n3",
   "weeks_after_last": 12,
   "needs": [
    "business",
    "checks_list",
    "first_name",
    "months_since",
    "report_date"
   ],
   "body": "Hi {first_name},\n\nIt's been {months_since} months since your report on {business}. On {report_date} it checked {checks_list}.\n\nThose numbers are getting old. I can run the same checks again and send you the new numbers next to the old ones, free, same as the first report.\n\nWant me to run it again?",
   "fallback": {
    "if_missing": [
     "checks_list",
     "report_date"
    ],
    "needs": [
     "business",
     "first_name",
     "months_since"
    ],
    "body": "Hi {first_name},\n\nIt's been {months_since} months since your report on {business}, so the numbers in it are getting old.\n\nI can run the same checks again and send you the new numbers next to the old ones, free, same as the first report.\n\nWant me to run it again?",
    "fallback": {
     "skip": true
    }
   }
  }
 ],
 "rerun": {
  "every_weeks": 13,
  "starts_after": "n3",
  "max_no_reply": 2,
  "needs": [
   "business",
   "first_name",
   "months_since",
   "report_date",
   "review_count",
   "top3_avg",
   "town",
   "trade_word"
  ],
  "body": "Hi {first_name},\n\nIt's been {months_since} months since your report on {business}. On {report_date} it showed {review_count} Google reviews for {business}, and the top 3 for \"{trade_word} {town}\" averaged {top3_avg}.\n\nI can check those again and send you what changed, side by side, free.\n\nWant the new numbers?",
  "fallback": {
   "if_missing": [
    "review_count",
    "top3_avg"
   ],
   "needs": [
    "business",
    "first_name",
    "fix_1",
    "months_since",
    "report_date"
   ],
   "body": "Hi {first_name},\n\nIt's been {months_since} months since your report on {business}. On {report_date}, the first fix on its list was {fix_1}.\n\nI can run the same checks again and send you what changed, side by side, free.\n\nWant the new numbers?",
   "fallback": {
    "skip": true
   }
  },
  "facts_used_reset": true
 },
 "locked": "Nov 20 2026 1:55 am: Salesperson brain wrote it; Hormozi 8.5/8.5, Platten 8/8.5, owner clones 8/8.5; fresh second agent PASS 8.5/8.5 (after 10+1 fixes)."
};
