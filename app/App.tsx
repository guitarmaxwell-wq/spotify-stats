import { StatusBar } from 'expo-status-bar';
import React, { useState } from 'react';
import { SafeAreaView, StyleSheet } from 'react-native';
import ShelfScreen from './src/screens/ShelfScreen';
import CrateDetailScreen from './src/screens/CrateDetailScreen';
import StatsScreen from './src/screens/StatsScreen';
import AlmostThereScreen from './src/screens/AlmostThereScreen';
import LinkScreen from './src/screens/LinkScreen';
import UnlockModal from './src/components/UnlockModal';
import { useUnlockQueue } from './src/hooks/useUnlockQueue';
import { theme } from './src/theme';
import type { Crate } from './src/types';

type Route =
  | { name: 'shelf' }
  | { name: 'crate'; crate: Crate }
  | { name: 'stats' }
  | { name: 'almost' }
  | { name: 'link' };

export default function App() {
  const [route, setRoute] = useState<Route>({ name: 'shelf' });
  const back = () => setRoute({ name: 'shelf' });
  const unlocks = useUnlockQueue();

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar style="light" />
      {route.name === 'shelf' && (
        <ShelfScreen
          onOpenCrate={(crate) => setRoute({ name: 'crate', crate })}
          onOpenStats={() => setRoute({ name: 'stats' })}
          onOpenAlmost={() => setRoute({ name: 'almost' })}
          onOpenLink={() => setRoute({ name: 'link' })}
        />
      )}
      {route.name === 'crate' && <CrateDetailScreen crate={route.crate} onBack={back} />}
      {route.name === 'stats' && <StatsScreen onBack={back} />}
      {route.name === 'almost' && <AlmostThereScreen onBack={back} />}
      {route.name === 'link' && <LinkScreen onBack={back} />}
      {unlocks.showing && unlocks.batch && (
        <UnlockModal batch={unlocks.batch} onClose={unlocks.close} />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.room },
});
