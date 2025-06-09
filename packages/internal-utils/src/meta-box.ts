/**
 * Creates the 8-byte header for an MP4 box.
 * The header consists of the box size and the box type.
 *
 * @param {string} type - The 4-character code for the box type (e.g., 'ftyp', 'moov').
 * @param {number} size - The total size of the box in bytes, including the header itself.
 * @returns {Uint8Array} A Uint8Array containing the box header.
 */
const createBoxHeader = (type: string, size: number): Uint8Array => {
  // Allocate 8 bytes for the header.
  const headerBuffer = new Uint8Array(8);
  const dataView = new DataView(headerBuffer.buffer);
  // First 4 bytes: size of the box (Big Endian).
  dataView.setUint32(0, size);
  // Next 4 bytes: type of the box (ASCII characters).
  for (let i = 0; i < 4; i++) {
    headerBuffer[4 + i] = type.charCodeAt(i);
  }
  return headerBuffer;
};

/**
 * Creates an 'hdlr' (Handler Reference) box.
 * The 'hdlr' box within a 'meta' box declares the media type of the metadata.
 * For iTunes metadata, this is typically 'mdta' for metadata handler.
 *
 * @returns {Uint8Array} A Uint8Array representing the 'hdlr' box.
 */
const createHdlrBox = (): Uint8Array => {
  const textEncoder = new TextEncoder();
  // Handler type: 'mdta' for metadata handler, specific to some metadata formats like iTunes.
  const handlerTypeBytes = textEncoder.encode('mdta');
  // Handler name: A human-readable name for the handler type, null-terminated.
  const handlerNameBytes = textEncoder.encode('mp4 handler'); // Example name

  // Calculate the total size of the 'hdlr' box.
  // BoxHeader (8) + FullBoxVersionFlags (4) + Predefined (4 bytes, often 0) + HandlerType (4) + Reserved (3 * 4 bytes) + Name (variable + null terminator)
  const size =
    8 + // Basic box header (size + type)
    4 + // Version (1 byte) & Flags (3 bytes)
    4 + // Predefined (usually 0)
    handlerTypeBytes.byteLength + // Handler type (e.g., 'mdta')
    12 + // Reserved (3 * 4 bytes of 0)
    handlerNameBytes.byteLength + // Name string
    1; // Null terminator for the name string

  const hdlrBoxBuffer = new Uint8Array(size);
  const dataView = new DataView(hdlrBoxBuffer.buffer);

  // Set the standard box header ('hdlr' and total size).
  hdlrBoxBuffer.set(createBoxHeader('hdlr', size), 0);

  // FullBox fields: version (0) and flags (0).
  // Offset 8 (after basic box header).
  dataView.setUint8(8, 0); // Version = 0
  dataView.setUint32(8, 0); // Version (1 byte) + Flags (3 bytes) = 0

  // Predefined field, typically zero.
  // Offset 12 (after FullBox version/flags).
  dataView.setUint32(12, 0);

  // Handler type (e.g., 'mdta').
  // Offset 16 (after Predefined).
  hdlrBoxBuffer.set(handlerTypeBytes, 16);

  // Reserved fields (12 bytes of zeros).
  // Offset 20 (after HandlerType). (Filled by Uint8Array default)

  // Handler name (UTF-8 string, null-terminated).
  // Offset 32 (after Reserved fields).
  hdlrBoxBuffer.set(handlerNameBytes, 32);
  // The final byte is already 0 due to Uint8Array initialization (null terminator).
  // dataView.setUint8(32 + handlerNameBytes.byteLength, 0); // Explicit null terminator

  return hdlrBoxBuffer;
};

/**
 * Creates a 'keys' box for iTunes-style metadata.
 * The 'keys' box lists the metadata keys (tag names) that are used in the 'ilst' box.
 * Each key has a namespace (typically 'mdta') and the key name itself.
 *
 * @param {string[]} keys - An array of strings, where each string is a metadata key name (e.g., "©alb", "©art").
 * @returns {Uint8Array} A Uint8Array representing the 'keys' box.
 */
