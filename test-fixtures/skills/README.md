# Test Skills — Manual Delivery Verification

Throwaway fixtures for manually verifying Live Delivery execution and context handoff
between blocks. Not production skills, not Marketplace content.

## echo-agent
- Input: `testMessage` (string)
- Output: `echoedMessage` (string) — equal to `testMessage`

## field-producer-agent
- Input: `seedText` (string)
- Output: `producedTitle` (string), `producedCount` (number), `producedTags` (string[]), `producedNotes` (string)

## field-consumer-agent
- Input: `producedTitle` (string), `producedCount` (number), `producedTags` (string[]), `producedNotes` (string)
- Output: `summaryLine` (string), `tagCount` (number), `receivedNotesPreview` (string)
- If any input field is missing/empty: `status: "needs_human"` with `humanGateReason`

These map to manually created Building Blocks — wiring is done by hand in the Desktop UI, not by this session.
