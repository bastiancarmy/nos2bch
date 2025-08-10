// extension/background.js
import browser from 'webextension-polyfill'
import { validateEvent, finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import * as nip19 from 'nostr-tools/nip19'
import * as nip04 from 'nostr-tools/nip04'
import * as nip44 from 'nostr-tools/nip44'
import { Mutex } from 'async-mutex'
import { LRUCache } from './utils'

import {
  NO_PERMISSIONS_REQUIRED,
  getPermissionStatus,
  updatePermission,
  showNotification,
  getPosition,
  deriveBCHAddress,
  getBCHBalance,
  API_BASE
} from './common'

import * as secp from '@noble/secp256k1'
import { hmac } from '@noble/hashes/hmac'
import { sha256 } from '@noble/hashes/sha2'
import { ripemd160 } from '@noble/hashes/ripemd160'
import {
  binToHex,
  cashAddressToLockingBytecode,
  encodeTransaction,
  encodeTransactionOutpoints,
  encodeTransactionOutputs,
  encodeTransactionInputSequenceNumbersForSigning,
  generateSigningSerializationBCH,
  hexToBin,
  flattenBinArray
} from '@bitauth/libauth'

// Enable sync methods in secp
secp.etc.hmacSha256Sync = (k, ...m) => hmac(sha256, k, secp.etc.concatBytes(...m))

let openPrompt = null
let promptMutex = new Mutex()
let releasePromptMutex = () => {}
let secretsCache = new LRUCache(100)
let previousSk = null

function getSharedSecret(sk, peer) {
  // Detect a key change and erase the cache if they changed their key
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

//set the width and height of the prompt window
const width = 440
const height = 420

browser.runtime.onInstalled.addListener((_, __, reason) => {
  if (reason === 'install') browser.runtime.openOptionsPage()
})

browser.runtime.onMessage.addListener(async (message, sender) => {
  // Internal message handler
  return handleContentScriptMessage(message);
})

browser.runtime.onMessageExternal.addListener(
  async ({type, params}, sender) => {
    let extensionId = new URL(sender.url).host
    return handleContentScriptMessage({type, params, host: extensionId})
  }
)

browser.windows.onRemoved.addListener(_ => {
  if (openPrompt) {
    // calling this with a simple "no" response will not store anything, so it's fine
    // it will just return a failure
    handlePromptMessage({accept: false}, null)
  }
})

async function handleContentScriptMessage({type, params, host}) {
  if (NO_PERMISSIONS_REQUIRED[type]) {
    // authorized, and we won't do anything with private key here, so do a separate handler
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
    if (!host) {
      // Internal message (e.g., from popup/options): trusted, no permission check needed.
      return performOperation(type, params);
    }

    // acquire mutex here before reading policies
    releasePromptMutex = await promptMutex.acquire()

    // do the operation before asking (because we'll show the encryption/decryption results in the popup
    const finalResult = await performOperation(type, params)

    let allowed = await getPermissionStatus(
      host,
      type,
      params // Pass full params for tipBCH
    )

    if (allowed === true) {
      // authorized, proceed
      releasePromptMutex()
      showNotification(host, allowed, type, params)
    } else if (allowed === false) {
      // denied, just refuse immediately
      releasePromptMutex()
      showNotification(host, allowed, type, params)
      return {
        error: {message: 'denied'}
      }
    } else {
      // ask for authorization
      try {
        let id = Math.random().toString().slice(4)
        let qs = new URLSearchParams({
          host,
          id,
          params: JSON.stringify(params),
          type
        })
        if (typeof finalResult === 'string') {
          qs.set('result', finalResult)
        }
        // center prompt
        const {top, left} = await getPosition(width, height)
        // prompt will be resolved with true or false
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

        // denied, stop here
        if (!accept) return {error: {message: 'denied'}}
      } catch (err) {
        // errored, stop here
        releasePromptMutex()
        return {
          error: {message: err.message, stack: err.stack}
        }
      }
    }

    // the call was authorized, so we just return the result we had from before
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
        return validateEvent(event)
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
      case 'getBCHAddress': {
        return deriveBCHAddress(getPublicKey(sk))
      }
      case 'getBCHBalance': {
        const address = deriveBCHAddress(getPublicKey(sk))
        return getBCHBalance(address)
      }
      case 'tipBCH': {
        const { recipientPubkey, amountSat } = params
        return tipBCH(recipientPubkey, amountSat)
      }
    }
  } catch (error) {
    return {error: {message: error.message, stack: error.stack}}
  }
}

async function handlePromptMessage({host, type, accept, conditions}, sender) {
  // return response
  openPrompt?.resolve?.(accept)

  // update policies
  if (conditions) {
    await updatePermission(host, type, accept, conditions)
  }

  // cleanup this
  openPrompt = null

  // release mutex here after updating policies
  releasePromptMutex()

  // close prompt
  if (sender) {
    browser.windows.remove(sender.tab.windowId)
  }
}

// --- BCH Helpers ---
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

function _buildP2PKHOutput (address) {
  const result = cashAddressToLockingBytecode(address)
  if (typeof result === 'string') {
    throw new Error(result)
  }
  return result.bytecode
}

async function tipBCH (recipientPubkey, amountSat) {
  const results = await browser.storage.local.get('private_key')
  if (!results.private_key) {
    throw new Error('No private key found')
  }
  const sk = results.private_key
  const pubHex = getPublicKey(sk)
  const senderAddress = deriveBCHAddress(pubHex)

  const recipientAddress = deriveBCHAddress(recipientPubkey)

  const utxoRes = await fetch(`${API_BASE}utxos/${senderAddress}`)
  if (!utxoRes.ok) {
    throw new Error('Failed to fetch UTXOs')
  }
  const utxoData = await utxoRes.json()
  if (!utxoData.success || !utxoData.utxos.length) {
    throw new Error('No UTXOs found')
  }
  const utxos = utxoData.utxos

  const sha256Hash = sha256;

  return await sendTransaction(senderAddress, recipientAddress, amountSat, utxos, sha256Hash, hexToBytes(sk))
}

async function sendTransaction (senderAddress, recipientAddress, amountSat, utxos, sha256, privBytes) {
  const inputs = utxos.map(utxo => ({
    outpointTransactionHash: hexToBin(utxo.tx_hash).reverse(),
    outpointIndex: utxo.tx_pos,
    sequenceNumber: 0xffffffff,
    unlockingBytecode: new Uint8Array()
  }))

  const outputs = [{
    valueSatoshis: BigInt(amountSat),
    lockingBytecode: _buildP2PKHOutput(recipientAddress)
  }]

  const inputCount = inputs.length
  let estimatedSize = 10 + inputCount * 148 + 34 * 2
  let fee = BigInt(estimatedSize)
  const totalInput = utxos.reduce((sum, utxo) => sum + BigInt(utxo.value), 0n)
  let change = totalInput - BigInt(amountSat) - fee
  if (change < 0n) {
    throw new Error('Insufficient funds')
  }
  if (change >= 546n) {
    outputs.push({
      valueSatoshis: change,
      lockingBytecode: _buildP2PKHOutput(senderAddress)
    })
    estimatedSize += 34
    fee = BigInt(estimatedSize)
    change = totalInput - BigInt(amountSat) - fee
    outputs[1].valueSatoshis = change
  }

  const transaction = {
    version: 2,
    inputs,
    outputs,
    locktime: 0
  }

  const transactionOutpointsHash = sha256(sha256(encodeTransactionOutpoints(transaction.inputs)))
  const transactionSequenceNumbersHash = sha256(sha256(encodeTransactionInputSequenceNumbersForSigning(transaction.inputs)))
  const transactionOutputsHash = sha256(sha256(encodeTransactionOutputs(transaction.outputs)))

  for (let i = 0; i < transaction.inputs.length; i++) {
    const input = transaction.inputs[i]
    const valueSatoshis = BigInt(utxos[i].value)
    const coveredBytecode = _buildP2PKHOutput(senderAddress)
    const preimage = generateSigningSerializationBCH({
      forkId: BigInt(0),
      coveredBytecode,
      outpointTransactionHash: input.outpointTransactionHash,
      outpointIndex: input.outpointIndex,
      sequenceNumber: input.sequenceNumber,
      valueSatoshis,
      version: transaction.version,
      transactionOutpointsHash,
      transactionSequenceNumbersHash,
      transactionOutputsHash,
      locktime: transaction.locktime,
      signingSerializationType: BigInt(0x41)
    })
    const message = sha256(sha256(preimage))
    const sig = secp.sign(message, privBytes, { der: false, lowS: true })
    const derSig = _encodeDer(sig.r, sig.s)
    const sigWithType = new Uint8Array([...derSig, 0x41])
    const pubkey = secp.getPublicKey(privBytes, true)
    input.unlockingBytecode = flattenBinArray([
      new Uint8Array([sigWithType.length]),
      sigWithType,
      new Uint8Array([pubkey.length]),
      pubkey
    ])
  }

  const rawTx = binToHex(encodeTransaction(transaction))

  const broadcastRes = await fetch(`${API_BASE}broadcast`, {
    method: 'POST',
    body: JSON.stringify({ rawtx: rawTx }),
    headers: { 'Content-Type': 'application/json' }
  })
  if (!broadcastRes.ok) {
    throw new Error(`Broadcast error: ${broadcastRes.statusText}`)
  }
  const data = await broadcastRes.json()
  if (!data.success) {
    throw new Error(data.error || 'Broadcast failed')
  }
  return data.txid
}