# Certificate Posting Approval Automation

An approval workflow built on Zoho Desk, Google Apps Script and Google Chat. It replaces a
manual process in which a reward claim arrived by email, was checked by hand, copied into two
spreadsheets and passed through several rounds of sign-off before a discount code was sent.

The reward: a client who receives a payout certificate and posts it on social media, with
the required hashtags and mention, earns a discount code for their next purchase.

> This is a sanitized version of an internal tool I built for a proprietary trading firm.
> The brand name (`Acme Trading`), handles, hashtags, staff roles and email wording are
> placeholders. Every key, webhook URL and sheet ID is replaced, and no client data is
> included.

## Flow

```
Zoho Forms (client submits links)
      |
      v
Zoho Desk ticket in a dedicated department
      |   on create: eligibility check (first claim or repeat claim)
      v
Blueprint, main path:
  Business Team Review -> Manager Approval -> Director Review -> Ops Team Review
          ^                                                            |
          +------------------------------------------------------------+
  Business Team Review -> Fulfilled   (discount code emailed to the client)
  Business Team Review -> Rejected    (sheet rows removed, reason emailed)

Every step talks to the master Google Sheet through the Apps Script bridge,
and posts into one Google Chat thread per ticket.
```

## What is in this repo

| Path | What it is |
|---|---|
| `deluge/1-oncreate-eligibility.dg` | Runs when the ticket is created. Counts the client's earlier claims and sets the eligibility field |
| `deluge/2-assign-for-approval.dg` | Re-checks eligibility, generates a unique discount code, writes the two sheet rows, opens the Chat thread |
| `deluge/3-reject.dg` | Removes the ticket's sheet rows, emails the client the reason, posts to the thread |
| `deluge/4-fulfil.dg` | Verifies the sheet rows exist, emails the code, marks the row approved |
| `deluge/5-gchat-note-relay.dg` | Relays the approver's note from each middle transition into the ticket's thread |
| `bridge/Code.gs` | Google Apps Script web app that does all sheet work on behalf of Zoho |

The Deluge functions are attached to a workflow rule (function 1) and to Blueprint
transitions (functions 2 to 5) in Zoho Desk.

## The bridge

Zoho Desk never gets direct access to the spreadsheet. It calls a small Apps Script web app
with a JSON payload and a shared secret; the bridge does the sheet work and replies with JSON.

| Action | Purpose |
|---|---|
| `checkEligibility` | Count a client's earlier payout claims |
| `codeExists` | Check a candidate discount code against the code registry |
| `upsertRows` | Write one row per tab, keyed on ticket number |
| `deleteRows` | Remove a ticket's rows on rejection |
| `getRow` | Read a ticket's row back (used as a safety gate before fulfilment) |
| `updateStatus` | Flip a row from On Hold to Approved |
| `readTab`, `writeTab` | Bulk read and write for reporting |
| `verifyClient` | Confirm an account number belongs to the email on the ticket |
| `bonusDupCheck`, `campaignUpsert`, `campaignDelete` | Support a second, related bonus flow (its Deluge functions are not included here) |
| `readPayoutFromPost` | Verify the client's X post and read the payout amount from it |

## Design notes

**Upserts keyed on ticket number.** A ticket can be sent back and re-approved. Each write
updates the ticket's existing row if there is one and appends only if there is not, so a
send-back loop never creates duplicate rows.

**Verifying the post.** `readPayoutFromPost` fetches the client's X post, decodes the QR code
printed on the certificate image to get the payout ID, and looks that ID up in the payout
tracker to get the official amount and account. If the QR cannot be read, it falls back to
OCR through Google Drive and confirms the figure against the tracker by account and amount.
It also reports which required hashtags or mentions are missing. An unreadable post produces
a note for the reviewer, never a hard error.

**Collision-checked codes.** Discount codes are built from the client's name, the discount
and the account number. Each candidate is checked against the registry and the next one is
tried until a free code is found.

**Safety gate before sending.** The fulfil step re-reads both sheet rows and checks the
discount value before it emails anything. If something is missing it posts a warning to the
thread and sends nothing.

**One thread per ticket.** Every message about a ticket uses the same thread key, so the full
approval history of one claim sits in one Google Chat conversation. Approver notes are
cleared from the ticket field after they are relayed, so a note is never reposted under
someone else's name.

## Setup outline

1. Open the master Google Sheet, add `bridge/Code.gs` under Extensions → Apps Script
2. Set `SECRET_KEY` and the sheet IDs at the top of the file; enable the Drive API advanced
   service (used for OCR)
3. Deploy as a web app and copy the `/exec` URL
4. In Zoho Desk, create the department, custom fields and Blueprint, then add the five
   Deluge functions with `BRIDGE_URL`, `BRIDGE_KEY` and `GCHAT_WEBHOOK` filled in
5. Point a Zoho Form at the department so each submission creates a ticket

## Stack

Zoho Desk (Deluge, Blueprint, workflow rules), Zoho Forms, Google Apps Script, Google Sheets,
Google Chat webhooks, Google Drive OCR
