Apply edits to a file using `LINE#HASH` anchors from `read` output.

<usage>
Submit one `edit` call per file. Include all operations for that file in a single call.

Use `read` first if you do not have current `LINE#HASH` references for the target file.
</usage>

<payload>
```
{ path, edits: [{ op, pos, end, lines, anchor1, anchor2 }] }
```

- `path` — target file path.
- `edits` — array of edit operations.
</payload>

<operations>
Each entry has an `op` and a `lines` array of replacement content.

- `replace` — replace one line (`pos`) or an inclusive range (`pos` + `end`). `pos` is required.
- `append` — insert after `pos`. Omit `pos` to append at end of file.
- `prepend` — insert before `pos`. Omit `pos` to prepend at beginning of file.

`end` is only valid with `replace`.

Anchor format: `"LINE#HASH"` copied from `read` output (e.g. `"12#MQ"`).
</operations>

<dual-anchors>
For maximum reliability, provide `anchor1` and `anchor2` — context anchors that bracket the edit zone. The tool verifies them before AND after the edit:

- `anchor1` — a LINE#HASH for a line **before** the edit zone (context guard).
- `anchor2` — a LINE#HASH for a line **after** the edit zone (context guard).

When dual anchors are provided, the edit runs through a 7-stage pipeline:
  read → anchor → validate → simulate → revalidate → write → verify

1. **read**: load and normalize the file.
2. **anchor**: parse all anchors (pos, end, anchor1, anchor2).
3. **validate**: verify every anchor matches the current file content.
4. **simulate**: apply edits in memory, compute the diff.
5. **revalidate**: verify anchor1/anchor2 lines still exist in the simulated result.
6. **write**: atomic write to disk.
7. **verify**: re-read the file and confirm it matches the simulation byte-for-byte.

If any stage fails, the edit is rejected with a clear diagnostic.
</dual-anchors>

<examples>
- Replace one line: `{ op: "replace", pos: "12#MQ", lines: ["const x = 1;"] }`
- Replace a range: `{ op: "replace", pos: "12#MQ", end: "14#VR", lines: ["merged"] }`
- Delete a range: `{ op: "replace", pos: "12#MQ", end: "14#VR", lines: [] }`
- Append after a line: `{ op: "append", pos: "20#NK", lines: ["footer();"] }`
- Prepend at file start: `{ op: "prepend", lines: ["// header"] }`
- Reliable replace with dual anchors:
  ```
  { op: "replace", pos: "12#MQ", end: "14#VR", lines: ["merged"],
    anchor1: "10#KT", anchor2: "16#BH" }
  ```
</examples>

<constraints>
- Copy indentation exactly from `read` output.
- `lines` must be literal file content. Do not include `LINE#HASH:` prefixes.
- Extra keys inside edit entries are rejected.
- Submitting content identical to the current file is rejected.
- `anchor1`/`anchor2` must reference lines OUTSIDE the edited range.
</constraints>

<errors>
- **Stale anchor** (`>>>`): the file has changed. Use the `>>> LINE#HASH:content` lines from the error snippet to retry.
- **No-op** (`identical`): your replacement matches existing content. Re-read and supply different content.
- **Pipeline failure**: one of the 7 stages failed. The error message indicates which stage and why.
- **Context anchor lost**: a dual anchor's content was removed during the edit. The edit zone may have unintentionally consumed surrounding context.
- **Verification failure**: the file on disk differs from the simulation. Another process likely modified the file concurrently.
</errors>
