# M0 findings: does the registry thesis survive contact with real breakages?

15 documented breaking changes, 14 scored (one excluded, see below). Every date
traces to a source that was actually fetched; unverifiable claims are marked
rather than guessed. Run `npm run eval:score` to reproduce.

## The pre-registered bar

Written down before any data was collected: **≥70% union detection with a median
lead time of ≥30 days is a go.** On the announced class that bar is cleared —
median lead 86 days. But the number next to it, 100% detection, is close to
worthless, and the scorer now says so in its own output: a case is classified as
announced *because* research found the announcement, so that rate tends to 100%
regardless of how good any tool is.

The figure that is not circular: **57% of these breakages were announced
anywhere at all.**

## What the data actually says

**1. Silent breaking changes are not an edge case — they are 43% of the dataset.**
Six of fourteen had no announcement in any channel: not a changelog, not a spec,
not a blog post, not an email. For those, every document-watching strategy scores
zero by construction. No amount of crawling reaches a document that was never
written.

**2. Spec diffing is the weakest signal, not the strongest.**
Applicable to 6 of 14 cases, detecting 2, with a *worst* lead of −10 days —
Twilio regenerated its spec ten days after the shutoff, so for ten days the
published OpenAPI advertised endpoints that were already returning 400.

A pattern shows up three times and is worth stating plainly: **the API being
retired had no machine-readable spec, while the API being migrated *to* did.**
Twitter published an OpenAPI document for v2 and never for v1.1. Google has a
Discovery document for Places (New) and never had one for legacy Places.
OpenWeather had neither. Specs describe what a vendor wants you to adopt, not
what they are about to take away.

**3. Two cases are structurally invisible to schema monitoring.**
Zoom blanked guest email addresses across ~30 endpoints: same status, same field
names, same JSON shape, same types — only the *values* went empty. Volvo switched
fields from omitted to explicit `null` at HTTP 200. Neither a spec diff nor a
key-set diff nor a status-code monitor can see either one. Only value-level
assertions can.

**4. Announcement ≠ warning.**
Meta announced and enforced the same day: perfect detection, zero lead. Twitter's
announcement promised February 9, slipped to February 13, then to "a few more
days"; nothing was switched off on any of them and the real change landed 46 days
later — a monitor keyed on announced dates would have fired three false alarms.
OpenWeather's notice sat in an *HTML comment* for ~19 months, invisible to every
human reader.

**5. Announcements do not live where you would look for them.**
Google's shipped as a billing FAQ; it is still absent from their deprecations
page. Zoom's never reached the developer forum's Announcements category (verified
by enumerating every topic in the window). Twilio's SDK changelog for the very
commit that deleted 18 paths does not mention them. Stripe's earliest prose
signal is a file inside its spec repo, not its docs site.

**6. Calling the API is the only signal that generalises.**
Applicable to 14 of 14, detecting 13 — but at a median lead of **0 days**. It
cannot warn; it can only notice, fast.

## The verdict

**The registry thesis survives in a reduced form, and the product it implies is
not the one I set out to build.**

A registry of announcements is real and worth having — 86 days of median lead is
a great deal of warning, and Stripe shows a spec-watcher beating the vendor's own
changelog by 13 days. But it covers a bit over half of what breaks, it cannot be
made to cover the rest by crawling harder, and its coverage is worst exactly
where a vendor is least disciplined, which correlates with where breakage is most
likely.

So: **contract verification is the primary signal and the registry is the
accelerant**, not the other way round. Concretely, the ordering that follows from
this data is

1. record what each call site actually returned, at the level of field *types and
   values*, not shape;
2. re-check on a schedule and diff against that record;
3. use the registry, where a vendor publishes anything at all, to turn a 0-day
   detection into an 86-day warning and to explain *why* something changed.

## Caveats that limit these numbers

- **n = 14.** Directional, not statistical.
- **Survivorship.** Cases were found through public evidence of pain, so silent
  changes that nobody noticed and announced changes everybody handled cleanly are
  both under-represented. The 43% silent share is a property of *documented*
  breakages, not of all breakages.
- **`effective_at` is often a bound, not a point.** OpenWeather published only a
  month; Twitter rolled out in six waves and the schema's single date cannot
  express that; Twilio's stated EOL date was never independently observed.
- **One case excluded.** `google-places-legacy-designation` is recorded with
  `confidence: unverified` and kept out of the scoring: nothing was turned off,
  and counting it would have inflated the dataset. It stays in the repo because
  the exclusion is itself a judgement worth showing.
