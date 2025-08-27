// extension/background.js

// background.js

import browser from 'webextension-polyfill'
import {getPublicKey, finalizeEvent, verifyEvent} from 'nostr-tools/pure'
import {nip04, nip19} from 'nostr-tools'
import * as nip44 from 'nostr-tools/nip44'
import { LRUCache } from './utils'
import {
  NO_PERMISSIONS_REQUIRED,
  getPermissionStatus,
  updatePermission,
  showNotification,
  getPosition,
  getBCHBalance,
  getFeeRate,
  getUtxos,
  broadcastTx,
  validateUtxos,
  getBalanceFromUtxos,
  deriveBCHAddress,
  signSchnorr,
  bytesToNumberBE,
  numberToBytesBE,
  _hash160
} from './common';
import * as secp from '@noble/secp256k1'
import { sha256 } from '@noble/hashes/sha256'
import { ripemd160 } from '@noble/hashes/ripemd160'
import { hexToBytes, bytesToHex } from '@noble/hashes/utils'
import { hmac } from '@noble/hashes/hmac'

console.log('Background script starting to load...');
// Enable sync methods in secp
secp.etc.hmacSha256Sync = (k, ...m) => hmac(sha256, k, secp.etc.concatBytes(...m))
let openPrompt = null
let promptMutex = false
let secretsCache = new LRUCache(100)
let previousSk = null
function getSharedSecret(sk, peer) {
  if (previousSk !== sk) {
    secretsCache.clear()
    previousSk = sk
  }
  let key = secretsCache.get(peer)
  if (!key) {
    key = nip44.v2.utils.getConversationKey(sk, peer)
    secretsCache.set(peer, key)
  }
  return key
}
const width = 440
const height = 420
const sideEffectTypes = new Set(['tipBCH'])
const defaultRelays = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://nostr-pub.wellorder.net'];
browser.runtime.onInstalled.addListener((_, __, reason) => {
  if (reason === 'install') browser.runtime.openOptionsPage()
})
browser.runtime.onMessage.addListener(async (message, sender) => {
  console.log('Received message in background:', message)
  if (message.prompt) {
    await handlePromptMessage(message, sender)
    return
  }
  let host = sender.url ? new URL(sender.url).host : ''
  if (!host && sender.url && sender.url.startsWith(browser.runtime.getURL(''))) {
    host = 'nos2bch'
  }
  console.log('Handling content script message:', message, 'host:', host)
  return handleContentScriptMessage({type: message.type, params: message.params, host})
})
browser.runtime.onMessageExternal.addListener(
  async ({type, params}, sender) => {
    let extensionId = new URL(sender.url).host
    return handleContentScriptMessage({type, params, host: extensionId})
  }
)
browser.windows.onRemoved.addListener(_ => {
  if (openPrompt) {
    handlePromptMessage({accept: false}, null)
  }
})
function acquirePromptMutex() {
  if (promptMutex) return false
  promptMutex = true
  return true
}
function releasePromptMutex() {
  promptMutex = false
}
async function handleContentScriptMessage({type, params, host}) {
  if (NO_PERMISSIONS_REQUIRED[type]) {
    switch (type) {
      case 'replaceURL': {
        let {protocol_handler: ph} = await browser.storage.local.get([
          'protocol_handler'
        ])
        if (!ph) return false
        let {url} = params
        let raw = url.split('nostr:')[1]
        let {type: hrp, data} = nip19.decode(raw)
        let replacements = {
          raw,
          hrp,
          hex:
            hrp === 'npub' || hrp === 'note'
              ? data
              : hrp === 'nprofile'
              ? data.pubkey
              : hrp === 'nevent'
              ? data.id
              : null,
          p_or_e: {npub: 'p', note: 'e', nprofile: 'p', nevent: 'e'}[hrp],
          u_or_n: {npub: 'u', note: 'n', nprofile: 'u', nevent: 'n'}[hrp],
          relay0: hrp === 'nprofile' || hrp === 'nevent' ? data.relays[0] : null,
          relay1: hrp === 'nprofile' || hrp === 'nevent' ? data.relays[1] : null,
          relay2: hrp === 'nprofile' || hrp === 'nevent' ? data.relays[2] : null
        }
        let result = ph
        Object.entries(replacements).forEach(([pattern, value]) => {
          result = result.replace(new RegExp(`{ *${pattern} *}`, 'g'), value || '')
        })
        return result
      }
    }
    return
  } else {
    if (!acquirePromptMutex()) return {error: {message: 'prompt in progress'}}
    console.log('Performing operation:', type)
    let finalResult
    let allowed = await getPermissionStatus(
      host,
      type,
      type === 'signEvent' ? params.event : undefined
    )
    if (allowed === true) {
      finalResult = await performOperation(type, params)
      releasePromptMutex()
      showNotification(host, allowed, type, params)
    } else if (allowed === false) {
      releasePromptMutex()
      showNotification(host, allowed, type, params)
      return {
        error: {message: 'denied'}
      }
    } else {
      // Prompt logic
      try {
        let id = Math.random().toString().slice(4)
        let qs = new URLSearchParams({
          host,
          id,
          params: JSON.stringify(params),
          type
        })
        if (sideEffectTypes.has(type)) {
          const {top, left} = await getPosition(width, height)
          let {accept, conditions} = await new Promise((resolve, reject) => {
            openPrompt = {resolve, reject}
            browser.windows.create({
              url: `${browser.runtime.getURL('prompt.html')}?${qs.toString()}`,
              type: 'popup',
              width: width,
              height: height,
              top: top,
              left: left
            })
          })
          if (!accept) {
            releasePromptMutex()
            return {error: {message: 'denied'}}
          }
          if (conditions) await updatePermission(host, type, accept, conditions)
          finalResult = await performOperation(type, params)
        } else {
          finalResult = await performOperation(type, params)
          if (typeof finalResult === 'string') {
            qs.set('result', finalResult)
          }
          const {top, left} = await getPosition(width, height)
          let {accept, conditions} = await new Promise((resolve, reject) => {
            openPrompt = {resolve, reject}
            browser.windows.create({
              url: `${browser.runtime.getURL('prompt.html')}?${qs.toString()}`,
              type: 'popup',
              width: width,
              height: height,
              top: top,
              left: left
            })
          })
          if (!accept) {
            releasePromptMutex()
            return {error: {message: 'denied'}}
          }
          if (conditions) await updatePermission(host, type, accept, conditions)
        }
      } catch (err) {
        releasePromptMutex()
        return {
          error: err.message  // String only
        }
      }
    }
    return finalResult
  }
}

