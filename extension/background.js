import browser from 'webextension-polyfill'
import {getPublicKey, finalizeEvent, verifyEvent} from 'nostr-tools/pure'
import {nip04, nip19} from 'nostr-tools'
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
  getBCHBalance,
  getFeeRate,
  getUtxos,
  broadcastTx
} from './common'
import * as secp from '@noble/secp256k1'
import { hmac } from '@noble/hashes/hmac'
import { sha256 } from '@noble/hashes/sha256'
import { ripemd160 } from '@noble/hashes/ripemd160'

console.log('Background script starting to load...');  // Debug log for registration

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

const sideEffectTypes = new Set(['tipBCH'])  // Types with side effects (e.g., broadcast tx)

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
        const { recipientNpub, amountSat, notify = false } = params;  // Add notify with default false
        console.log('Performing tipBCH to', recipientNpub, 'amount', amountSat, 'notify', notify);
        const nsec = nip19.nsecEncode(secp.utils.hexToBytes(sk));
        const senderNpub = nip19.npubEncode(getPublicKey(sk));
        return await sendTip(senderNpub, nsec, recipientNpub, amountSat, notify);  // Pass notify
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

async function _buildP2PKHOutput (address) {  // Made async for await import
  const { cashAddressToLockingBytecode } = await import('@bitauth/libauth')
  const result = cashAddressToLockingBytecode(address)
  if (typeof result === 'string') {
    throw new Error(result)
  }
  return result.bytecode
}

async function selectUtxos(utxos, targetAmount, feeRate) {
  utxos = utxos.filter(utxo => utxo.value >= 546)  // Skip dust
  utxos.sort((a, b) => b.value - a.value)  // Descending
  let selected = []
  let total = 0n
  for (let utxo of utxos) {
    selected.push(utxo)
    total += BigInt(utxo.value)
    const estInputs = selected.length
    const estOutputs = (total - targetAmount > 546n) ? 2 : 1
    const estSize = 10 + estInputs * 148 + estOutputs * 34
    const estFee = BigInt(estSize) * feeRate
    if (total >= targetAmount + estFee) {
      console.log('Selected UTXOs:', selected.length, 'Total:', total.toString())
      return {selected, total}
    }
  }
  throw new Error('Insufficient funds after UTXO selection')
}

async function sendTip (senderNpub, nsec, recipientNpub, amountSat, notify) {  // Add notify
  console.log('sendTip started:', {senderNpub, recipientNpub, amountSat})
  const { type, data: privBytes } = nip19.decode(nsec)
  if (type !== 'nsec') {
    console.error('Invalid nsec type')
    return { success: false, error: 'Invalid nsec' }
  }

  if (amountSat < 1000) {
    return { success: false, error: 'Minimum tip 1000 sats' }
  }

  try {
    const compressedPub = secp.getPublicKey(privBytes, true)
    const senderPkh = _hash160(compressedPub)
    const senderAddress = await getCashAddress('bitcoincash', 'p2pkh', senderPkh)  // Define getCashAddress below

    // Derive recipient with validation
    let recipientHex
    try {
      const decoded = nip19.decode(recipientNpub)
      if (decoded.type !== 'npub') throw new Error('Invalid recipient type')
      recipientHex = decoded.data
    } catch (err) {
      console.error('Invalid recipient npub:', err)
      return { success: false, error: 'Invalid recipient npub' }
    }
    let recipientCompressedPub
    try {
      recipientCompressedPub = secp.Point.fromHex('02' + recipientHex).toRawBytes(true)  // Even y
    } catch {
      try {
        recipientCompressedPub = secp.Point.fromHex('03' + recipientHex).toRawBytes(true)  // Odd y
      } catch (err) {
        console.error('Invalid recipient pubkey:', err)
        return { success: false, error: 'Invalid recipient pubkey derivation' }
      }
    }
    const recipientPkh = _hash160(recipientCompressedPub)
    const recipientAddress = await getCashAddress('bitcoincash', 'p2pkh', recipientPkh)  // Use same function

    // Pre-balance check with dynamic fee
    const balance = BigInt(await getBCHBalance(senderAddress))  // sat
    console.log('Sender balance:', balance.toString(), 'sat')
    let feeRateNum = await getFeeRate()  // number
    const feeRate = BigInt(Math.max(feeRateNum, 1))  // Ensure at least 1 sat/byte
    console.log('Current fee rate:', feeRate.toString(), 'sat/byte')
    const dustLimit = 546n
    if (balance === 0n) {
      return { success: false, error: 'No balance available' }
    }
    if (balance < dustLimit) {
      return { success: false, error: 'Dust balance only - cannot tip' }
    }

    // Fetch UTXOs early for accurate est
    const utxos = await getUtxos(senderAddress)
    if (!utxos.length) {
      console.error('No UTXOs found')
      return { success: false, error: 'No UTXOs found' }
    }

    // Est fee based on potential inputs/outputs (conservative: assume 2 inputs, 2 outputs)
    const estInputs = Math.min(utxos.length, 2)
    const estOutputs = 2  // Tip + change
    const estSize = 10 + estInputs * 148 + estOutputs * 34
    const estFee = BigInt(estSize) * feeRate
    const minRequired = BigInt(amountSat) + estFee + dustLimit  // Extra buffer for change/dust
    if (balance < minRequired) {
      console.error('Insufficient balance:', balance.toString(), ' < ', minRequired.toString())
      return { success: false, error: `Insufficient balance: ${balance} sat available. Need at least ${minRequired} sat for tip + fee.` }
    }

    const sha256Instance = await instantiateSha256()
    const sha256Hash = sha256Instance.hash

    return new Promise((resolve) => {
      sendTransaction(senderAddress, recipientAddress, BigInt(amountSat), utxos, sha256Hash, privBytes, feeRate, (err, txId) => {  // Remove async from callback
        if (err) {
          console.error('sendTransaction error:', err);
          resolve({ success: false, error: err.message });
        } else {
          console.log('sendTransaction success:', txId);
          if (notify) {
            publishTipNote(sk, recipientNpub, amountSat, txId)
              .then(() => console.log('Tip notification published successfully'))
              .catch(notifyErr => console.error('Failed to publish tip notification:', notifyErr));  // Fire-and-forget
          }
          resolve({ success: true, txId });
        }
      });
    });
  } catch (err) {
    console.error('sendTip error:', err)
    return { success: false, error: err.message }
  }
}

