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
  API_BASE,
  deriveBCHAddress,
  getBCHBalance
} from './common'

import * as secp from '@noble/secp256k1'
import { hmac } from '@noble/hashes/hmac'
import { sha256 } from '@noble/hashes/sha2'
import { ripemd160 } from '@noble/hashes/legacy'
import {
  binToHex,
  cashAddressToLockingBytecode,
  encodeTransaction,
  encodeTransactionOutpoints,
  encodeTransactionOutputs,
  encodeTransactionInputSequenceNumbersForSigning,
  generateSigningSerializationBCH,
  hexToBin,
  instantiateSha256
} from '@bitauth/libauth'

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

browser.runtime.onInstalled.addListener((_, __, reason) => {
  if (reason === 'install') browser.runtime.openOptionsPage()
})

browser.runtime.onMessage.addListener(async (message, sender) => {
  let {prompt} = message
  if (prompt) {
    handlePromptMessage(message, sender)
  } else {
    return handleContentScriptMessage(message)
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
  if (!host) host = 'nos2bch'
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

    let allowed = await getPermissionStatus(
      host,
      type,
      type === 'signEvent' ? params.event : (type === 'tipBCH' ? params : undefined)
    )

    let opResult = await performOperation(type, params)

    let detailsForPrompt
    let preResult
    if (opResult.type === 'tipBCH') {
      if (opResult.error) {
        releasePromptMutex()
        return opResult
      }
      detailsForPrompt = opResult.details
      preResult = 'tip precomputed'
    } else {
      preResult = opResult
    }

    if (allowed === true) {
      let finalResult = opResult.type === 'tipBCH' ? await opResult.postAccept() : preResult
      releasePromptMutex()
      showNotification(host, allowed, type, params)
      return finalResult
    } else if (allowed === false) {
      releasePromptMutex()
      showNotification(host, allowed, type, params)
      return {
        error: {message: 'denied'}
      }
    } else {
      try {
        let id = Math.random().toString().slice(4)
        let qs = new URLSearchParams({
          host,
          id,
          params: JSON.stringify(params),
          type
        })
        if (detailsForPrompt) {
          qs.set('details', JSON.stringify(detailsForPrompt))
        }
        if (typeof preResult === 'string') {
          qs.set('result', preResult)
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

        if (!accept) return {error: {message: 'denied'}}

        let finalResult = opResult.type === 'tipBCH' ? await opResult.postAccept() : preResult
        return finalResult
      } catch (err) {
        releasePromptMutex()
        return {
          error: {message: err.message, stack: err.stack}
        }
      }
    }
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
      case 'tipBCH': {
        const { recipientNpub, amountSat } = params
        const amount = BigInt(amountSat)
        const pubkeyHex = getPublicKey(sk)
        const senderAddress = deriveBCHAddress(pubkeyHex)
        const recipientHex = nip19.decode(recipientNpub).data
        const recipientAddress = deriveBCHAddress(recipientHex)

        const utxoRes = await fetch(`${API_BASE}utxos/${senderAddress}`)
        if (!utxoRes.ok) {
          return { error: { message: 'Failed to fetch UTXOs' } }
        }
        const utxoData = await utxoRes.json()
        if (!utxoData.success || !utxoData.utxos.length) {
          return { error: { message: 'No UTXOs found. Balance is 0.' } }
        }
        const utxos = utxoData.utxos

        const inputCount = utxos.length
        const estimatedSize = 10 + inputCount * 148 + 34 * (utxos.length > 1 ? 2 : 1) // Approximate
        const fee = BigInt(estimatedSize) // 1 sat/byte
        const totalInput = utxos.reduce((sum, utxo) => sum + BigInt(utxo.value), 0n)
        let change = totalInput - amount - fee
        if (change < 0n) {
          return { error: { message: 'Insufficient funds' } }
        }

        const details = {
          senderAddress,
          recipientAddress,
          recipientNpub,
          amountSat: amount.toString(),
          feeSat: fee.toString(),
          changeSat: change.toString(),
          totalInputSat: totalInput.toString()
        }

        const postAccept = async () => {
          const sha256Instance = await instantiateSha256()
          const sha256Hash = sha256Instance.hash.bind(sha256Instance)

          const transaction = {
            version: 2,
            inputs: utxos.map(utxo => ({
              outpointTransactionHash: hexToBin(utxo.txid),
              outpointIndex: utxo.vout,
              unlockingBytecode: new Uint8Array(),
              sequenceNumber: 0xffffffff
            })),
            outputs: [{
              valueSatoshis: amount,
              lockingBytecode: _buildP2PKHOutput(recipientAddress)
            }],
            locktime: 0
          }

          if (change > 546n) {
            transaction.outputs.push({
              valueSatoshis: change,
              lockingBytecode: _buildP2PKHOutput(senderAddress)
            })
          }

          const privBytes = hexToBin(sk)

          transaction.inputs.forEach((input, i) => {
            const coveredBytecode = hexToBin(utxos[i].scriptPubKey)
            const transactionOutpointsHash = sha256Hash(sha256Hash(encodeTransactionOutpoints(transaction.inputs)))
            const transactionSequenceNumbersHash = sha256Hash(sha256Hash(encodeTransactionInputSequenceNumbersForSigning(transaction.inputs)))
            const transactionOutputsHash = sha256Hash(sha256Hash(encodeTransactionOutputs(transaction.outputs)))
            const preimage = generateSigningSerializationBCH({
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
            const message = sha256Hash(sha256Hash(preimage))
            const sig = secp.sign(message, privBytes)
            const derSig = _encodeDer(sig.r, sig.s)
            const sigWithType = new Uint8Array([...derSig, 0x41])
            const pubkey = secp.getPublicKey(privBytes, true)
            input.unlockingBytecode = new Uint8Array([sigWithType.length, ...sigWithType, pubkey.length, ...pubkey])
          })

          const rawTx = binToHex(encodeTransaction(transaction))

          const broadcastRes = await fetch(`${API_BASE}broadcast`, {
            method: 'POST',
            body: JSON.stringify({ rawtx: rawTx }),
            headers: { 'Content-Type': 'application/json' }
          })
          if (!broadcastRes.ok) throw new Error(`Broadcast error: ${await broadcastRes.text()}`)
          const data = await broadcastRes.json()
          return { txid: data.txid }
        }

        return { type: 'tipBCH', details, postAccept }
      }
    }
  } catch (error) {
    return {error: {message: error.message, stack: error.stack}}
  }
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

function _buildP2PKHOutput (address) {
  const result = cashAddressToLockingBytecode(address)
  if (typeof result === 'string') {
    throw new Error(result)
  }
  return result.bytecode
}

async function handlePromptMessage({host, type, accept, conditions}, sender) {
  openPrompt?.resolve?.(accept)

  if (conditions && host !== 'nos2bch') {
    await updatePermission(host, type, accept, conditions)
  }

  openPrompt = null

  releasePromptMutex()

  if (sender) {
    browser.windows.remove(sender.tab.windowId)
  }
}