const createKeysBox = (keys: string[]): Uint8Array => {
  const textEncoder = new TextEncoder();
  // Namespace for iTunes metadata keys, typically 'mdta'.
  const keyNamespaceBytes = textEncoder.encode('mdta');

  // Encode each key into its entry format.
  const encodedKeyEntries = keys.map((key) => {
    const encodedKeyName = textEncoder.encode(key);
    // Each key entry structure: entry_size (4 bytes) + key_namespace (4 bytes) + key_value (variable length)
    const keyEntrySize =
      4 + // Size of this key entry
      keyNamespaceBytes.byteLength + // "mdta"
      encodedKeyName.byteLength; // The actual key string

    const keyEntryBuffer = new Uint8Array(keyEntrySize);
    const dataView = new DataView(keyEntryBuffer.buffer);

    // Set the size of this individual key entry.
    dataView.setUint32(0, keyEntrySize);
    // Set the key namespace (e.g., 'mdta').
    keyEntryBuffer.set(keyNamespaceBytes, 4);
    // Set the key name itself.
    keyEntryBuffer.set(encodedKeyName, 4 + keyNamespaceBytes.byteLength);

    return keyEntryBuffer;
  });

  // Calculate the total size of all encoded key entries.
  const totalKeyEntriesSize = encodedKeyEntries.reduce(
    (acc, cur) => acc + cur.byteLength,
    0,
  );

  // Calculate the total size of the 'keys' box.
  // BoxHeader (8) + FullBoxVersionFlags (4) + EntryCount (4) + AllKeyEntriesData (variable)
  const size =
    8 + // Basic box header
    4 + // Version and flags
    4 + // Entry count
    totalKeyEntriesSize; // Total size of all key entries

  const keysBoxBuffer = new Uint8Array(size);
  const dataView = new DataView(keysBoxBuffer.buffer);

  // Set the standard box header ('keys' and total size).
  keysBoxBuffer.set(createBoxHeader('keys', size), 0);

  // FullBox fields: version (0) and flags (0).
  // Offset 8.
  dataView.setUint32(8, 0); // Version (1 byte) + Flags (3 bytes) = 0

  // Entry count: the number of keys.
  // Offset 12.
  dataView.setUint32(12, keys.length);

  // Concatenate all key entry buffers into the main 'keys' box buffer.
  let offset = 16; // Start after header, version/flags, and entry count
  for (const keyEntryBuffer of encodedKeyEntries) {
    keysBoxBuffer.set(keyEntryBuffer, offset);
    offset += keyEntryBuffer.byteLength;
  }

  return keysBoxBuffer;
};

/**
 * Creates an 'ilst' (Item List) box for iTunes-style metadata.
 * The 'ilst' box contains the actual metadata values, with each item corresponding
 * to a key defined in the 'keys' box. Each item is itself a box, where the box type
 * is the 1-based index of the key in the 'keys' box.
 *
 * @param {Record<string, string>} metadataTags - An object where keys are metadata tag names (e.g., "©alb")
 *                                              and values are the corresponding metadata strings.
 *                                              The order of keys from Object.entries() will determine the key index.
 * @returns {Uint8Array} A Uint8Array representing the 'ilst' box.
 */
const createIlstBox = (metadataTags: Record<string, string>): Uint8Array => {
  const textEncoder = new TextEncoder();
  // The 'data' atom/box type used inside each metadata item.
  const dataAtomTypeBytes = textEncoder.encode('data');

  // Encode each metadata value into its entry format.
  // Each entry is a box whose type is the 1-based index of the key.
  // Inside this box is a 'data' box containing the actual value.
  const encodedValueEntries = Object.values(metadataTags).map(
    (value, index) => {
      // The key index is 1-based.
      const keyIndex = index + 1;
      const encodedValue = textEncoder.encode(value);

      // Structure of a single metadata item (e.g., for '©alb'):
      //   ItemBoxHeader (e.g., type '0001' for keyIndex 1) (8 bytes)
      //   -> DataBox ('data')
      //      -> BoxHeader ('data') (8 bytes)
      //      -> VersionAndFlags (4 bytes, for 'data' box, type, locale)
      //      -> Value (variable length)

      // Size of the inner 'data' box: Header (8) + Version/Flags (4) + Reserved (4, for locale) + Value (variable)
      const dataBoxPayloadSize =
        4 + // Type indicator (0 for UTF-8), and 3 bytes for locale (usually 0)
        4 + // Reserved for locale / data specific (usually 0)
        encodedValue.byteLength;
      const dataBoxSize = 8 + dataBoxPayloadSize; // 'data' box header + payload

      // Size of the outer item box (e.g., '0001')
      const itemBoxSize = 8 + dataBoxSize; // Item box header + 'data' box

      const itemEntryBuffer = new Uint8Array(itemBoxSize);
      const dataView = new DataView(itemEntryBuffer.buffer);

      // Write the header for the item box (e.g., type '0001').
      // The type is the keyIndex as a 32-bit integer.
      dataView.setUint32(0, itemBoxSize);
      dataView.setUint32(4, keyIndex); // Box type is the 1-based key index

      // --- Start of the inner 'data' box ---
      let offset = 8; // Current offset within itemEntryBuffer

      // Write the header for the 'data' box.
      dataView.setUint32(offset, dataBoxSize); // Size of 'data' box
      offset += 4;
      itemEntryBuffer.set(dataAtomTypeBytes, offset); // Type 'data'
      offset += dataAtomTypeBytes.byteLength;

      // Write Version (0) and Flags (1 for UTF-8 data, or other types).
      // For 'data' atom: 3 bytes type (000001 for UTF-8), 1 byte locale (00)
      dataView.setUint32(offset, 1); // Type = 1 (UTF-8). Assuming no specific locale.
      offset += 4;

      // Reserved 4 bytes (often zeros, part of 'data' atom before actual data)
      dataView.setUint32(offset, 0);
      offset += 4;

      // Write the actual metadata value.
      itemEntryBuffer.set(encodedValue, offset);

      return itemEntryBuffer;
    },
  );

  // Calculate the total size of all encoded value entries.
  const totalValueEntriesSize = encodedValueEntries.reduce(
    (acc, cur) => acc + cur.byteLength,
    0,
  );

  // Calculate the total size of the 'ilst' box.
  // BoxHeader (8) + AllValueEntriesData (variable)
  const ilstBoxSize = 8 + totalValueEntriesSize;
  const ilstBoxBuffer = new Uint8Array(ilstBoxSize);

  // Set the standard box header ('ilst' and total size).
  ilstBoxBuffer.set(createBoxHeader('ilst', ilstBoxSize), 0);

  // Concatenate all value entry buffers into the main 'ilst' box buffer.
  let offset = 8; // Start after 'ilst' box header
  for (const valueEntryBuffer of encodedValueEntries) {
    ilstBoxBuffer.set(valueEntryBuffer, offset);
    offset += valueEntryBuffer.byteLength;
  }

  return ilstBoxBuffer;
};

