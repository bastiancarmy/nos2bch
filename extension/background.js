// extension/background.js - Full version with fixes/enhancements for tipping. Preserves all original nos2x functionality (key management, permissions, protocol handler, notifications) while fixing/enhancing BCH tipping (balance check, dynamic fees, UTXO selection, error handling, side-effect protection).
import browser from 'webextension-polyfill' // Added for browser API polyfill
import {getPublicKey, finalizeEvent, verifyEvent} from 'nostr-tools/pure' // Changed to 'pure'; validateEvent -> verifyEvent
import {nip04, nip19} from 'nostr-tools' // Removed unused getPk; nip19 is correct
import * as nip44 from 'nostr-tools/nip44'
import { Mutex } from 'async-mutex'
import { LRUCache } from './utils'
import { hexToBytes } from '@noble/hashes/utils'
import {
  NO_PERMISSIONS_REQUIRED,
  PERMISSION_NAMES,
  getPermissionStatus,
  updatePermission,
  showNotification,
  getPosition,
  getBCHBalance // Imported for balance check
} from './common'
import * as secp from '@noble/secp256k1'
import { hmac } from '@noble/hashes/hmac'
import { sha256 } from '@noble/hashes/sha256'
import { ripemd160 } from '@noble/hashes/ripemd160'
const API_BASE = 'https://api.fullstack.cash/v5/electrumx/'
const BLOCKCHAIR_API = 'https://api.blockchair.com/bitcoin-cash/' // Added for fees/stats
console.log('Background script starting to load...'); // Debug log for registration
// Enable sync methods in secp
secp.etc.hmacSha256Sync = (k, ...m) => hmac(sha256, k, secp.etc.concatBytes(...m))
let openPrompt = null
let promptMutex = new Mutex()
let releasePromptMutex = () => {}
let secretsCache = new LRUCache(100)
let previousSk = null
function getSharedSecret(sk, peer) {
  if (previousSk !== sk) {
    secretsCache.clear()
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
  if (message.openSignUp) {
    openSignUpWindow()
    browser.windows.remove(sender.tab.windowId)
  } else {
    let {prompt} = message
    if (prompt) {
      handlePromptMessage(message, sender)
    } else {
      return handleContentScriptMessage(message)
    }
  }
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
async function handleContentScriptMessage({type, params, host}) {
  console.log('Handling content script message:', {type, params, host})
  if (NO_PERMISSIONS_REQUIRED[type]) {
    switch (type) {
      case 'replaceURL': {
        let {protocol_handler: ph} = await browser.storage.local.get([
          'protocol_handler'
        ])
        if (!ph) return false
        let {url} = params
        let raw = url.split('nostr:')[1]
        let {type, data} = nip19.decode(raw)
        let replacements = {
          raw,
          hrp: type,
          hex:
            type === 'npub' || type === 'note'
              ? data
              : type === 'nprofile'
              ? data.pubkey
              : type === 'nevent'
              ? data.id
              : null,
          p_or_e: {npub: 'p', note: 'e', nprofile: 'p', nevent: 'e'}[type],
          u_or_n: {npub: 'u', note: 'n', nprofile: 'u', nevent: 'n'}[type],
          relay0: type === 'nprofile' ? data.relays[0] : null,
          relay1: type === 'nprofile' ? data.relays[1] : null,
          relay2: type === 'nprofile' ? data.relays[2] : null
        }
        let result = ph
        Object.entries(replacements).forEach(([pattern, value]) => {
          result = result.replace(new RegExp(`{ *${pattern} *}`, 'g'), value)
        })
        return result
      }
    }
    return
  } else {
    releasePromptMutex = await promptMutex.acquire()
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
          let accept = await new Promise((resolve, reject) => {
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
          // Now perform after accept
          finalResult = await performOperation(type, params)
        } else {
          // For non-side-effect ops, perform first, then prompt
          finalResult = await performOperation(type, params)
          if (typeof finalResult === 'string') {
            qs.set('result', finalResult)
          }
          const {top, left} = await getPosition(width, height)
          let accept = await new Promise((resolve, reject) => {
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
        }
      } catch (err) {
        releasePromptMutex()
        return {
          error: {message: err.message, stack: err.stack}
        }
      }
    }
    console.log('Operation result:', finalResult);  // Added log for response debugging
    return finalResult
  }
}
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
        const { recipientNpub, amountSat } = params
        console.log('Performing tipBCH to', recipientNpub, 'amount', amountSat)
        const nsec = nip19.nsecEncode(hexToBytes(sk))
        const senderNpub = nip19.npubEncode(getPublicKey(sk))
        return await sendTip(senderNpub, nsec, recipientNpub, amountSat)
      }
    }
  } catch (error) {
    console.error('Operation error:', error)
    return {error: {message: error.message, stack: error.stack}}
  }
}
async function handlePromptMessage({host, type, accept, conditions}, sender) {
  openPrompt?.resolve?.(accept)
  if (conditions) {
    await updatePermission(host, type, accept, conditions)
  }
  openPrompt = null
  releasePromptMutex()
  if (sender) {
    browser.windows.remove(sender.tab.windowId)
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
async function _buildP2PKHOutput (address) { // Made async for await import
  const { cashAddressToLockingBytecode } = await import('@bitauth/libauth')
  const result = cashAddressToLockingBytecode(address)
  if (typeof result === 'string') {
    throw new Error(result)
  }
  return result.bytecode
}
async function getFeeRate() {
  // Cache fee rate (5min expiry)
  let {lastFeeRate, lastFeeRateTime} = await browser.storage.local.get(['lastFeeRate', 'lastFeeRateTime'])
  if (lastFeeRate && Date.now() - lastFeeRateTime < 300000) {
    return lastFeeRate
  }
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 10000) // 10s timeout
  try {
    const res = await fetch(`${BLOCKCHAIR_API}stats`, { signal: controller.signal })
    clearTimeout(timeoutId)
    if (!res.ok) throw new Error('Fee fetch failed')
    const data = await res.json()
    const feeRate = data.suggested_transaction_fee_per_byte_sat || 1
    await browser.storage.local.set({lastFeeRate: feeRate, lastFeeRateTime: Date.now()})
    return feeRate
  } catch (err) {
    clearTimeout(timeoutId)
    console.error('getFeeRate error:', err)
    return 1 // Fallback
  }
}
async function selectUtxos(utxos, targetAmount, feeRate) {
  // Greedy selection: Sort descending, pick until covered
  utxos.sort((a, b) => b.value - a.value)
  let selected = []
  let total = 0n
  for (let utxo of utxos) {
    if (utxo.value < 546) continue // Skip dust
    selected.push(utxo)
    total += BigInt(utxo.value)
    let estInputs = selected.length
    let estOutputs = total - targetAmount > 546n ? 2 : 1 // + change?
    let estSize = 10 + estInputs * 148 + estOutputs * 34
    let estFee = BigInt(estSize) * BigInt(feeRate)
    if (total >= targetAmount + estFee) return {selected, total}
  }
  throw new Error('Insufficient funds')
}
async function sendTip (senderNpub, nsec, recipientNpub, amountSat) {
  console.log('sendTip started:', {senderNpub, recipientNpub, amountSat})
  const { type, data: privBytes } = nip19.decode(nsec)
  if (type !== 'nsec') {
    return { success: false, error: 'Invalid nsec' }
  }
  try {
    const { encode } = await import('cashaddrjs') // Dynamic import to defer loading
    const compressedPub = secp.getPublicKey(privBytes, true)
    const senderPkh = _hash160(compressedPub)
    const senderAddress = encode('bitcoincash', 'P2PKH', senderPkh)
    // Derive recipient (fixed to use Point for correct parity)
    let recipientHex
    try {
      recipientHex = nip19.decode(recipientNpub).data
    } catch {
      return { success: false, error: 'Invalid recipient npub' }
    }
    const point = secp.Point.fromHex(recipientHex) // Uses x-only, assumes even y as per noble (prepends 02)
    const recipientCompressedPub = point.toRawBytes(true)
    const recipientPkh = _hash160(recipientCompressedPub)
    const recipientAddress = encode('bitcoincash', 'P2PKH', recipientPkh)
    // Pre-balance check
    const balance = await getBCHBalance(senderAddress)
    const feeRate = await getFeeRate()
    const estFee = BigInt(200) * BigInt(feeRate) // Rough est for 1in/1-2out
    if (balance < amountSat + Number(estFee)) {
      console.log('Balance check failed:', balance); // Added log
      return { success: false, error: `Insufficient balance: ${balance} sat available` }
    }
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 10000) // 10s timeout
    const utxoRes = await fetch(`${API_BASE}utxos/${senderAddress}`, { signal: controller.signal })
    clearTimeout(timeoutId)
    if (!utxoRes.ok) {
      return { success: false, error: 'Failed to fetch UTXOs' }
    }
    const utxoData = await utxoRes.json()
    if (!utxoData.success || !utxoData.utxos.length) {
      return { success: false, error: 'No UTXOs found' }
    }
    const { instantiateSha256 } = await import('@bitauth/libauth')
    const sha256Instance = await instantiateSha256()
    const sha256Hash = sha256Instance.hash
    return new Promise((resolve) => {
      sendTransaction(senderAddress, recipientAddress, BigInt(amountSat), utxoData.utxos, sha256Hash, privBytes, feeRate, (err, txId) => {
        if (err) {
          console.error('sendTransaction error:', err)
          resolve({ success: false, error: err.message })
        } else {
          console.log('sendTransaction success:', txId)
          resolve({ success: true, txId })
        }
      })
    })
  } catch (err) {
    console.error('sendTip error:', err); // Added log for catch
    return { success: false, error: err.message }
  }
}
function sendTransaction (senderAddress, recipientAddress, amountSat, utxos, sha256, privBytes, feeRate, callback) {
  console.log('sendTransaction started')
  import('@bitauth/libauth').then(async (libauth) => {
    try {
      const {selected: inputs, total: totalInput} = await selectUtxos(utxos, amountSat, feeRate)
      const inputCount = inputs.length
      const estSize = 10 + inputCount * 148 + 68 // 2 outputs max (tip + change)
      let fee = BigInt(estSize) * BigInt(feeRate)
      let change = totalInput - amountSat - fee
      if (change < 0n) throw new Error('Insufficient funds after fee calc')
      const transaction = {
        version: 2,
        inputs: inputs.map(utxo => ({
          outpointTransactionHash: libauth.hexToBin(utxo.txid),
          outpointIndex: utxo.vout,
          unlockingBytecode: new Uint8Array(),
          sequenceNumber: 0xffffffff
        })),
        outputs: [{
          valueSatoshis: amountSat,
          lockingBytecode: await _buildP2PKHOutput(recipientAddress)
        }],
        locktime: 0
      }
      if (change >= 546n) {
        transaction.outputs.push({
          valueSatoshis: change,
          lockingBytecode: await _buildP2PKHOutput(senderAddress)
        })
      } else {
        // Recalc fee without change output
        fee += 34n * BigInt(feeRate) // Extra for omitted output
        change = totalInput - amountSat - fee
        if (change < 0n) throw new Error('Insufficient funds')
      }
      transaction.inputs.forEach((input, i) => {
        const coveredBytecode = libauth.hexToBin(utxos[i].scriptPubKey)
        const transactionOutpointsHash = sha256(sha256(libauth.encodeTransactionOutpoints(transaction.inputs)))
        const transactionSequenceNumbersHash = sha256(sha256(libauth.encodeTransactionInputSequenceNumbersForSigning(transaction.inputs)))
        const transactionOutputsHash = sha256(sha256(libauth.encodeTransactionOutputs(transaction.outputs)))
        const preimage = libauth.generateSigningSerializationBCH({
          forkId: BigInt(0),
          coveredBytecode,
          outpointTransactionHash: input.outpointTransactionHash,
          outpointIndex: input.outpointIndex,
          sequenceNumber: input.sequenceNumber,
          valueSatoshis: BigInt(utxos[i].value),
          version: transaction.version,
          transactionOutpointsHash,
          transactionSequenceNumbersHash,
          transactionOutputsHash,
          locktime: transaction.locktime,
          signingSerializationType: BigInt(0x41)
        })
        const message = sha256(sha256(preimage))
        const sig = secp.sign(message, privBytes, { der: false })
        const derSig = _encodeDer(sig.r, sig.s)
        const sigWithType = new Uint8Array([...derSig, 0x41])
        const pubkey = secp.getPublicKey(privBytes, true)
        input.unlockingBytecode = new Uint8Array([sigWithType.length, ...sigWithType, pubkey.length, ...pubkey])
      })
      const rawTx = libauth.binToHex(libauth.encodeTransaction(transaction))
      fetch(`${API_BASE}broadcast`, {
        method: 'POST',
        body: JSON.stringify({ rawtx: rawTx }),
        headers: { 'Content-Type': 'application/json' }
      })
        .then(broadcastRes => {
          if (!broadcastRes.ok) throw new Error(`Broadcast error: ${broadcastRes.statusText}`)
          return broadcastRes.json()
        })
        .then(data => {
          callback(null, data.txid)
        })
        .catch(e => {
          callback(e)
        })
    } catch (err) {
      callback(err)
    }
  }).catch((importErr) => {
    callback(new Error('Failed to load transaction library: ' + importErr.message))
  })
}
console.log('Background script loaded successfully'); // Debug log for successful parse/load