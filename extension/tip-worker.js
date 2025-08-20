// tip-worker.js - Web Worker for BCH tipping (allows dynamic imports)
import { getPublicKey } from 'nostr-tools/pure';
import * as nip19 from 'nostr-tools/nip19';
import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';

// Retry wrapper
function withRetry(fn, attempts = 3) {
  return async (...args) => {
    for (let i = 1; i <= attempts; i++) {
      try {
        return await fn(...args);
      } catch (err) {
        console.warn(`Attempt ${i} failed: ${err.message}`);
        if (i === attempts) throw err;
      }
    }
  };
}

// API fetch functions (Blockchair)
const getBalanceSats = withRetry(async (address) => {
  const res = await fetch(`https://api.blockchair.com/bitcoin-cash/dashboards/address/${address}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const { data } = await res.json();
  const addrData = data[address];
  if (!addrData) throw new Error('Invalid address response');
  return addrData.address.balance;
});

const getUtxos = withRetry(async (address) => {
  const res = await fetch(`https://api.blockchair.com/bitcoin-cash/dashboards/address/${address}?limit=100`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const { data } = await res.json();
  const addrData = data[address];
  if (!addrData) throw new Error('Invalid address response');
  return addrData.utxo.map(u => ({
    txid: u.transaction_hash,
    vout: u.index,
    value: u.value
  }));
});

const getFeeRate = withRetry(async () => {
  const res = await fetch('https://api.blockchair.com/bitcoin-cash/stats');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const { data } = await res.json();
  return data.suggested_transaction_fee_per_byte_sat;
});

const broadcastTx = withRetry(async (hex) => {
  const res = await fetch('https://api.blockchair.com/bitcoin-cash/push/transaction', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: hex })
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (json.data && json.data.transaction_hash) return json.data.transaction_hash;
  throw new Error(json.context?.error || 'Broadcast failed');
});

// Listen for messages from background.js
self.onmessage = async (event) => {
  const { action, params } = event.data;
  if (action === 'sendTip') {
    const result = await sendTip(params.senderNpub, params.nsec, params.recipientNpub, params.amountSat, params.notify);
    event.ports[0].postMessage(result); // Respond via MessagePort
  }
};

// --- BCH Helpers ---
function _hash160(x) {
  return ripemd160(sha256(x));
}

function _encodeDer(r, s) {
  function encodeInt(val) {
    let bytes = [];
    let tmp = val;
    if (tmp === 0n) bytes.push(0);
    while (tmp > 0n) {
      bytes.push(Number(tmp & 0xffn));
      tmp >>= 8n;
    }
    bytes = bytes.reverse();
    if (bytes[0] & 0x80) bytes.unshift(0);
    return new Uint8Array([0x02, bytes.length, ...bytes]);
  }
  const rEnc = encodeInt(r);
  const sEnc = encodeInt(s);
  const totalLen = rEnc.length + sEnc.length;
  return new Uint8Array([0x30, totalLen, ...rEnc, ...sEnc]);
}

async function _buildP2PKHOutput(address) {
  const libauth = await import('@bitauth/libauth');
  const { cashAddressToLockingBytecode } = libauth;
  const result = cashAddressToLockingBytecode(address);
  if (typeof result === 'string') throw new Error(result);
  return result.bytecode;
}

async function getCashAddress(publicKey) {
  const libauth = await import('@bitauth/libauth');
  const { publicKeyToP2pkhCashAddress } = libauth;
  const result = publicKeyToP2pkhCashAddress({ publicKey });
  if (typeof result === 'string') return result;
  throw new Error('Invalid public key for address derivation');
}

async function selectUtxos(utxos, targetAmount, feeRate) {
  utxos = utxos.filter(utxo => utxo.value >= 546); // Skip dust
  utxos.sort((a, b) => b.value - a.value); // Descending
  let selected = [];
  let total = 0n;
  for (let utxo of utxos) {
    selected.push(utxo);
    total += BigInt(utxo.value);
    const estInputs = selected.length;
    const estOutputs = (total - targetAmount > 546n) ? 2 : 1;
    const estSize = 10 + estInputs * 148 + estOutputs * 34;
    const estFee = BigInt(estSize) * feeRate;
    if (total >= targetAmount + estFee) {
      return { selected, total };
    }
  }
  throw new Error('Insufficient funds after UTXO selection');
}

