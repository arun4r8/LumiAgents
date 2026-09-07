# Test doubles

> A double for an external system must be built from **that system's documentation**,
> not from the code that calls it. Built from the caller, it can only ever prove
> self-consistency.

## Why this document exists

On 2026-09-07 a bug shipped that a complete, mutation-tested unit suite could not
have caught.

`fakeSam` — the double for the SAM.gov opportunity API — simulated paging by
**record offset**. So did the implementation. SAM.gov documents `offset` as a **page
index** ("Indicates the page index. Default offset starts with 0") with `limit`
being records *per page*.

The double and the code agreed about a thing they were both wrong about. Every
pagination test passed. Every mutation was caught. In production the second page of
a walk asked for page 63 of a 91-record set, got nothing back, read that as
"exhausted", and silently returned 133 of 161 notices.

**Mutation testing does not protect against this.** It proves the tests notice when
the *code* changes. It cannot notice when the *model of the external system* is
wrong, because the double encodes the same model.

## The three rules

### 1. Build the double from the documentation, and say so in the file

Every double for an external system carries a comment naming the behaviour it models
and where that came from — ideally a quote. If the contract is uncertain, the
uncertainty belongs written down in the double rather than resolved by guessing.

`fakeSam` in `runtime/tests/unit/sam-search-query.test.ts` is the worked example.

### 2. Fix the double first

When a double turns out to be wrong, correct **the double** before touching the
source. The tests that then fail are the evidence that the double was the problem —
and the count they fail with is often the production number. Correcting `fakeSam`
first made two tests fail at exactly `133 of 161`, before a line of source changed.

Fix the code first and that evidence is gone.

### 3. A test that cannot fail is worse than no test

It reads as coverage. Two kinds to watch for, both of which were in this repo:

**Tautological assertions** — reading back a value you just passed in.
`sam-search-query.test.ts` asserted `offset` appears on the URL with the value
given, which holds no matter what `offset` means.

**Mirrored implementations** — `llm-documents.test.ts` re-implemented
`buildUserContent` locally and asserted against the copy. A mirror and its original
agree with each other by construction.

## Priority: systems that fail silently

The highest-risk doubles stand in for systems where a **wrong input produces a
plausible successful response** rather than an error.

SAM.gov is the canonical case here and has now produced four separate bugs, because
it ignores unknown query parameters with no error:

| sent | reality | consequence |
|---|---|---|
| `naicsCode` | the parameter is `ncode` | no NAICS filter at all; the "match set" was the whole corpus |
| `status=active` | documented "Coming Soon" | closed notices swept for months |
| `offset` as a record offset | it is a page index | second page always empty; walks stopped early |
| `description` read as prose | it is a URL | the scoring model never saw a notice body |

PostgREST is the other: a schema-qualified path 404s, and a caller that skips
`res.ok` reads the error body as an empty result (#223).

## Checklist for a new double

- [ ] Which documented behaviour does it model, and is that written in the file?
- [ ] Error shapes: does the real system return an error *body* with a success-shaped
      status, or a status the caller ignores?
- [ ] Pagination: page index or record offset? Must the page size stay constant?
- [ ] Silently-ignored inputs: does the real system reject an unknown parameter, or
      quietly proceed without it?
- [ ] Truncation: can a response come back partial and still parse?
- [ ] Field names: exact casing (SAM's `responseDeadLine` has an unusual capital L).
- [ ] Empty results: what does "nothing matched" actually look like on the wire?
