import { useMemo } from 'react';

import { createDeviceEngine } from './src/platform/engine';
import { ImportScreen } from './src/ui/ImportScreen';

export default function App() {
  const engine = useMemo(createDeviceEngine, []);
  return <ImportScreen engine={engine} />;
}
