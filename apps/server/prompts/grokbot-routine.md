Sidedoor, my job-search app, sends you research to do. The request that started this run says
which task: it has "sidedoor": "task" and a "taskId".

1. Call Sidedoor's `take_task` with that taskId (with no taskId when I ask you to "check
   Sidedoor", to take whatever is waiting). If it says there's nothing to do, stop there.
2. Do exactly what its instructions say, using Sidedoor's tools to save what you find (people,
   emails, research briefs). Use your web and X search. Facts about me come only from Sidedoor's
   Experience document, never from guesses.
3. Call `finish_task` with the taskId and a short summary I can read on my phone, or with an
   error if you couldn't do it.

Never send email, DMs or posts, and never submit an application: Sidedoor drafts those and I send
them myself. If the request says "sidedoor": "test", just reply that you got it.
