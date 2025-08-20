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
import * as secp from '@noble/secp256k1'
import { hmac } from '@noble/hashes/hmac'
import { sha256 } from '@noble/hashes/sha256'
import { ripemd160 } from '@noble/hashes/ripemd160'
import { hexToBytes } from '@noble/hashes/utils';

console.log('Background script starting to load...'); // Debug log for registration
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
const sideEffectTypes = new Set(['tipBCH']) // Types with side effects (e.g., broadcast tx)
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
          // For side-effect ops, prompt FIRST, then perform if accepted
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
          // Now perform after accept
          finalResult = await performOperation(type, params)
        } else {
          // For non-side-effect ops, perform first, then prompt
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
          error: {message: err.message, stack: err.stack}
        }
      }
    }
    return finalResult
  }
}

// Worker instance (lazy-loaded)
let tipWorker = null;

async function performOperation(type, params) {
  let results = await browser.storage.local.get('private_key')
  if (!results || !results.private_key) {
    return {error: {message: 'no private key found'}}
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
          : {error: {message: 'invalid event'}}
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
        const nsec = nip19.nsecEncode(hexToBytes(sk));
        const senderNpub = nip19.npubEncode(getPublicKey(sk));

        // Lazy-create worker if needed
        if (!tipWorker) {
          tipWorker = new Worker(browser.runtime.getURL('tip-worker.js'));
        }

        // Send to worker and await response
        return new Promise((resolve, reject) => {
          const channel = new MessageChannel();
          channel.port1.onmessage = (event) => {
            const result = event.data;
            if (result.error) {
              reject(new Error(result.error));
            } else {
              resolve(result);
            }
            // Optional: terminate worker after use
            tipWorker.terminate();
            tipWorker = null;
          };
          tipWorker.postMessage({ action: 'sendTip', params: { senderNpub, nsec, recipientNpub, amountSat, notify } }, [channel.port2]);
        });
      }
    }
  } catch (error) {
    console.error('Operation error:', error)
    return {error: {message: error.message, stack: error.stack}}
  }
}
async function handlePromptMessage({host, type, accept, conditions}, sender) {
  openPrompt?.resolve?.({accept, conditions})
  openPrompt = null
  releasePromptMutex()
  if (sender) {
    if (sender.tab && sender.tab.windowId) {
      browser.windows.remove(sender.tab.windowId).catch(() => {
        // Ignore if window already closed
      });
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