async function performOperation(type, params) {
  let results = await browser.storage.local.get('private_key');
  if (!results || !results.private_key) {
    return { error: 'no private key found' };
  }
  let sk = results.private_key;
  try {
    switch (type) {
      case 'getPublicKey': {
        return getPublicKey(sk);
      }
      case 'signEvent': {
        const event = finalizeEvent(params.event, sk);
        return verifyEvent(event) ? event : { error: 'invalid event' };
      }
      case 'nip04.encrypt': {
        let { peer, plaintext } = params;
        return nip04.encrypt(sk, peer, plaintext);
      }
      case 'nip04.decrypt': {
        let { peer, ciphertext } = params;
        return nip04.decrypt(sk, peer, ciphertext);
      }
      case 'nip44.encrypt': {
        const { peer, plaintext } = params;
        const key = getSharedSecret(sk, peer);
        return nip44.v2.encrypt(plaintext, key);
      }
      case 'nip44.decrypt': {
        const { peer, ciphertext } = params;
        const key = getSharedSecret(sk, peer);
        return nip44.v2.decrypt(ciphertext, key);
      }
      case 'tipBCH': {
        const { recipientNpub, amountSat, notify = false } = params;
        console.log('Performing tipBCH to', recipientNpub, 'amount', amountSat, 'notify', notify);
        
        let skBytes = hexToBytes(sk);
        const originalPoint = secp.Point.fromPrivateKey(skBytes);
        if (originalPoint.y % 2n === 1n) {
          const n = secp.CURVE.n;
          const skBig = bytesToNumberBE(skBytes);
          const flippedBig = n - skBig;
          skBytes = numberToBytesBE(flippedBig, 32);
          console.log('Normalized skBytes to ensure even y-parity for consistency with Nostr');
        }
        
        const pubCompressed = secp.getPublicKey(skBytes, true);
        const pubHex = bytesToHex(pubCompressed.slice(1));
        const senderAddress = deriveBCHAddress(pubHex);
        
        const recipientPk = nip19.decode(recipientNpub).data;
        const recipientPubCompressed = new Uint8Array([0x02, ...hexToBytes(recipientPk)]);
        secp.Point.fromHex(recipientPubCompressed); // Validate
        const recipientAddress = deriveBCHAddress(recipientPk);
      
        chrome.alarms.create('tipKeepAlive', { periodInMinutes: 1 });
        chrome.alarms.onAlarm.addListener((alarm) => {
          if (alarm.name === 'tipKeepAlive') console.log('SW keep-alive during tip');
        });
      
        let attempts = 3;
        while (attempts > 0) {
          try {
            let feeRate;
            const cached = await browser.storage.local.get('cachedFeeRate');
            if (cached.cachedFeeRate && Date.now() - cached.timestamp < 300000) {
              feeRate = cached.cachedFeeRate;
            } else {
              feeRate = await getFeeRate();
              browser.storage.local.set({ cachedFeeRate: feeRate, timestamp: Date.now() });
            }
            console.log('Fee rate used:', feeRate);
      
            const rawUtxos = await getUtxos(senderAddress.toLowerCase());
            console.log('Raw fetched UTXOs:', JSON.stringify(rawUtxos, null, 2)); // Log raw UTXOs to inspect height and token_data
            const utxos = validateUtxos(rawUtxos);
            console.log('Validated UTXOs:', JSON.stringify(utxos, null, 2)); // Log after filtering to debug why sum might be 0
            const inputSum = getBalanceFromUtxos(utxos);
            if (inputSum === 0) throw new Error('No valid UTXOs available (check logs for height/token_data issues)');
      
            const inputs = utxos.slice(0, Math.min(utxos.length, 10));
            const senderLockingBytecode = p2pkhLockingBytecode(pubCompressed);
            const sourceOutputs = inputs.map(input => ({
              lockingBytecode: senderLockingBytecode,
              valueSatoshis: BigInt(input.value),
            }));
      
            const outputs = [
              { lockingBytecode: p2pkhLockingBytecode(recipientPubCompressed), valueSatoshis: BigInt(amountSat) }
            ];
      
            // Improved fee calculation: First assume no change output
            let baseBytes = 148 * inputs.length + 34 * outputs.length + 10;
            let baseFee = BigInt(baseBytes * feeRate);
            let potentialChange = BigInt(inputSum) - BigInt(amountSat) - baseFee;
      
            if (potentialChange < 0n) throw new Error('Insufficient funds');
      
            let finalFee = baseFee;
            if (potentialChange > 546n) {
              // Check if adding change output is viable
              let bytesWithChange = 148 * inputs.length + 34 * (outputs.length + 1) + 10;
              let feeWithChange = BigInt(bytesWithChange * feeRate);
              let actualChange = BigInt(inputSum) - BigInt(amountSat) - feeWithChange;
      
              if (actualChange >= 546n) {
                // Add change output
                outputs.push({ lockingBytecode: senderLockingBytecode, valueSatoshis: actualChange });
                finalFee = feeWithChange;
              } else {
                // Even with change, it's below dust threshold; proceed without change if possible
                if (potentialChange < 0n) throw new Error('Insufficient funds');
                // No change added, stick with baseFee
              }
            } // Else: potentialChange <= 546n and >=0n, no change output needed
      
            const unsignedTx = {
              version: 2,
              inputs: inputs.map(input => ({
                outpointTransactionHash: reverseBytes(hexToBytes(input.txid)),
                outpointIndex: input.vout,
                sequenceNumber: 0,
                unlockingBytecode: new Uint8Array() // Filled later
              })),
              outputs,
              locktime: 0,
            };
      
            // Precompute shared sighash parts (outside loop)
            const hashPrevouts = sha256(sha256(concatBytes(...unsignedTx.inputs.map(inp => concatBytes(inp.outpointTransactionHash, le32(inp.outpointIndex))))));
            const hashSequence = sha256(sha256(concatBytes(...unsignedTx.inputs.map(inp => le32(inp.sequenceNumber)))));
            const hashOutputs = sha256(sha256(concatBytes(...unsignedTx.outputs.map(out => concatBytes(le64(out.valueSatoshis), varInt(out.lockingBytecode.length), out.lockingBytecode)))));
            const versionBytes = le32(unsignedTx.version);
            const locktimeBytes = le32(unsignedTx.locktime);
            const sighashTypeBytes = le32(0x41); // SIGHASH_ALL | SIGHASH_FORKID
      
            for (const [index, input] of unsignedTx.inputs.entries()) {
              const correspondingSourceOutput = sourceOutputs[index];
              const scriptCode = correspondingSourceOutput.lockingBytecode;
              const outpoint = concatBytes(input.outpointTransactionHash, le32(input.outpointIndex));
              const value = le64(correspondingSourceOutput.valueSatoshis);
              const sequence = le32(input.sequenceNumber);
          
              const preimage = concatBytes(
                versionBytes,
                hashPrevouts,
                hashSequence,
                outpoint,
                varInt(scriptCode.length),
                scriptCode,
                value,
                sequence,
                hashOutputs,
                locktimeBytes,
                sighashTypeBytes // 0x41
              );
              console.log('Preimage for input ' + index + ': ', bytesToHex(preimage));
              const sighash = sha256(sha256(preimage));
              const sig = signSchnorr(sighash, skBytes); // 64-byte Schnorr sig
              const sigWithType = concatBytes(sig, new Uint8Array([0x41])); // 65 bytes
              
              input.unlockingBytecode = concatBytes(
                new Uint8Array([sigWithType.length]),
                sigWithType,
                new Uint8Array([pubCompressed.length]),
                pubCompressed
              );
      
              await new Promise(r => setTimeout(r, 0)); // Yield to event loop
            }
      
            const encodedTx = encodeTx(unsignedTx);
            const txHex = bytesToHex(encodedTx);
            console.log('Built txHex for broadcast:', txHex);
            const txid = await broadcastTx(txHex);
      
            // If notify is true, send a Nostr kind:4 DM to the recipient
            if (notify) {
              const skHex = bytesToHex(skBytes); // Convert to hex for nostr-tools
              const plaintext = `Tipped you ${amountSat} sats on Bitcoin Cash! Transaction: https://blockchair.com/bitcoin-cash/transaction/${txid}\n\nDownload the nos2bch Chrome extension to claim your tips: https://chrome.google.com/webstore/detail/nos2bch/[EXTENSION_ID_PLACEHOLDER]`;
              const ciphertext = nip04.encrypt(skHex, recipientPk, plaintext);
              const event = {
                kind: 4,
                created_at: Math.floor(Date.now() / 1000),
                tags: [['p', recipientPk]],
                content: ciphertext
              };
              const signed = finalizeEvent(event, skHex);
              if (!verifyEvent(signed)) throw new Error('Failed to verify tipped notification event');
              console.log('Signed notification event:', JSON.stringify(signed, null, 2)); // Debug
              const relays = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://nostr.mom'];
              for (const relay of relays) {
                try {
                  await publishToRelay(relay, signed);
                  console.log(`Notification published to ${relay}`);
                } catch (err) {
                  console.warn(`Failed to publish to ${relay}:`, err);
                }
              }
            }
      
            chrome.alarms.clear('tipKeepAlive');
            return { txid };
          } catch (error) {
            console.error('Tip attempt failed:', error);
            attempts--;
            if (attempts > 0) await new Promise(r => setTimeout(r, 2000));
            else {
              chrome.alarms.clear('tipKeepAlive');
              throw error;
            }
          }
        }
      }
    }
  } catch (error) {
    chrome.alarms.clear('tipKeepAlive');
    console.error('Operation error:', error);
    return { error: error.message };
  }
}