async function sendTip(senderNpub, nsec, recipientNpub, amountSat, notify) {
  amountSat = BigInt(amountSat);
  const { type, data: privBytes } = nip19.decode(nsec);
  if (type !== 'nsec') return { success: false, error: 'Invalid nsec' };
  if (amountSat < 1000n) return { success: false, error: 'Minimum tip 1000 sats' };

  try {
    const compressedPub = secp.getPublicKey(privBytes, true);
    const senderAddress = await getCashAddress(compressedPub);

    const { type: recipientType, data: recipientHex } = nip19.decode(recipientNpub);
    if (recipientType !== 'npub') throw new Error('Invalid recipient type');

    let recipientCompressedPub;
    try {
      recipientCompressedPub = secp.Point.fromHex('02' + recipientHex).toRawBytes(true); // Even y
    } catch {
      recipientCompressedPub = secp.Point.fromHex('03' + recipientHex).toRawBytes(true); // Odd y
    }
    const recipientAddress = await getCashAddress(recipientCompressedPub);

    const balance = BigInt(await getBalanceSats(senderAddress));
    const feeRate = BigInt(Math.max(await getFeeRate(), 1));
    const dustLimit = 546n;
    if (balance === 0n) return { success: false, error: 'No balance available' };
    if (balance < dustLimit) return { success: false, error: 'Dust balance only - cannot tip' };

    const utxos = await getUtxos(senderAddress);
    if (!utxos.length) return { success: false, error: 'No UTXOs found' };

    const estInputs = Math.min(utxos.length, 2);
    const estOutputs = 2;
    const estSize = 10 + estInputs * 148 + estOutputs * 34;
    const estFee = BigInt(estSize) * feeRate;
    const minRequired = amountSat + estFee + dustLimit;
    if (balance < minRequired) return { success: false, error: `Insufficient balance: ${balance} sats. Need at least ${minRequired} sats.` };

    return new Promise((resolve) => {
      sendTransaction(senderAddress, recipientAddress, amountSat, utxos, sha256, privBytes, feeRate, (err, txId) => {
        if (err) {
          console.error('sendTransaction error:', err);
          resolve({ success: false, error: err.message });
        } else {
          console.log('sendTransaction success:', txId);
          resolve({ success: true, txId });
        }
      });
    });
  } catch (err) {
    console.error('sendTip error:', err);
    return { success: false, error: err.message };
  }
}

function sendTransaction(senderAddress, recipientAddress, amountSat, utxos, sha256, privBytes, feeRate, callback) {
  import('@bitauth/libauth').then(async (libauth) => {
    try {
      const { selected: inputs, total: totalInput } = await selectUtxos(utxos, amountSat, feeRate);
      let fee = BigInt(10 + inputs.length * 148 + 68) * feeRate;
      let change = totalInput - amountSat - fee;
      if (change < 0n) throw new Error('Insufficient funds after fee calc');

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
      };

      if (change >= 546n) {
        transaction.outputs.push({
          valueSatoshis: change,
          lockingBytecode: await _buildP2PKHOutput(senderAddress)
        });
      } else {
        fee += 34n * feeRate;
        change = totalInput - amountSat - fee;
        if (change < 0n) throw new Error('Insufficient funds');
      }

      for (let i = 0; i < transaction.inputs.length; i++) {
        const utxo = inputs[i];
        let coveredBytecode = utxo.scriptPubKey ? libauth.hexToBin(utxo.scriptPubKey) : await _buildP2PKHOutput(senderAddress);
        const transactionOutpointsHash = sha256(sha256(libauth.encodeTransactionOutpoints(transaction.inputs)));
        const transactionSequenceNumbersHash = sha256(sha256(libauth.encodeTransactionInputSequenceNumbersForSigning(transaction.inputs)));
        const transactionOutputsHash = sha256(sha256(libauth.encodeTransactionOutputs(transaction.outputs)));
        const preimage = libauth.generateSigningSerializationBCH({
          forkId: BigInt(0),
          coveredBytecode,
          outpointTransactionHash: transaction.inputs[i].outpointTransactionHash,
          outpointIndex: transaction.inputs[i].outpointIndex,
          sequenceNumber: transaction.inputs[i].sequenceNumber,
          valueSatoshis: BigInt(utxo.value),
          version: transaction.version,
          transactionOutpointsHash,
          transactionSequenceNumbersHash,
          transactionOutputsHash,
          locktime: transaction.locktime,
          signingSerializationType: BigInt(0x41)
        });
        const message = sha256(sha256(preimage));
        const sig = secp.sign(message, privBytes, { der: false });
        const derSig = _encodeDer(sig.r, sig.s);
        const sigWithType = new Uint8Array([...derSig, 0x41]);
        const pubkey = secp.getPublicKey(privBytes, true);
        transaction.inputs[i].unlockingBytecode = new Uint8Array([sigWithType.length, ...sigWithType, pubkey.length, ...pubkey]);
      }

      const rawTx = libauth.binToHex(libauth.encodeTransaction(transaction));
      const txId = await broadcastTx(rawTx);
      callback(null, txId);
    } catch (err) {
      callback(err);
    }
  }).catch((importErr) => {
    callback(new Error('Failed to load transaction library: ' + importErr.message));
  });
}