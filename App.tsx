/**
 * Repro for software-mansion/react-native-enriched-markdown#550
 *
 * iOS device-only deadlock. The full mechanism (see README.md):
 *
 * 1. `EnrichedMarkdownShadowNode::measureContent` dispatch_syncs to the main
 *    thread (library bug — the upstream issue).
 * 2. RN's experimental `preventShadowTreeCommitExhaustion` flag adds a
 *    fallback: after 3 failed optimistic commits, the JS thread re-runs the
 *    ENTIRE commit — layout included — holding the revision mutex.
 * 3. Reanimated's `DISABLE_COMMIT_PAUSING_MECHANISM` keeps main-thread
 *    animation commits flowing during React commits, providing both the
 *    contention that trips the fallback and the thread that then blocks on
 *    the mutex.
 * 4. Streaming markdown (this file) supplies continuous slow JS commits.
 *
 * JS thread: holds revision mutex → measureContent → dispatch_sync(main).
 * Main thread: Reanimated commit → sharedRevisionLock → blocked. Deadlock.
 *
 * ⚠️ Reproduces on PHYSICAL iPhones only — on simulator, measurement is so
 * fast that commits rarely fail 3× and the dispatch_sync windows are tiny.
 */

import React, { memo, useEffect, useRef, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { EnrichedMarkdownText } from 'react-native-enriched-markdown';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import {
  SafeAreaProvider,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';

const HISTORY_COUNT = 60; // messages mounted in ONE commit after "loading"
const HISTORY_DELAY_MS = 1500; // shimmer animates alone first, like a loader
const PAGE_SIZE = 40; // pagination burst size
const PAGE_INTERVAL_MS = 4000;
const MAX_CARDS = 80; // bound memory: ScrollView keeps everything mounted
const STREAMING_HEADS = 5; // concurrently "streaming" messages at the top
const STREAM_INTERVAL_MS = 30;
const COMPLETE_AT_CHARS = 4000;

/** A few KB of markdown, unique per seed — defeats the measurement cache. */
function makeMarkdown(seed: number): string {
  const parts: string[] = [`## Message ${seed} — deadlock repro payload`];
  for (let section = 0; section < 3; section++) {
    parts.push(
      `### Section ${seed}.${section}\n\n` +
        `Paragraph ${section} of message ${seed}: **bold run ${seed}-${section}**, ` +
        `*italic run*, \`inline code ${seed}\`, and a [link](https://example.com/${seed}/${section}) ` +
        `so the attributed string has plenty of distinct runs to lay out.`,
      `- list item one for ${seed}.${section}\n` +
        `- list item two with **emphasis ${section}**\n` +
        `  - nested item (${seed}.${section})`,
      '```swift\n' +
        `let window = lockedCommit(seed: ${seed}, section: ${section})\n` +
        'dispatch_sync(DispatchQueue.main) { /* boom */ }\n' +
        '```',
    );
  }
  return parts.join('\n\n');
}

/** One streamed "token batch", unique every tick — keeps every measure a cache miss. */
function makeChunk(seq: number, len: number): string {
  return (
    ` Streamed chunk ${seq}@${len} with **bold**, \`code\`, and a ` +
    `[link](https://example.com/${seq}/${len}) keeping runs varied.`
  );
}

/**
 * The main-thread committer and contention source. Animating WIDTH (a layout
 * prop) flows through ShadowTree commits from the main thread every frame —
 * with DISABLE_COMMIT_PAUSING_MECHANISM these never pause, so each one can
 * fail the JS thread's optimistic commit and, once the JS thread holds the
 * revision mutex, each one blocks main on that mutex.
 */
function ShimmerBar() {
  const width = useSharedValue(40);
  useEffect(() => {
    width.set(
      withRepeat(
        withTiming(300, { duration: 600, easing: Easing.inOut(Easing.quad) }),
        -1,
        true,
      ),
    );
  }, [width]);
  const animatedStyle = useAnimatedStyle(() => ({ width: width.get() }));
  return (
    <View style={styles.shimmerTrack}>
      <Animated.View style={[styles.shimmerBar, animatedStyle]} />
    </View>
  );
}

type Card = { id: number; md: string };

const MarkdownCard = memo(function MarkdownCard({ md }: { md: string }) {
  return (
    <View style={styles.card}>
      <EnrichedMarkdownText markdown={md} />
    </View>
  );
});

function ReproScreen() {
  const insets = useSafeAreaInsets();
  const [cards, setCards] = useState<Card[]>([]);
  const [streaming, setStreaming] = useState(true);
  const seqRef = useRef(0);

  // "History render": after the shimmer has been animating alone for a
  // moment (like a chat loading indicator), mount the whole history in ONE
  // commit. Measuring HISTORY_COUNT fresh markdown nodes makes this commit —
  // and each of its retries — slower than Reanimated's commit interval, so
  // it fails MAX_COMMIT_ATTEMPTS_BEFORE_LOCKING times and drops into the
  // locked fallback where layout holds the revision mutex.
  useEffect(() => {
    const id = setTimeout(() => {
      seqRef.current = HISTORY_COUNT;
      setCards(
        Array.from({ length: HISTORY_COUNT }, (_, i) => ({
          id: i,
          md: makeMarkdown(i),
        })),
      );
    }, HISTORY_DELAY_MS);
    return () => clearTimeout(id);
  }, []);

  // "Pagination": periodically append a burst of fresh messages in one
  // commit — the same mega-commit shape as loading older history.
  useEffect(() => {
    if (!streaming) {
      return;
    }
    const id = setInterval(() => {
      setCards(prev => {
        if (prev.length === 0) {
          return prev;
        }
        const base = seqRef.current;
        seqRef.current += PAGE_SIZE;
        const appended = [
          ...prev,
          ...Array.from({ length: PAGE_SIZE }, (_, i) => ({
            id: base + i,
            md: makeMarkdown(base + i),
          })),
        ];
        if (appended.length <= MAX_CARDS) {
          return appended;
        }
        return [
          ...appended.slice(0, STREAMING_HEADS),
          ...appended.slice(appended.length - (MAX_CARDS - STREAMING_HEADS)),
        ];
      });
    }, PAGE_INTERVAL_MS);
    return () => clearInterval(id);
  }, [streaming]);

  // Chat-style streaming: grow the top cards every tick; when one exceeds
  // COMPLETE_AT_CHARS, start a fresh streaming card above it. Every tick is
  // a React commit whose measured layout races Reanimated's frame commits.
  useEffect(() => {
    if (!streaming) {
      return;
    }
    const id = setInterval(() => {
      setCards(prev => {
        if (prev.length === 0) {
          return prev;
        }
        const next = [...prev];
        for (let i = 0; i < STREAMING_HEADS && i < next.length; i++) {
          const card = next[i];
          next[i] = { id: card.id, md: card.md + makeChunk(card.id, card.md.length) };
        }
        if (next[0].md.length > COMPLETE_AT_CHARS) {
          const seed = ++seqRef.current;
          // negative id: keep stream-head keys disjoint from pagination keys
          next.unshift({ id: -seed, md: makeMarkdown(seed) });
        }
        return next;
      });
    }, STREAM_INTERVAL_MS);
    return () => clearInterval(id);
  }, [streaming]);

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Text style={styles.title}>enriched-markdown deadlock repro</Text>
        <ShimmerBar />
        <Pressable style={styles.button} onPress={() => setStreaming(s => !s)}>
          <Text style={styles.buttonLabel}>
            {streaming ? 'Streaming… (tap to pause)' : 'Start streaming'} —{' '}
            {cards.length} cards
          </Text>
        </Pressable>
        <Text style={styles.hint}>
          Physical device only. Leave streaming on — the shimmer should stop
          within ~a minute (deadlock); ~60 s later iOS's watchdog kills the
          app (0x8BADF00D).
        </Text>
      </View>
      <ScrollView>
        {cards.map(card => (
          <MarkdownCard key={card.id} md={card.md} />
        ))}
      </ScrollView>
    </View>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <StatusBar barStyle="dark-content" />
      <ReproScreen />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f2f2f7',
  },
  header: {
    paddingHorizontal: 16,
    paddingBottom: 12,
    gap: 8,
  },
  title: {
    fontSize: 17,
    fontWeight: '600',
  },
  shimmerTrack: {
    height: 10,
    borderRadius: 5,
    backgroundColor: '#e0e0e6',
    overflow: 'hidden',
  },
  shimmerBar: {
    height: 10,
    borderRadius: 5,
    backgroundColor: '#5856d6',
  },
  button: {
    backgroundColor: '#007aff',
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center',
  },
  buttonLabel: {
    color: '#fff',
    fontWeight: '600',
  },
  hint: {
    fontSize: 12,
    color: '#6e6e73',
  },
  card: {
    backgroundColor: '#fff',
    borderRadius: 12,
    marginHorizontal: 16,
    marginBottom: 12,
    padding: 12,
  },
});
