import AsyncStorage from '@react-native-async-storage/async-storage';
import { randomUUID } from 'expo-crypto';

import { createLogger, ImportEngine, silentLogger } from '../import';
import { deviceFiles } from './files';
import { deviceHttp } from './http';

/**
 * The local mock from the candidate kit. On the Android emulator run
 * `adb reverse tcp:8787 tcp:8787`; the iOS simulator reaches the host loopback directly.
 * Override with EXPO_PUBLIC_API_BASE_URL for a physical device on a chosen LAN host.
 */
export const API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL ?? 'http://127.0.0.1:8787';

/** Diagnostics go to the dev console only, and only through the field allowlist. */
const log = __DEV__ ? createLogger(line => console.log(`[import] ${line}`)) : silentLogger;

export function createDeviceEngine(): ImportEngine {
  return new ImportEngine({
    baseUrl: API_BASE_URL,
    store: AsyncStorage,
    files: deviceFiles,
    http: deviceHttp,
    newKey: () => randomUUID(),
    log,
  });
}
