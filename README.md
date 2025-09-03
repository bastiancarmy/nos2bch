# nos2bch Chrome Extension

nos2bch is a Chrome extension that bridges the Nostr protocol with Bitcoin Cash (BCH) for seamless on-chain tipping. This project is a fork of [nos2x](https://github.com/fiatjaf/nos2x), extending its Nostr signing capabilities with BCH tipping functionality. In the Nostr ecosystem, which is heavily focused on Lightning Network for payments, nos2bch provides an alternative by enabling direct BCH transfers to Nostr public keys (npubs). It derives BCH addresses from npubs, allowing users to tip BCH without intermediaries, while optionally sending encrypted DM notifications via Nostr (kind 4 events).

This extension also serves as a Nostr signer, supporting event signing and NIP-04/NIP-44 encryption/decryption, making it a versatile tool for Nostr users interested in BCH integration.

## Overview

The goal of nos2bch is to make BCH tipping as easy as possible within Nostr. By deriving a standard P2PKH BCH address from a user's Nostr public key, tips are sent directly on-chain. The extension handles key management, permissions, balance monitoring, and transaction broadcasting securely in the background. It's built with privacy in mind—private keys are stored locally, and permissions are granular per host and action.

Key highlights:
- **BCH-Nostr Synergy**: Tip BCH to any npub without needing their explicit BCH address.
- **On-Chain Simplicity**: Uses Bitcoin Cash's low fees for efficient micropayments.
- **Nostr Notifications**: Optionally notify recipients via encrypted DMs, including a link to the transaction and a promo for the extension.
- **Secure & User-Friendly**: React-based UI for options, popup, and prompts; cryptographic operations use Noble libraries for reliability.

## Features

- **Nostr Signing & Encryption**:
  - Sign Nostr events (using `nostr-tools` for `finalizeEvent` and `verifyEvent`).
  - NIP-04 and NIP-44 encryption/decryption for secure messaging.

- **BCH Tipping**:
  - Send BCH sats directly to Nostr npubs.
  - Automatic derivation of BCH addresses from public keys (P2PKH with even y-parity normalization for consistency).
  - UTXO Management: Fetches and validates UTXOs (filters out tokens via CashTokens check, requires confirmed height > 0).
  - Transaction Building: P2PKH scripts, dynamic input selection (up to 10 UTXOs), change output if above dust threshold (546 sats), fee estimation with caching (refreshed every 5 minutes).
  - Signing: Schnබ (64-byte) per input using `@noble/secp256k1` with custom RFC6979 nonce and additional data.
  - Broadcasting: Retries on failure, uses shuffled Electrum servers for reliability.
  - Optional Notification: Sends a Nostr kind 4 DM to the recipient with the tx link and extension promo, published to multiple relays (e.g., relay.damus.io, nos.lol).

- **Balance & History**:
  - Cached balance refresh (every 5 minutes on access, background every 10 minutes via alarms).
  - Force-refresh flag after recent transactions.
  - Displays BCH balance and transaction history in options UI.

- **User Interface**:
  - **Popup**: Quick tipping interface with QR code for address, copy buttons, and balance display.
  - **Options Page**: Key management (generate/import, show/hide/encrypt), permission management, protocol handler for `nostr:` links, balance/history viewer.
  - **Prompt Window**: Approval for permissions and side-effect actions (e.g., tipping) with conditions (e.g., event kinds).

- **Permissions System**:
  - Granular per-host and per-action (e.g., `signEvent` with optional kind restrictions).
  - Allow/deny with conditions; revocable in options.
  - Notifications for permission usage (toggleable).

- **Additional Tools**:
  - Handle `nostr:` protocol links (customizable URL template for redirection to clients like njump.me).
  - QR code generation for private keys and BCH addresses.
  - Background keep-alive alarms during long operations (e.g., tipping).

## Installation

### From Chrome Web Store
- Coming soon! [Placeholder Link](https://chrome.google.com/webstore/detail/nos2bch/[EXTENSION_ID_PLACEHOLDER])

### Manual Installation for Development
1. Clone the repository:
   ```
   git clone https://github.com/bastiancarmy/nos2bch.git
   cd nos2bch
   ```

2. Install dependencies:
   ```
   yarn install
   ```

3. Build the extension:
   ```
   cd extension
   yarn build:prod
   ```

4. Load in Chrome:
   - Open Chrome and go to `chrome://extensions/`.
   - Enable "Developer mode" in the top right.
   - Click "Load unpacked" and select the `dist` directory.

## Usage

1. **Setup**:
   - Open the extension options (right-click icon > Options).
   - Generate or import a Nostr private key (nsec or hex).
   - Optionally encrypt the key for display/storage.
   - Your derived BCH address and balance will appear.

2. **Tipping**:
   - Click the extension icon to open the popup.
   - Enter recipient npub and amount in sats.
   - Optionally enable DM notification.
   - Confirm in the prompt window.
   - View tx in history or explorer (e.g., blockchair.com).

3. **Nostr Operations**:
   - The extension acts as a signer for connected sites (e.g., Nostr clients).
   - Approve permissions when prompted (e.g., for signing events).

4. **Permissions & Settings**:
   - Manage granted permissions in options.
   - Customize `nostr:` link handling (e.g., redirect to njump.me).
   - Toggle notifications for permission usage.

5. **Viewing Balance/History**:
   - In options: See BCH balance, QR, and recent transactions.
   - Refresh manually or automatically.

## Technical Details

### Crypto & BCH Implementation
- **Cryptography**: Uses `@noble/secp256k1` for Schnorr signing (with even y-parity normalization to match Nostr pubkeys), `@noble/hashes` for SHA256/RIPEMD160/HMAC.
- **BCH Address Derivation**: Compress pubkey (02/03 prefix), hash160, encode as CashAddr (`bitcoincash:...`).
- **Electrum Integration**: `@electrum-cash/network` for querying balance, UTXOs, fee rates, and history. Servers shuffled, with retries and timeouts.
- **Transaction Flow** (in `background.js`):
  - Normalize private key for even y-parity.
  - Derive sender/

recipient addresses.
  - Fetch/validate UTXOs (no tokens, confirmed).
  - Build tx: Version 2, inputs (up to 10), outputs (tip + optional change), locktime 0.
  - Precompute sighash parts (hashPrevouts, hashSequence, hashOutputs).
  - Sign each input: SIGHASH_ALL | SIGHASH_FORKID (0x41), 64-byte Schnorr sig + pubkey.
  - Encode (varint lengths, LE encodings) and broadcast.
- **Nostr DMs**: Encrypt plaintext with NIP-04, sign kind 4 event, publish to default relays in parallel.

### UI & Browser Integration
- **React Components**: `popup.jsx` (tipping form), `options.jsx` (key/balance/permissions), `prompt.jsx` (approvals).
- **Browser APIs**: `webextension-polyfill` for cross-browser compatibility (e.g., runtime messaging).
- **Alarms & Caching**: Background balance refresh every 10min; fee cache (5min); keep-alive during tipping.

### Security Notes
- Private keys stored locally in browser storage.
- Permissions prompted per action/host.
- No external dependencies for core crypto (pure JS).

## Contributing

Contributions are welcome! Focus on BCH-Nostr enhancements, such as:
- Support for CashTokens.
- Additional relays for DM publishing.
- Improved fee estimation or multi-server consensus.
- UI polish or internationalization.

Fork the repo, create a feature branch, and submit a PR. For major changes, open an issue first.

## Future Plans
- CashTokens integration for tokenized tips.
- More relay options and fallback broadcasting.
- Mobile support (via Kiwi Browser or similar).
- Integration with more Nostr clients.

## License

MIT License. See [LICENSE](LICENSE) for details.

## Credits

Thanks to the Nostr and Bitcoin Cash communities for inspiration and tools like nostr-tools, Noble crypto, and Electrum Cash. Special thanks to [fiatjaf](https://github.com/fiatjaf) for the original [nos2x](https://github.com/fiatjaf/nos2x) project, which this extension is forked from.