# Proposed amendment — SMS clause in Terms & Conditions

**Status:** draft for legal review. Not published. Prepared 7 Aug 2026.
**Page:** https://samplefinder.com/terms-and-conditions/ (last updated 21 May 2026)

## Why this is needed

The A2P 10DLC campaign (`QE2c6890da8086d771620e9b13fadeba0b`, use case `2FA`) was
rejected with error **30908 — a compliant privacy policy cannot be verified**.

The Privacy Policy was subsequently updated (31 Jul 2026) and now satisfies every
requirement. The Terms were not updated alongside it, and the two pages now
contradict each other on what the mobile number is used for:

> **Privacy Policy:** "We use your phone number **solely** to send one-time
> verification codes (2FA) during account registration and login."

> **Terms & Conditions:** "By providing your email address and/or mobile phone
> number and creating an account, you expressly consent to receive communications
> from us by email and SMS/text message, including account, transactional, and
> service-related messages **as well as promotional and marketing messages**."

Twilio lists conflicting statements across policies as an independent rejection
cause. With a `2FA` campaign, terms that authorise marketing texts are also a
use-case mismatch. Both point at another rejection if resubmitted unchanged.

## Current wording (to be replaced)

> By providing your email address and/or mobile phone number and creating an
> account, you expressly consent to receive communications from us by email and
> SMS/text message, including account, transactional, and service-related
> messages as well as promotional and marketing messages.

## Proposed wording

The key change is separating the two channels, so email marketing consent is
preserved while SMS is narrowed to verification only.

> **Email.** By providing your email address and creating an account, you consent
> to receive communications from us by email, including account, transactional
> and service-related messages, as well as promotional and marketing emails. You
> may opt out of marketing emails at any time using the "unsubscribe" link in any
> such email.
>
> **Text messages (SMS).** By providing your mobile phone number and giving your
> consent during sign-up, you consent to receive a one-time verification code by
> text message. We use your mobile number solely to verify your identity when you
> register and when you sign in. **We do not send promotional or marketing text
> messages.** Message frequency: one message per verification request. Message and
> data rates may apply. Reply HELP for help or STOP to opt out. Replying STOP ends
> verification messages to that number and may prevent you from completing sign-up
> or signing in.

## Why this specific wording

| Element | Reason |
|---|---|
| "solely to verify your identity" | Matches the Privacy Policy's "solely", removing the conflict |
| "We do not send promotional or marketing text messages" | Matches the `2FA` campaign use case |
| "one message per verification request" | Matches the in-app consent checkbox |
| Rates, HELP/STOP | Required disclosures, consistent across both pages |
| STOP consequence stated | The app requires verification, so the effect of opting out must be honest |
| Email split out | Preserves existing email marketing consent, which is unaffected |

## Points for legal to decide

1. **SMS consent is mandatory to create an account.** Verification is a security
   measure rather than marketing, which is normally why this is acceptable — but
   it is a deliberate choice and worth confirming. The sign-up screen blocks
   account creation until the box is ticked.
2. **The existing line** *"your consent to receive marketing texts is not a
   condition of purchasing any goods or services"* can stay, and is consistent
   with the above since no marketing texts are sent. Confirm it does not read as
   implying marketing texts exist.
3. **Update the "Last Updated" date** when published.
4. **Keep the Privacy Policy unchanged** — it already passes.

## After publishing

1. Sync both documents into the Appwrite `settings` rows (see `README.md`) so the
   app shows the same text.
2. Verify with `npm run check:legal`.
3. Resubmit the campaign with both URLs in the Console fields and both links
   inside `message_flow`.
