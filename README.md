# react-native-enriched-markdown × Reanimated deadlock repro

Reproduction harness for [software-mansion/react-native-enriched-markdown#550](https://github.com/software-mansion/react-native-enriched-markdown/issues/550):
on iOS, `EnrichedMarkdownShadowNode::measureContent` `dispatch_sync`s to the
main thread during layout. When layout runs while the JS thread holds the
ShadowTree revision mutex and the main thread is blocked acquiring that mutex
for a Reanimated commit, the threads deadlock; iOS's watchdog kills the app
~60 s later with `0x8BADF00D`. Our production app logged **19 such kills in
one day**; this repo stages the exact preconditions in a minimal app.

## The confirmed mechanism (from symbolicated watchdog reports + instrumented RN)

In **stock** React Native, `ShadowTree::tryCommit` runs layout *without*
holding the revision mutex, and this deadlock cannot form. Four ingredients
change that:

1. **The library bug** — `measureContent` hops to the main thread with
   `dispatch_sync` (font-scale read on *every* measure, before the
   measurement cache is consulted, + mock-view measurement on cache misses).
2. **RN experimental: `preventShadowTreeCommitExhaustion`** (enabled at
   `releaseLevel = Experimental` — see `AppDelegate.swift`): when an
   optimistic commit fails **3 consecutive times** (`ShadowTree.cpp`,
   `MAX_COMMIT_ATTEMPTS_BEFORE_LOCKING`), the JS thread re-runs the ENTIRE
   commit — **layout included — holding `revisionMutexRecursive_`**.
3. **Reanimated: `DISABLE_COMMIT_PAUSING_MECHANISM`** (`package.json` →
   `reanimated.staticFeatureFlags`): Reanimated keeps committing from the
   main thread every frame even while React commits. Each such commit bumps
   the revision and fails the JS thread's in-flight attempt — that's the
   contention driving ingredient 2 — and once the JS thread holds the mutex,
   the next Reanimated commit blocks main on `sharedRevisionLock`.
4. **Workload** — streaming markdown + bulk history/pagination mounts keep
   measured layout slow, so optimistic commits keep losing races.

Once the JS thread is inside the locked commit and main is parked on the
mutex, the next `dispatch_sync(main)` from `measureContent` completes the
cycle. Full production stacks (20 `.ips` reports, all identical):

**JS thread** — inside the locked fallback commit:

```
__ulock_wait → _dispatch_sync_f_slow → __DISPATCH_WAIT_FOR_QUEUE__
facebook::react::ENRMFontScaleForMeasurement(bool)
facebook::react::ENRMMeasureMarkdownContent<…>
facebook::react::EnrichedMarkdownShadowNode::measureContent
facebook::yoga::calculateLayout … RootShadowNode::layoutIfNeeded
facebook::react::ShadowTree::tryCommit
facebook::react::ShadowTree::commit          ← exhaustion wrapper, mutex held
facebook::react::UIManager::completeSurface  ← ordinary React commit
```

**Main thread** — Reanimated committing, blocked on the mutex:

```
__psynch_mutexwait → std::recursive_mutex::lock
facebook::react::ShadowTree::sharedRevisionLock
facebook::react::ShadowTree::tryCommit
reanimated::ReanimatedModuleProxy::commitUpdates → performOperations
-[REANodesManager maybeFlushUIUpdatesQueue]
```

Instrumented runs of this repro (see [INSTRUMENTATION.md](INSTRUMENTATION.md))
show the full chain live on a physical iPhone: a constant stream of
`commit FAILED` lines and `LOCKED FALLBACK ENGAGED` within minutes of
streaming. Each engagement that re-measures dirty text rolls the deadlock
dice; the freeze itself is therefore probabilistic per engagement — our
production chat (heavier trees, more animations, all-day usage) loses that
roll many times a day.

Two consequences for the library, independent of each other:

- **The deadlock**: `measureContent` must never block on the main thread
  while layout may be running under a lock a main-thread committer also
  wants. RN is free to hold locks around layout — the experimental flag
  above does exactly that today.
- **The jank**: even when it doesn't deadlock, the `dispatch_sync` design
  serializes *all* markdown measurement onto the main thread, visibly
  stuttering animations and scroll during streaming.

## ⚠️ Physical iPhone required

On an M-series simulator, measurement completes in microseconds: commits
almost never fail 3×, and the `dispatch_sync` windows are vanishingly small.
On a physical iPhone the locked fallback engages within seconds of
streaming. Simulator testing will not show the bug.

## Versions / configuration

| Package | Version |
|---|---|
| react-native-enriched-markdown | 0.7.4 (affected code identical on `main`) |
| react-native | 0.86.0 (New Arch / Fabric, `releaseLevel: Experimental`) |
| react-native-reanimated | 4.5.0 (`DISABLE_COMMIT_PAUSING_MECHANISM: true`) |
| react-native-worklets | 0.10.0 |
| react | 19.2.3 |

Both flags mirror our production configuration (Expo
`reactNativeReleaseLevel: 'experimental'` + the Reanimated static flag).

## Run it

```sh
npm install          # or yarn / bun install
cd ios
bundle install       # first time only
bundle exec pod install
cd ..
```

Open `ios/EnrichedDeadlockRepro.xcworkspace` in Xcode, select your
**physical device**, and Run (Release works too — no Metro needed).

The app self-drives: a shimmer animates alone first (loading state), then 60
markdown cards mount in one commit ("history render"), then 5 cards stream
token-batches every 30 ms while 40-card pagination bursts land every 4 s
(list capped at 80 cards to bound memory).

When the deadlock lands: the shimmer freezes, and ~60 s later iOS's
watchdog kills the app with `0x8BADF00D`. Pausing in Xcode during the freeze
shows the two stacks above. Knobs that widen the odds: `STREAMING_HEADS`,
`STREAM_INTERVAL_MS`, `HISTORY_COUNT`, `PAGE_SIZE` in `App.tsx`.

## Watching the mechanism (optional)

[INSTRUMENTATION.md](INSTRUMENTATION.md) documents three small `fprintf`
probes (RN core built from source via `RCT_USE_PREBUILT_RNCORE=0`, Reanimated,
and the markdown library) that stream the commit failures, locked-fallback
engagements, and measure timings to the console — enough to watch every
precondition fire without waiting for the watchdog.
