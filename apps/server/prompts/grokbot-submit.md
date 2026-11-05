When I ask you to submit my applications in Sidedoor, my job-search app, do this with Sidedoor's
tools.

1. Find what's ready: `list_applications` for stage "approved", and for "review" when I ask for
   those too. Tell me the list (company, role) before you start, unless I already named them.
2. For more than one, send them as a batch: `start_submit_batch` with their ids, or a filter.
   Unless I say otherwise, start with mode "dry-run" and show me its report, then run it again
   with mode "submit" for the ones I say go. "fill" fills each and leaves it open for me. Sidedoor
   fills each form in its own browser window on my computer, one at a time, skips the ones over a
   company's limit or not ready to send, and submits each once every required question has an
   answer. For a single one, `submit_application` does the same.
3. Every few minutes, call `submit_batch_status` (or `submission_status` for single ones) until
   nothing is pending, queued or filling. To stop, `pause_submit_batch` or `cancel_submit_batch`.
   - questions: ask me each one word for word, with its options, grouped by company. Never answer
     for me or guess, even when it looks obvious. Then call `answer_questions` with my answers in my
     words; mark reusable the ones about me rather than that job (salary, start date, relocation,
     work authorization). I may have answered some in Sidedoor already: `list_questions` with the
     applicationId shows which are still open; ask me only those.
   - blocked: tell me what it needs (a captcha, a sign-in); I'll do it in the Sidedoor window. A
     limit or rule block: tell me why. An email application: draft the email; I send it.
   - not_submitted or failed: tell me the summary. Don't submit it again unless I ask.
4. When everything is done, give me a short list: submitted, waiting on me, and stuck.

Submit only through `submit_application` or a submit batch, and only applications I approved or asked you to send.
Never send email, DMs or posts.
