# Legal documents — where the real ones live

**The canonical documents are the client's published pages. Nothing in this
repo overrides them.**

- Privacy Policy — https://samplefinder.com/privacy-policy/ (last updated 31 Jul 2026)
- Terms & Conditions — https://samplefinder.com/terms-and-conditions/ (last updated 21 May 2026)

These are the URLs A2P/TCR reviewers open, and the ones that go in the campaign
registration's Privacy Policy URL and Terms & Conditions URL fields (mandatory
for campaigns registered from 30 June 2026 onward).

Do not keep a second, differently-worded copy of either document in this repo.
Twilio treats *conflicting statements across multiple policies* as grounds to
reject a campaign (error 30908), and a stale duplicate here is exactly that.

## Where copies exist, and how they stay honest

| Copy | Read by | Should contain |
|---|---|---|
| samplefinder.com pages | A2P reviewers, App Store, users | **canonical** |
| Appwrite `settings` rows | The app, normal path | verbatim copy of the live pages |
| `LegalContent.ts` constant | The app, only if the row is missing or the fetch fails | a short pointer to the URLs — **not** a full duplicate |

The mobile app does not ship its legal text. `PrivacyModal` / `TermsModal` call
`getSetting('privacy_policy')` / `getSetting('termsAndCondition')` against the
Appwrite `settings` collection and fall back to the bundled constant only when
the row is missing or the fetch fails. There is no admin-dashboard UI for these
rows — they are edited via the API or the Appwrite Console.

## Updating the in-app copy after a website change

Copy the text **from the CMS**, not by scraping the page — legal wording must be
verbatim.

```bash
APPWRITE_API_KEY=... npm run check:legal -- --set privacy_policy    --from ./privacy.txt
APPWRITE_API_KEY=... npm run check:legal -- --set termsAndCondition --from ./terms.txt
APPWRITE_API_KEY=... npm run check:legal          # verify what is live
```

`check:legal` asserts that the stored privacy policy still mentions SMS, carries
a non-sharing clause, and discloses message frequency, rates and HELP/STOP.
Because anyone with Console access can edit these rows and silently break A2P
compliance, run it before any campaign resubmission.

## Open compliance issue

As of 7 Aug 2026 the two live pages contradict each other on SMS usage:

- Privacy Policy: *"We use your phone number **solely** to send one-time
  verification codes (2FA) during account registration and login."*
- Terms & Conditions: *"…you expressly consent to receive communications from us
  by email and SMS/text message, including account, transactional, and
  service-related messages **as well as promotional and marketing messages**."*

The privacy policy was updated after the campaign rejection; the terms were not.
With a `2FA` campaign use case, a reviewer sees terms that authorise marketing
texts — an independent 30908 trigger. See `proposed-terms-sms-amendment.md` for
draft replacement wording. **Resolve this before resubmitting the campaign.**