async function publishToRelay(relay, event) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(relay);
    const timeout = setTimeout(() => { ws.close(); rej('timeout'); }, 5000);
    ws.onopen = () => ws.send(JSON.stringify(['EVENT', event]));
    ws.onmessage = (msg) => {
      const data = JSON.parse(msg.data);
      if (data[0] === 'OK' && data[1] === event.id) {
        clearTimeout(timeout);
        ws.close();
        res();
      }
    };
    ws.onerror = (err) => { clearTimeout(timeout); ws.close(); rej(err); };
    ws.onclose = () => rej('closed');
  });
}
async function handlePromptMessage({host, type, accept, conditions}, sender) {
  openPrompt?.resolve?.({accept, conditions})
  openPrompt = null
  releasePromptMutex()
  if (sender) {
    if (sender.tab && sender.tab.windowId) {
      browser.windows.remove(sender.tab.windowId).catch(() => {});
    }
  }
}
async function openSignUpWindow() {
  const {top, left} = await getPosition(width, height)
  browser.windows.create({
    url: `${browser.runtime.getURL('signup.html')}`,
    type: 'popup',
    width: width,
    height: height,
    top: top,
    left: left
  })
}
// --- BCH Helpers ---
function concatBytes(...arrays) {
  const totalLen = arrays.reduce((sum, a) => sum + a.length, 0);
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

function le32(n) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}

