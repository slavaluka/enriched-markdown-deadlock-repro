# react-native-enriched-markdown × Reanimated deadlock repro

Minimal reproduction for [software-mansion/react-native-enriched-markdown#550](https://github.com/software-mansion/react-native-enriched-markdown/issues/550):
on iOS, `EnrichedMarkdownShadowNode::measureContent` `dispatch_sync`s to the
main thread while holding the ShadowTree commit lock; if the main thread is
simultaneously committing a Reanimated animation batch
(`ShadowTree::tryCommit` → `sharedRevisionLock`), the two threads deadlock.
The app hard-freezes and iOS's watchdog kills it ~60 s later with
`0x8BADF00D` ("app is stuck").

## ⚠️ Physical iPhone required

**This does not reproduce on the iOS Simulator — that is the bug's
signature, not a flaw in the repro.** The race window is the time spent in
measured layout while holding the commit lock: microseconds on an M-series
Mac running the simulator, hundreds of milliseconds on an iPhone laying out
heavy markdown. On device the collision with a per-frame Reanimated commit
is near-certain; on simulator it is effectively unobservable.

## Versions

| Package | Version |
|---|---|
| react-native-enriched-markdown | 0.7.4 (affected code identical on `main`) |
| react-native | 0.86.0 (New Architecture / Fabric) |
| react-native-reanimated | 4.5.0 |
| react-native-worklets | 0.10.0 |
| react | 19.2.3 |

## Run it

```sh
npm install          # or yarn / bun install
cd ios
bundle install       # first time only
bundle exec pod install
cd ..
```

Open `ios/EnrichedDeadlockRepro.xcworkspace` in Xcode, select your
**physical device**, and Run. (Release configuration works too and needs no
Metro.)

## What you'll see

1. The screen renders 50 `EnrichedMarkdownText` cards (~3 KB of unique
   markdown each) under an animated bar.
2. Tap **"Load 30 more"** a few times to trigger fresh measurement passes.
3. Within seconds the UI hard-freezes (the animated bar stops).
4. ~60 s later iOS's watchdog terminates the app with `0x8BADF00D`. The
   `.ips` crash report shows the two-thread cycle below.

## Catching it in the debugger (no watchdog wait needed)

When the freeze hits, pause in Xcode (Debug → Pause) and inspect the threads:

**JS/layout thread** — holds the ShadowTree commit lock, blocked joining main:

```
__ulock_wait → _dispatch_sync_f_slow → __DISPATCH_WAIT_FOR_QUEUE__
facebook::react::ENRMFontScaleForMeasurement(bool)
facebook::react::ENRMMeasureMarkdownContent<…>
facebook::react::EnrichedMarkdownShadowNode::measureContent
facebook::yoga::calculateLayout … RootShadowNode::layoutIfNeeded
```

**Main thread** — Reanimated committing, blocked on the commit lock:

```
__psynch_mutexwait → std::recursive_mutex::lock
facebook::react::ShadowTree::sharedRevisionLock
facebook::react::ShadowTree::tryCommit
reanimated::ReanimatedModuleProxy::commitUpdates → performOperations
-[REANodesManager maybeFlushUIUpdatesQueue]
```

## How the repro stages the deadlock

The deadlock needs three ingredients; `App.tsx` stages each deliberately:

1. **Slow measurement under the commit lock** — a FlatList of
   `EnrichedMarkdownText` items with a few KB of markdown each. Content is
   unique per item to defeat the measurement cache, forcing the cache-miss
   mock-view measurement. (The font-scale `dispatch_sync` in
   `ENRMFontScaleForMeasurement` runs before the cache is consulted, so even
   cached content keeps one sync-to-main per measure.)
2. **A main-thread ShadowTree committer** — a `withRepeat(withTiming(...))`
   Reanimated loop animating **width** (a layout prop), guaranteeing the
   update flows through `ShadowTree::tryCommit` on the main thread every
   frame.
3. **Repeated measurement passes** — the "Load 30 more" button appends fresh
   items on demand, re-rolling the dice until the interleaving hits (in
   practice: seconds).

Root-cause analysis, watchdog reports, and a suggested fix direction are in
[issue #550](https://github.com/software-mansion/react-native-enriched-markdown/issues/550).
