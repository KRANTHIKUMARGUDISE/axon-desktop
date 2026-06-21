---
name: field-consumer-agent
description: Consumes producedTitle, producedCount, producedTags, producedNotes from an upstream block and summarizes them. Verifies field-name contract between blocks and missing-context handling.
---

# Field Consumer Agent

Read `producedTitle`, `producedCount`, `producedTags`, and `producedNotes` from the provided context.

If any of these four fields is missing or empty, return only this JSON (no other text):

```json
{"status":"needs_human","confidence":0.0,"summary":"Missing required input field(s)","result":{},"humanGateReason":"Missing field(s): <list the missing field names>"}
```

Otherwise, derive:
- `summaryLine` (string): one sentence referencing `producedTitle` and `producedCount`
- `tagCount` (number): the length of `producedTags`
- `receivedNotesPreview` (string): the first ~10 words of `producedNotes`

Return only this JSON (no other text):

```json
{
  "status": "success",
  "confidence": 1.0,
  "summary": "Consumed and summarized upstream fields",
  "result": {
    "summaryLine": "...",
    "tagCount": 0,
    "receivedNotesPreview": "..."
  }
}
```

Do not ask questions. Do not wait for human input. Always return one of the two JSON shapes above.