function le64(n) {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n), true);
  return b;
}

function varInt(val) {
  if (val < 0xfd) return new Uint8Array([val]);
  if (val <= 0xffff) {
    const b = new Uint8Array(3);
    b[0] = 0xfd;
    new DataView(b.buffer).setUint16(1, val, true);
    return b;
  }
  if (val <= 0xffffffff) {
    const b = new Uint8Array(5);
    b[0] = 0xfe;
    new DataView(b.buffer).setUint32(1, val, true);
    return b;
  }
  const b = new Uint8Array(9);
  b[0] = 0xff;
  new DataView(b.buffer).setBigUint64(1, BigInt(val), true);
  return b;
}

function reverseBytes(b) {
  const rev = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) rev[i] = b[b.length - 1 - i];
  return rev;
}

function p2pkhLockingBytecode(pubCompressed) {
  const h = _hash160(pubCompressed);
  return new Uint8Array([0x76, 0xa9, 0x14, ...h, 0x88, 0xac]);
}

function encodeTx(tx) {
  const inpCount = varInt(tx.inputs.length);
  const outCount = varInt(tx.outputs.length);
  const inputsSer = tx.inputs.map(inp => concatBytes(
    inp.outpointTransactionHash,
    le32(inp.outpointIndex),
    varInt(inp.unlockingBytecode.length),
    inp.unlockingBytecode,
    le32(inp.sequenceNumber)
  ));
  const outputsSer = tx.outputs.map(out => concatBytes(
    le64(out.valueSatoshis),
    varInt(out.lockingBytecode.length),
    out.lockingBytecode
  ));
  return concatBytes(
    le32(tx.version),
    inpCount,
    ...inputsSer,
    outCount,
    ...outputsSer,
    le32(tx.locktime)
  );
}

console.log('Background script loaded successfully');