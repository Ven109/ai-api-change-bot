# The breakage dataset

Twenty real API changes that broke real code, with the dates and the sources as
they were at the time.

Everything in the registry project is a bet on one number, and this is where
that number comes from:

> For a change that broke people, **would we have known, and how far ahead?**

## Why it is built this way

**Lead time is the product, so `announced_at` and `effective_at` are separate
fields.** Detecting a breakage on the day it breaks is nearly worthless.
Detecting it five months out is a different product. Collapsing those two dates
into one "date" column would destroy the only measurement that matters.

**Silent changes are deliberately over-sampled.** If a dataset only contains
changes that were announced, a changelog-watching approach scores beautifully
and the number means nothing. Cases with `announced_at: none-found` are the
ones that decide whether monitoring documents is sufficient or whether the
product has to verify contracts against the live API.

**Every claim carries a URL.** A case whose dates cannot be re-derived from its
sources by a second person is not evidence, it is folklore. Where a page has
changed since, the archived copy is cited instead.

**"Unverified" is a permitted value and an honest one.** A dataset that admits
what it does not know is worth more than one that guesses, because the guesses
land in the coverage number and quietly flatter it.

## Layout

```
eval/cases/*.yaml     one file per case
eval/schema.json      the shape, and what each field means
eval/score.ts         replays each case per signal → detection rate + lead time
```

## Scoring

`eval/score.ts` asks, for each case and each signal independently, what that
signal would have known and when:

| Signal | Question |
| --- | --- |
| `spec` | was there an OpenAPI description, and did it change before `effective_at`? |
| `changelog` | did a dated entry appear naming this endpoint? |
| `headers` | did the endpoint send `Deprecation` / `Sunset` itself? |
| `sdk` | did the vendor's own SDK release notes mention it? |
| `contract` | would calling the endpoint have revealed it, with no announcement at all? |

The output is a detection rate and a lead-time distribution per signal, the
union across all signals, and the list of cases nothing would have caught.

**The threshold was set before the data was collected:** ≥70% union detection
with a median lead time of ≥30 days is a go. Below that, a registry of
announcements is not the product, and contract verification is.
