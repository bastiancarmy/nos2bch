import browser from 'webextension-polyfill'
import { validateEvent, finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import * as nip19 from 'nostr-tools/nip19'
import * as nip04 from 'nostr-tools/nip04'
import * as nip44 from 'nostr-tools/nip44'
import { Mutex } from 'async-mutex'
import { LRUCache } from './utils'
import { hexToBytes } from '@noble/hashes/utils'
import { hexToBin } from '@bitauth/libauth'

import {
  NO_PERMISSIONS_REQUIRED,
  getPermissionStatus,
  updatePermission,
  showNotification,
  getPosition,
  deriveBCHAddress,
  getBCHBalance,
  BLOCKCHAIR_API
} from './common'

import * as secp from '@noble/secp256k1'
import { hmac } from '@noble/hashes/hmac'
import { sha256 } from '@noble/hashes/sha2'
import { encodePrivateKeyWif } from '@bitauth/libauth'
import { Wallet } from 'mainnet-js'

console.log('Background service worker loaded');

secp.etc.hmacSha256Sync = (k, ...m) => hmac(sha256, k, secp.etc.concatBytes(...m))

let openPrompt = null
let promptMutex = new Mutex()
let releasePromptMutex = () => {}
let secretsCache = new LRUCache(100)
let previousSk = null
let utxoCache = { utxos: [], timestamp: 0, balance: 0 }

async function fetchDynamicFeeRate() {
  try {
    const res = await fetch(`${BLOCKCHAIR_API}stats`)
    const data = await res.json()
    return data.data.suggested_transaction_fee_per_byte_sat || 1
  } catch {
    return 1 // Fallback
  }
}

async function getCachedUtxos(wallet) {
  const now = Date.now()
  if (utxoCache.timestamp > now - 60000) {
    return utxoCache.utxos
  }
  const utxos = await wallet.getUtxos()
  utxoCache = { utxos, timestamp: now, balance: utxos.reduce((sum, u) => sum + u.satoshis, 0) }
  return utxos
}

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

        const privKeyBytes = hexToBytes(sk)
        const wif = encodePrivateKeyWif(privKeyBytes, 'compressed')
        const wallet = await Wallet.fromWIF(wif)
        const utxos = await getCachedUtxos(wallet)
        if (utxos.length === 0) {
          return { error: { message: 'No UTXOs found. Balance is 0.' } }
        }

        const feeRate = await fetchDynamicFeeRate()
        const inputCount = utxos.length
        const estimatedSize = 10 + inputCount * 148 + 2 * 34
        let fee = BigInt(estimatedSize) * BigInt(feeRate)
        const totalInput = BigInt(utxoCache.balance)
        let change = totalInput - amount - fee

        const dustLimit = 546n
        if (amount < dustLimit) {
          return { error: { message: 'Amount below dust limit (546 sat)' } }
        }
        if (change > 0n && change < dustLimit) {
          change = 0n
          fee = totalInput - amount
        }
        if (change < 0n) {
          return { error: { message: 'Insufficient funds' } }
        }

        // Validate: inputs >= amount + fee + change
        if (totalInput < amount + fee + change) {
          return { error: { message: 'Invalid tx: insufficient funds' } }
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
          const { txId } = await wallet.send([{ cashaddr: recipientAddress, value: Number(amount), unit: 'sat' }])
          console.log('Tx broadcasted:', txId); // Log
          return { txid: txId }
        }

        return { type: 'tipBCH', details, postAccept }
      }
    }
  } catch (error) {
    console.error('Operation error:', error.message, error.stack);
    return {error: {message: error.message, stack: error.stack}};
  }
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