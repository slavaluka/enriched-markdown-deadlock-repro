/**
 * Repro for software-mansion/react-native-enriched-markdown#550
 *
 * iOS device-only deadlock: EnrichedMarkdownShadowNode::measureContent
 * dispatch_syncs to the main thread while holding the ShadowTree commit
 * lock, while Reanimated's main-thread commit blocks on that same lock.
 *
 * ⚠️ Reproduces on PHYSICAL iPhones only. The race window is the time
 * spent in measured layout under the commit lock — microseconds on a
 * simulator, hundreds of milliseconds on a device. See README.md.
 */

import React, { useEffect, useMemo, useState } from 'react';
import {
  FlatList,
  Pressable,
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

const INITIAL_COUNT = 50;
const PAGE_SIZE = 30;

/**
 * A few KB of markdown, unique per item. Uniqueness matters: it defeats the
 * library's measurement cache, so every item forces the full cache-miss
 * mock-view measurement (dispatch_sync #3), on top of the font-scale sync
 * (dispatch_sync #1) that runs on every measure regardless.
 */
function makeMarkdown(seed: number): string {
  const parts: string[] = [`## Message ${seed} — deadlock repro payload`];
  for (let section = 0; section < 4; section++) {
    parts.push(
      `### Section ${seed}.${section}\n\n` +
        `This is paragraph ${section} of message ${seed}. It exists to make ` +
        `measured layout expensive on device: **bold run ${seed}-${section}**, ` +
        `*italic run*, \`inline code ${seed}\`, and a [link](https://example.com/${seed}/${section}) ` +
        `so the attributed string has plenty of distinct runs to lay out.`,
      `- list item one for ${seed}.${section}\n` +
        `- list item two with **emphasis ${section}**\n` +
        `- list item three with \`code-${seed}\`\n` +
        `  - nested item a\n` +
        `  - nested item b (${seed}.${section})`,
      '```swift\n' +
        `// code block ${seed}.${section}\n` +
        `let window = measureContent(seed: ${seed}, section: ${section})\n` +
        'dispatch_sync(DispatchQueue.main) { /* boom */ }\n' +
        '```',
      `> Blockquote ${seed}.${section}: the JS thread holds the ShadowTree ` +
        `commit lock during this measurement while the main thread commits ` +
        `Reanimated's animation batch.`,
    );
  }
  return parts.join('\n\n');
}

/**
 * The main-thread committer. Animating WIDTH (a layout prop) guarantees the
 * update flows through ShadowTree::tryCommit on the main thread every frame
 * (REANodesManager maybeFlushUIUpdatesQueue → ReanimatedModuleProxy::
 * commitUpdates), exactly the main-thread stack in the watchdog reports.
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

function ReproScreen() {
  const insets = useSafeAreaInsets();
  const [count, setCount] = useState(INITIAL_COUNT);
  const data = useMemo(
    () => Array.from({ length: count }, (_, i) => i),
    [count],
  );

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Text style={styles.title}>enriched-markdown deadlock repro</Text>
        <ShimmerBar />
        <Pressable
          style={styles.button}
          onPress={() => setCount(c => c + PAGE_SIZE)}
        >
          <Text style={styles.buttonLabel}>
            Load {PAGE_SIZE} more (rendered: {count})
          </Text>
        </Pressable>
        <Text style={styles.hint}>
          Physical device only. Tap the button a few times — the UI should
          hard-freeze; ~60 s later iOS's watchdog kills the app (0x8BADF00D).
        </Text>
      </View>
      <FlatList
        data={data}
        keyExtractor={item => String(item)}
        initialNumToRender={INITIAL_COUNT}
        maxToRenderPerBatch={PAGE_SIZE}
        windowSize={21}
        renderItem={({ item }) => (
          <View style={styles.card}>
            <EnrichedMarkdownText markdown={makeMarkdown(item)} />
          </View>
        )}
      />
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