/**
 * Creates a 'meta' (Metadata) box containing iTunes-style metadata.
 * The 'meta' box is a container for other boxes:
 * - 'hdlr': Specifies the handler type for the metadata.
 * - 'keys': Lists the metadata keys.
 * - 'ilst': Contains the actual metadata values corresponding to the keys.
 *
 * Note: This function creates a 'meta' box that is typically found inside the 'udta' (User Data) box.
 * The full structure is often moov -> udta -> meta.
 * The 'meta' box itself does not have the standard version/flags if it's the top-level one in 'udta'.
 * However, if it were a full box (e.g. within another box), it would need a version/flags field.
 * This implementation creates a simple 'meta' box containing 'hdlr', 'keys', and 'ilst'.
 *
 * @param {Record<string, string>} metadataTags - An object where keys are metadata tag names (e.g., "©alb", "©art")
 *                                              and values are the corresponding metadata strings.
 * @returns {Uint8Array} A Uint8Array representing the 'meta' box and its children.
 */
export const createMetaBox = (
  metadataTags: Record<string, string>,
): Uint8Array => {
  // Create the child boxes.
  const hdlrBox = createHdlrBox();
  const keysBox = createKeysBox(Object.keys(metadataTags));
  const ilstBox = createIlstBox(metadataTags);

  // Calculate the total size of the 'meta' box (sum of its children's sizes).
  // Note: The 'meta' box itself also has a header.
  const metaBoxPayloadSize = hdlrBox.length + keysBox.length + ilstBox.length;
  const metaBoxTotalSize = 8 + metaBoxPayloadSize; // 8 bytes for 'meta' box header

  const metaBoxBuffer = new Uint8Array(metaBoxTotalSize);

  // Write the 'meta' box header.
  metaBoxBuffer.set(createBoxHeader('meta', metaBoxTotalSize), 0);

  // According to ISO 14496-12, the 'meta' box is a FullBox, so it should have version/flags.
  // Set version = 0, flags = 0.
  // This is 4 bytes after the initial 8-byte header (size and type).
  const dataView = new DataView(metaBoxBuffer.buffer);
  dataView.setUint32(8, 0); // Version (1 byte) + Flags (3 bytes) = 0. Offset from start of 'meta' box.

  // Concatenate the child boxes into the 'meta' box buffer.
  // Offset starts after 'meta' header (8 bytes) AND version/flags (4 bytes).
  let offset = 12;
  metaBoxBuffer.set(hdlrBox, offset);
  offset += hdlrBox.length;
  metaBoxBuffer.set(keysBox, offset);
  offset += keysBox.length;
  metaBoxBuffer.set(ilstBox, offset);
  // offset += ilstBox.length; // Not needed as it's the last one

  return metaBoxBuffer;
};
```
