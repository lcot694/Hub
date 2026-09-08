# Google Calendar controlled rollout checklist

Use a non-production Family Hub household, one adult tester, and one dedicated writable Google test calendar. Do not record secrets, tokens, private email addresses, real calendar contents, or screenshots containing private information.

## Rollout record

- Date (UTC): ____________________
- Tester initials or non-sensitive ID: ____________________
- Environment (local/staging/production): ____________________
- App release/commit: ____________________
- Browser/device versions: ____________________
- Overall result (PASS/FAIL): ____________________
- Non-sensitive issue references: ____________________

For each check, record `PASS`, `FAIL`, or `N/A`, plus a brief sanitized note.

## Deployment verification

| Result | Check | Sanitized notes |
|---|---|---|
| ___ | Public `config.js` contains only the Supabase URL and publishable key. | ____________________ |
| ___ | All eleven migrations were applied in filename order. | ____________________ |
| ___ | All six Edge Functions are deployed. | ____________________ |
| ___ | Both required Vault secret names exist; no values were copied into this record. | ____________________ |
| ___ | `family-hub-google-sync` is scheduled every five minutes and completes successfully. | ____________________ |
| ___ | The Google OAuth redirect URI exactly matches the deployed callback URL. | ____________________ |

## Functional rollout

| Result | Check | Sanitized notes |
|---|---|---|
| ___ | Sign in as the designated adult and connect the intended Google account. | ____________________ |
| ___ | List calendars, enable only the dedicated writable test calendar, and assign the intended Family Hub person. | ____________________ |
| ___ | Create a Google event and confirm it imports once into Family Hub. | ____________________ |
| ___ | Create a Family Hub event targeting the test calendar and confirm it appears once in Google. | ____________________ |
| ___ | Edit the imported event in Google and confirm Family Hub updates. | ____________________ |
| ___ | Edit the synchronized event in Family Hub and confirm Google updates. | ____________________ |
| ___ | Sync an all-day event in each direction and confirm the calendar date does not shift. | ____________________ |
| ___ | Sync a daily recurring event and confirm its frequency and end date. | ____________________ |
| ___ | Sync a weekly recurring event and confirm its frequency and end date. | ____________________ |
| ___ | Sync a monthly recurring event and confirm its frequency and end date. | ____________________ |
| ___ | Sync a yearly recurring event and confirm its frequency and end date. | ____________________ |
| ___ | Confirm a monthly series starting after the 28th and a yearly February 29 series stay local/read-only rather than showing different occurrences in Google. | ____________________ |
| ___ | Edit one Google occurrence and confirm the parent series remains visible, protected, and marked read-only after incremental sync. | ____________________ |
| ___ | Edit the same event in both systems before the next sync; confirm deterministic conflict handling without silent data loss or duplication. | ____________________ |
| ___ | Enable or encounter a read-only calendar/event; confirm it remains visible, clearly read-only, and cannot be written from Family Hub. | ____________________ |
| ___ | Choose delete everywhere for a synchronized event; confirm both copies are removed and the operation is not repeated. | ____________________ |
| ___ | Introduce a controlled transient network/service failure; confirm retry/backoff recovers without duplicate events. | ____________________ |
| ___ | Revoke Google authorization; confirm Family Hub requests reconnection without exposing a raw Google error. | ____________________ |
| ___ | Reconnect and confirm enabled calendars resume synchronization. | ____________________ |
| ___ | Disconnect using **Keep Family Hub copies**; confirm Google is unchanged and local copies remain local-only. | ____________________ |
| ___ | Reconnect as needed, then disconnect using **Remove Family Hub copies**; confirm Google is unchanged and imported local copies are removed. | ____________________ |
| ___ | Replay the same sync request, page, or job; confirm no duplicate event or mapping is created. | ____________________ |
| ___ | Confirm pre-existing local-only Family Hub events remain intact and local-only unless explicitly targeted to Google. | ____________________ |
| ___ | Open a second signed-in browser; confirm synchronized changes arrive through realtime without continuous browser polling. | ____________________ |
| ___ | Publish the v3 shell, close all app tabs, reopen, and if needed reload once; confirm the service worker serves the new UI/modules rather than the v2 cache. | ____________________ |

## Completion

- All required checks passed: YES / NO
- Failed checks have non-sensitive issue references and rollout is paused: YES / NO
- Rollback/hold decision: ____________________
- Approval initials and date: ____________________
