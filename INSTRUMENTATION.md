# Watching the deadlock preconditions live

Three tiny `fprintf(stderr, …)` probes make the whole failure chain visible
in the device console (`xcrun devicectl device process launch --console …`).
They are applied to `node_modules` sources, so they are not checked in —
re-apply after `npm install`.

## 1. React Native — commit failures + locked fallback

RN core ships prebuilt; switch to a source build first:

```sh
cd ios && RCT_USE_PREBUILT_RNCORE=0 bundle exec pod install
```

In `node_modules/react-native/ReactCommon/react/renderer/mounting/ShadowTree.cpp`,
inside `ShadowTree::commit`'s `preventShadowTreeCommitExhaustion()` branch
(add `#include <pthread.h>`, `<atomic>`, `<cstdio>` at the top):

```cpp
while (attempts < MAX_COMMIT_ATTEMPTS_BEFORE_LOCKING) {
  auto status = tryCommit(transaction, commitOptions);
  if (status != CommitStatus::Failed) {
    return status;
  }
  attempts++;
  fprintf(stderr, "[REPRO-RN] commit FAILED attempt=%d source=%d main=%d\n",
          attempts, (int)commitOptions.source, pthread_main_np());
}

{
  fprintf(stderr, "[REPRO-RN] LOCKED FALLBACK ENGAGED source=%d main=%d\n",
          (int)commitOptions.source, pthread_main_np());
  std::unique_lock lock(revisionMutexRecursive_);
  auto lockedStatus = tryCommit(transaction, commitOptions);
  fprintf(stderr, "[REPRO-RN] LOCKED FALLBACK DONE status=%d\n", (int)lockedStatus);
  return lockedStatus;
}
```

A `LOCKED FALLBACK ENGAGED` with no matching `DONE`, followed by silence and
a watchdog kill, is the deadlock.

## 2. Reanimated — main-thread commit pressure

In `node_modules/react-native-reanimated/Common/cpp/reanimated/NativeModules/ReanimatedModuleProxy.cpp`,
at the top of `performOperations` after the updates batch is flushed:

```cpp
fprintf(stderr, "[REPRO] perfOps main=%d batch=%zu skip=%d\n",
        pthread_main_np(), updatesBatch.size(),
        (int)updatesRegistryManager_->shouldReanimatedSkipCommit());
```

With `DISABLE_COMMIT_PAUSING_MECHANISM` set you'll see `skip=0` always —
Reanimated never yields to in-flight React commits.

## 3. Markdown measurement — the dispatch_sync traffic

In `node_modules/react-native-enriched-markdown/ios/internals/ShadowMeasurementUtils.h`,
at the top of `ENRMMeasureMarkdownContent`, time the call and log
`pthread_main_np()` and `typedProps.markdown.size()`. On device you'll see
measures of 2–10 KB markdown taking 30–80 ms on a background thread — each
one round-tripping through the main queue at least once (font scale), which
is both the deadlock window and the streaming jank.

## What a healthy-but-doomed run looks like

```
[REPRO] perfOps main=1 batch=1 skip=0            ← Reanimated committing every frame
[REPRO] measure main=0 len=6877 took=55ms        ← slow measured layout, off-main
[REPRO-RN] commit FAILED attempt=1 source=0 main=0
[REPRO-RN] commit FAILED attempt=2 source=0 main=0
[REPRO-RN] commit FAILED attempt=3 source=0 main=0
[REPRO-RN] LOCKED FALLBACK ENGAGED source=0 main=0   ← layout now holds the mutex
[REPRO-RN] LOCKED FALLBACK DONE status=0             ← survived this roll
…
[REPRO-RN] LOCKED FALLBACK ENGAGED source=0 main=0   ← eventually: no DONE, freeze,
                                                        watchdog 0x8BADF00D
```
