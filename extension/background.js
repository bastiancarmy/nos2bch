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
  broadcastTx
} from './common'
import * as secp from '@noble/secp256k1'  // Keep for signing
import { hmac } from '@noble/hashes/hmac'  // Unused in tipping; keep if needed elsewhere
import { sha256 } from '@noble/hashes/sha256'  // For hash256 as sha256(sha256(x))
import { ripemd160 } from '@noble/hashes/ripemd160'  // For _hash160
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';  // For bin/hex conversions
import { walletTemplateToCompilerBCH, SigningSerializationFlag, generateSigningSerializationBCH, generateTransaction, encodeTransaction, decodeTransaction, importWalletTemplate, walletTemplateP2pkhNonHd } from '@bitauth/libauth';

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
  let results = await browser.storage.local.get('private_key')
  if (!results || !results.private_key) {
    return {error: 'no private key found'}
  }
  let sk = results.private_key
  try {
    switch (type) {
      case 'getPublicKey': {
        return getPublicKey(sk)
      }
      case 'signEvent': {
        const event = finalizeEvent(params.event, sk)
        return verifyEvent(event)
          ? event
          : {error: 'invalid event'}
      }
      case 'nip04.encrypt': {
        let {peer, plaintext} = params
        return nip04.encrypt(sk, peer, plaintext)
      }
      case 'nip04.decrypt': {
        let {peer, ciphertext} = params
        return nip04.decrypt(sk, peer, ciphertext)
      }
      case 'nip44.encrypt': {
        const {peer, plaintext} = params
        const key = getSharedSecret(sk, peer)
        return nip44.v2.encrypt(plaintext, key)
      }
      case 'nip44.decrypt': {
        const {peer, ciphertext} = params
        const key = getSharedSecret(sk, peer)
        return nip44.v2.decrypt(ciphertext, key)
      }
      case 'tipBCH': {
        const { recipientNpub, amountSat, notify = false } = params;
        console.log('Performing tipBCH to', recipientNpub, 'amount', amountSat, 'notify', notify);
        const skBytes = hexToBytes(sk);
        const pubHex = bytesToHex(getPublicKey(skBytes));
        const pubkeyCompressed = hexToBytes(pubHex);  // Use noble's hexToBytes
        const senderAddress = deriveBCHAddress(pubHex);
        const recipientPk = nip19.decode(recipientNpub).data;
        const recipientAddress = deriveBCHAddress(recipientPk);
        
        // Alarm for keep-alive
        chrome.alarms.create('tipKeepAlive', { periodInMinutes: 1 });
        chrome.alarms.onAlarm.addListener((alarm) => {
          if (alarm.name === 'tipKeepAlive') console.log('SW keep-alive during tip');
        });
        
        let attempts = 3;
        while (attempts > 0) {
          try {
            // Cache feeRate (check storage; fallback to fetch)
            let feeRate;
            const cached = await browser.storage.local.get('cachedFeeRate');
            if (cached.cachedFeeRate && Date.now() - cached.timestamp < 300000) {  // 5min
              feeRate = cached.cachedFeeRate;
            } else {
              feeRate = await getFeeRate();
              browser.storage.local.set({ cachedFeeRate: feeRate, timestamp: Date.now() });
            }
            
            const utxos = validateUtxos(await getUtxos(senderAddress));  // Validate
            const inputSum = getBalanceFromUtxos(utxos);  // From utils
            if (inputSum < amountSat + feeRate * 300) throw new Error('Insufficient funds');
            
            // Libauth template
            const walletTemplate = importWalletTemplate(walletTemplateP2pkhNonHd);
            if (typeof walletTemplate === "string") throw new Error("Template error: " + walletTemplate);
            const compiler = walletTemplateToCompilerBch(walletTemplate);
            
            // Inputs/outputs (adapt to libauth)
            const inputs = utxos.slice(0, Math.min(utxos.length, 10));  // Limit for speed; batch if more
            const sourceOutputs = inputs.map(input => ({
              lockingBytecode: hexToBytes(addressToScriptPubKey(senderAddress)),  // noble hexToBytes
              valueSatoshis: BigInt(input.value),
            }));
            const outputs = [
              { lockingBytecode: hexToBytes(addressToScriptPubKey(recipientAddress)), valueSatoshis: BigInt(amountSat) }
            ];
            const fee = BigInt((148 * inputs.length + 34 * (outputs.length + 1) + 10) * feeRate);
            let change = BigInt(inputSum) - BigInt(amountSat) - fee;
            if (change > 546n) {
              outputs.push({ lockingBytecode: hexToBytes(addressToScriptPubKey(senderAddress)), valueSatoshis: change });
            }
            
            // Unsigned tx
            const unsignedTx = {
              version: 2,
              inputs: inputs.map((input, index) => ({
                outpointTransactionHash: reverseBytes(hexToBytes(input.txid)),
                outpointIndex: input.vout,
                sequenceNumber: 0,
                unlockingBytecode: { script: 'unlock' },  // Placeholder
              })),
              outputs: outputs.map(out => ({
                lockingBytecode: out.lockingBytecode,
                valueSatoshis: out.valueSatoshis,
              })),
              locktime: 0,
            };
            
            // Sign (adapted, with yields)
            for (const [index, input] of unsignedTx.inputs.entries()) {
              const correspondingSourceOutput = sourceOutputs[index];
              const hashType = SigningSerializationFlag.allOutputs | SigningSerializationFlag.utxos | SigningSerializationFlag.forkId;
              const context = { inputIndex: index, sourceOutputs, transaction: unsignedTx };
              const signingSerializationType = new Uint8Array([hashType]);
              const coveredBytecode = correspondingSourceOutput.lockingBytecode;
              const sighashPreimage = generateSigningSerializationBch(context, { coveredBytecode, signingSerializationType });
              const sighash = sha256(sha256(sighashPreimage));  // Use noble sha256 composed for hash256
              const signature = secp.sign(sighash, skBytes, { lowS: true });  // noble secp; async if needed, but sync is fine
              if (typeof signature === "string") throw new Error("Sign error: " + signature);
              const sig = Uint8Array.from([...signature, hashType]);
              
              // Unlock (adapt placeholders)
              input.unlockingBytecode = new Uint8Array([...sig, ...pubkeyCompressed]);
              await new Promise(r => setTimeout(r, 0));  // Yield
            }
            
            // Generate/encode
            const generated = generateTransaction(unsignedTx);
            if (!generated.success) throw new Error(JSON.stringify(generated.errors));
            const encodedTx = encodeTransaction(generated.transaction);
            const txHex = bytesToHex(encodedTx);  // noble bytesToHex
            const txid = await broadcastTx(txHex);
            
            // Notify...
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
    console.error('Operation error:', error)
    return {error: error.message}
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
function _hash160 (x) {
  return ripemd160(sha256(x))
}
function _encodeDer (r, s) {
  function encodeInt (val) {
    let bytes = []
    let tmp = val
    if (tmp === 0n) bytes.push(0)
    while (tmp > 0n) {
      bytes.push(Number(tmp & 0xffn))
      tmp >>= 8n
    }
    bytes = bytes.reverse()
    if (bytes[0] & 0x80) bytes.unshift(0)
    return new Uint8Array([0x02, bytes.length, ...bytes])
  }
  const rEnc = encodeInt(r)
  const sEnc = encodeInt(s)
  const totalLen = rEnc.length + sEnc.length
  return new Uint8Array([0x30, totalLen, ...rEnc, ...sEnc])
}
console.log('Background script loaded successfully');