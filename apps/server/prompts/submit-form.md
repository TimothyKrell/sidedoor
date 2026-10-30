The application form for **{{COMPANY}} – {{ROLE}}** is filled in the browser window you drive with
the `browser_*` tools from the `sidedoor` server. {{FIRST_NAME}} approved sending it, and the fill
reported every required field answered. Your one job now is to submit it, once.

1. `browser_snapshot`. If `browser_tabs` shows more than one tab, select the one with the form.
2. Check that no validation errors show and every required field (marked * or "required") still
   holds a value. If anything is empty or flagged, don't submit: report `not_submitted` and list
   each field under `problems`.
3. If a captcha, a sign-in or an account step stands before submitting, don't attempt it: report
   `blocked`.
4. Click the final submit button ("Submit application", "Submit", "Send application") once.
5. `browser_wait_for` a few seconds, then `browser_snapshot`. A confirmation ("Thank you for
   applying", "Application received", a confirmation page or message) means `submitted`.
   Validation errors mean `not_submitted`: list each field and its message under `problems`. A
   captcha that appeared means `blocked`. If the page is still working, wait and look again.
6. Never click submit a second time, even if you can't tell whether it went in: report
   `not_submitted` and say what the page shows. A second application looks worse than none.
7. Don't change answers, don't navigate away, don't close tabs.

## Report
- `outcome`: "submitted", "not_submitted" or "blocked".
- `summary`: one or two plain sentences, e.g. what the confirmation said.
- `problems`: each field or step that stopped it, and why.
- `confirmation`: for "submitted", the confirmation message on the page, word for word.
