import * as DocumentPicker from 'expo-document-picker';

/**
 * The picker filter is only a convenience for the user. What is accepted is
 * decided later from the file's bytes, never from this list or the reported MIME.
 */
const PICKABLE_TYPES = ['application/pdf', 'text/csv', 'text/comma-separated-values'];

export interface PickedFile {
  /** Android `content://` URI or iOS file URL, readable for the current session only. */
  ref: string;
  name: string;
}

/**
 * Opens the system document picker. It needs no storage permission: the user's
 * choice grants read access to that one document.
 *
 * `copyToCacheDirectory: false` on purpose: the picker would otherwise copy a
 * file of any size before we could refuse it. We make our own size-capped copy.
 */
export async function pickStatement(): Promise<PickedFile | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: PICKABLE_TYPES,
    copyToCacheDirectory: false,
    multiple: false,
  });
  if (result.canceled) return null;
  const asset = result.assets[0];
  return asset ? { ref: asset.uri, name: asset.name } : null;
}