// Helper for cash address (async, since libauth dynamic, but call it in async context)
async function getCashAddress(prefix, type, hash) {
  const { encodeCashAddress } = await import('@bitauth/libauth');
  return encodeCashAddress(prefix, type, hash);
}

async function publishTipNote(sk, recipientNpub, amountSat, txId) {
  const { SimplePool } = await import('nostr-tools/pool');  // Dynamic import for MV3 safety

  const relays = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://eden.nostr.land'];  // Default reliable relays
  const pool = new SimplePool();

  let recipientHex;
  try {
    const decoded = nip19.decode(recipientNpub);
    if (decoded.type !== 'npub') throw new Error('Invalid recipient npub');
    recipientHex = decoded.data;
  } catch (err) {
    throw new Error('Invalid recipient npub for notification: ' + err.message);
  }

  const pubkey = getPublicKey(sk);
  const event = {
    kind: 1,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['p', recipientHex]],  // Tag recipient
    content: `Tipped ${amountSat} sat BCH to ${recipientNpub}! Tx: https://blockchair.com/bitcoin-cash/transaction/${txId} #BCHonNostr\n\nInstall nos2bch extension to claim your tips: https://chromewebstore.google.com/detail/nos2bch/{extension-id}`,  // Replace {extension-id} with actual ID
    pubkey,
  };

  const signedEvent = finalizeEvent(event, sk);
  await Promise.any(pool.publish(relays, signedEvent));  // Publish to at least one relay
  pool.destroy();  // Clean up (MV3: avoid lingering connections)
}

function sendTransaction (senderAddress, recipientAddress, amountSat, utxos, sha256, privBytes, feeRate, callback) {
  console.log('sendTransaction started')
  import('@bitauth/libauth').then(async (libauth) => {
    try {
      const {selected: inputs, total: totalInput} = await selectUtxos(utxos, amountSat, feeRate)
      const inputCount = inputs.length
      const estSize = 10 + inputCount * 148 + 68  // 2 outputs max (tip + change)
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
        fee += 34n * BigInt(feeRate)  // Extra for omitted output
        change = totalInput - amountSat - fee
        if (change < 0n) throw new Error('Insufficient funds')
      }

      transaction.inputs.forEach((input, i) => {
        const coveredBytecode = libauth.hexToBin(utxos[i].scriptPubKey || toScriptPubKey(senderAddress))  // Fallback if no scriptPubKey
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

      const txId = await broadcastTx(rawTx)
      callback(null, txId)
    } catch (err) {
      callback(err)
    }
  }).catch((importErr) => {
    callback(new Error('Failed to load transaction library: ' + importErr.message))
  })
}

function toScriptPubKey(address) {
  // Fallback: hardcode P2PKH script assuming address is cashaddr; in practice, parse hash
  // For working, assume utxos have scriptPubKey; this is placeholder
  const dummyPkh = new Uint8Array(20).fill(0); // Replace with actual decode
  return hexToBytes('76a914' + bytesToHex(dummyPkh) + '88ac');
}

console.log('Background script loaded successfully');