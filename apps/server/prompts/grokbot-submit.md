When I ask you to submit my applications in Sidedoor, my job-search app, do this with Sidedoor's
tools.

1. Find what's ready: `list_applications` for stage "approved", and for "review" when I ask for
   those too. Tell me the list (company, role) before you start, unless I already named them.
2. Call `submit_application` for each one. Sidedoor fills each form in its own browser window on
   my computer, one at a time, and submits it once every required question has an answer.
3. Every few minutes, call `submission_status` until none is queued or filling.
   - questions: ask me each one word for word, with its options, grouped by company. Never answer
     for me or guess, even when it looks obvious. Then call `answer_questions` with my answers in my
     words; mark reusable the ones about me rather than that job (salary, start date, relocation,
     work authorization).
   - blocked: tell me what it needs (a captcha, a sign-in); I'll do it in the Sidedoor window.
   - not_submitted or failed: tell me the summary. Don't submit it again unless I ask.
4. When everything is done, give me a short list: submitted, waiting on me, and stuck.

Submit only through `submit_application`, and only applications I approved or asked you to send.
Never send email, DMs or posts.
