# Benchmark faces

Everything in this directory except this file is gitignored. It is hundreds of
megabytes of public research images and the embeddings derived from them, all of
it re-downloadable, and none of it belongs in the repository.

## Why it exists

Every accuracy figure this project quoted before now came from a gallery of
about eight people. That is not evidence of anything.

FacePay runs 1:N identification — the customer presents nothing, so the system
compares their face against every enrolled identity. Each extra enrollment is
another chance to be confused with someone else, and the false match rate of the
system as a whole grows roughly as N times the rate of one comparison. "Nobody
was falsely matched against seven other people" tells you almost nothing about
what happens at two thousand, which is the smallest number that starts to
resemble a single shop's regular customers.

So the gallery gets filled with a few thousand real, distinct faces, and the
measurement is taken again.

## What the faces are

[Labeled Faces in the Wild](https://vis-www.cs.umass.edu/lfw/) (LFW), funneled
version — 13,233 photographs of 5,749 people, collected from news photographs
and published as a face-recognition benchmark.

> Gary B. Huang, Manu Ramesh, Tamara Berg, and Erik Learned-Miller.
> *Labeled Faces in the Wild: A Database for Studying Face Recognition in
> Unconstrained Environments.* University of Massachusetts, Amherst,
> Technical Report 07-49, October 2007.

People with two or more photographs are what make a genuine-pair measurement
possible: one image becomes the stored identity, a second image from a different
day becomes the probe. A benchmark that matched an image against itself would
only be measuring arithmetic.

**What the shipped files hold:**

```
gallery.jsonl    5,486 identities embedded, 1,481 of them with a held-out probe
results.json     the measured run: gallery 5,182, genuine probes 1,181,
                 strangers 300
partial.jsonl      600 rows, a checkpoint from a shorter run
pad-models/      the two MiniFASNets plus the 8 reference images the
                 anti-spoof pipeline was checked against
```

The measured gallery is 5,182 rather than 5,486 because 300 probed identities
are held out as strangers and a handful more were removed as dataset label
errors — see below.

## What they are not

They are not customers, and the code says so in more than a comment.

Nobody in a research dataset agreed to be part of a payment system. Benchmark
rows are stored with `source: 'benchmark'`, they have no PIN, and the two places
where an identity turns into a consequence refuse them by name:

- `paymentController.charge` will not charge one. If a live face out-scores
  every real customer against a benchmark row, the payment is refused and the
  event is logged as the false match it is — rather than being left to fail one
  step later at the PIN check, where it would be filed as "this customer never
  set a PIN" and the one event most worth seeing would disappear into a routine
  one.
- `findExistingRegistration` will not collapse a new registration into one.
  Merging would be the worst outcome available: a real person's identity written
  onto a research record, and every later payment of theirs refused.

They *are* in the candidate pool, deliberately. That is the entire point.

## What this does and does not measure

It measures the recognition model at a realistic gallery size. That is the thing
that was previously unmeasured, and it is worth having.

It does not measure FacePay's accuracy for the people who will actually use it.
LFW was assembled from mid-2000s English-language news photography and is
heavily skewed toward white, male, American public figures. FacePay is being
built for Indian customers. Face recognition error rates are known to vary by
demographic group, and a threshold validated on this gallery is not thereby
validated on that population.

Both things are true and both should be said out loud: 5,182 LFW identities is a
far better basis than 8 friends, and it is not a substitute for measuring on the
population the system is for. The live enrollments collected from real users are
still the more relevant dataset — they are just far too small to say anything
about scale on their own.

## Two dataset errors that had to be handled first

Both are reported rather than quietly dropped, because ignoring them would have
made the headline number look *worse* than the truth and fixing them silently
would have made it untrustworthy.

- **One person filed under two names.** Four identity pairs score above 0.85
  against each other. Andrew Caldecott and Andrew Gilligan at 0.956 are
  literally the same photograph.
- **One folder holding two people.** Six probes match somebody else while
  scoring near zero against their own row. Kate Capshaw's second photograph is
  Steven Spielberg's.

Counted as recognition failures, these would have reported 0.51% wrong-person
instead of 0.00%. They are dataset noise, not model error, and `results.json`
lists every one.

## What was measured on this data, and what was not

| done | why |
|---|---|
| 1:N identification at N = 5,182 | the only claim worth making about a system with no identifier |
| the runner-up margin, with and without | it takes wrong-person from 0.17% to 0.00% — the whole argument for the two-condition rule |
| 2,000 identities loaded into the real database | proves the encrypted code path, not just a script |
| exact bucketed search over 5,486 embeddings | to find out whether pruning helps. It does not — 0 buckets skipped, 3.6-7.7x slower |
| 120 captures through the anti-spoof models | a domain-shift check: 9.2% of real faces were called attacks |

| not done | why |
|---|---|
| training or fine-tuning anything | LFW is a benchmark, not training data for this, and touching the weights would invalidate every number above |
| an approximate vector index | the margin rule needs the true runner-up; an index that misses it reports a *wider* margin than exists, turning an `ambiguous` into a confident wrong name |
| calibrating the PAD threshold here | 120 LFW captures are a different camera, different lighting, different era. Calibration needs real captures — `tools/silent_pad.py --data` |
| quoting an FRR for real customers | 9 of 17 enrolled users have been scanned once or never |

## Reproducing it

    # 1. fetch and unpack (~230MB)
    curl -L -o lfw-funneled.tgz https://ndownloader.figshare.com/files/5976015
    tar -xzf lfw-funneled.tgz

    # 2. look at the dataset before choosing any threshold for it
    cd ../ml-service
    python tools/embed_dataset.py --root ../benchmark-data/lfw_funneled --report-only

    # 3. embed it — one image per identity for the gallery, one held out as a probe.
    #    This is the run that produced the shipped gallery.jsonl: every identity
    #    with a usable face, and a probe wherever a second photo exists.
    python tools/embed_dataset.py \
        --root ../benchmark-data/lfw_funneled \
        --out ../benchmark-data/gallery.jsonl \
        --min-images 1 --enroll-images 1 --probe-images 1

    #    Add --identities 2000 for a smaller, much faster run. The numbers in the
    #    root README are from the full one.

    # 4. measure 1:N on the model
    python tools/benchmark_1n.py \
        --gallery ../benchmark-data/gallery.jsonl \
        --holdout 300 --json ../benchmark-data/results.json

    # 5. load into the real database and measure the real system
    cd ../backend
    node src/scripts/loadBenchmark.js ../benchmark-data/gallery.jsonl
    node src/scripts/measureAccuracy.js

To take them back out again:

    node src/scripts/loadBenchmark.js --clear
