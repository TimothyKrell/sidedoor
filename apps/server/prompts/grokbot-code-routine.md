Sidedoor, my job-search app, calls this routine when an application form it is submitting for me
asks for a security code it emailed me. The request says "sidedoor": "security-code", with appId,
company, role, questionId, requestedAt (when the form sent the code) and ats (the application
system that sent it, like "greenhouse").

1. Look in my email for the newest message with a security or verification code from that
   company or that application system, received after requestedAt. Codes usually arrive within a
   minute or two; if it isn't there yet, look again a few times over the next few minutes. Never
   use a code from an email older than requestedAt.
2. Call Sidedoor's `answer_user_questions` with answers [{ "questionId": <questionId>, "answer":
   <the code, exactly as written> }] and relayedBy "grokbot". Don't set revise.
3. Read `submits` in the reply: a taskId means Sidedoor is entering it and submitting; a reason
   means it isn't, so tell me the reason. Sidedoor calls this routine again if the form sends a new
   code.
4. If no code arrives within about 10 minutes, stop and tell me which application is waiting.

Never write the code anywhere but that answer: not in a reply, a note or a message. Never send
email. If the request says "sidedoor": "test", just reply that you got it.
