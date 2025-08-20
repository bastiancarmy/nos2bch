// tip-worker.js - Web Worker for BCH tipping (allows dynamic imports)
import { getPublicKey } from 'nostr-tools/pure';
import * as nip19 from 'nostr-tools/nip19';
import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha256';

import {
  _hash160,
  _encodeDer,
  _buildP2PKHOutput,
  getCashAddress,
  getBCHBalance,
  getUtxos,
  getFeeRate,
  broadcastTx
} from './common';

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

// Wrap common functions with retry if needed (e.g., for network flakiness)
const getBalanceSats = withRetry(async (address) => await getBCHBalance(address, true));
const getUtxosWrapped = withRetry(getUtxos);
const getFeeRateWrapped = withRetry(getFeeRate);
const broadcastTxWrapped = withRetry(broadcastTx);

// Listen for messages from background.js
self.onmessage = async (event) => {
  const { action, params } = event.data;
  const port = event.ports[0];
  try {
    if (action === 'sendTip') {
      const result = await sendTip(params.senderNpub, params.nsec, params.recipientNpub, params.amountSat, params.notify);
      port.postMessage(result); // Respond via MessagePort
    }
  } catch (err) {
    console.error('Worker error:', err);
    port.postMessage({ success: false, error: err.message });
  }
};

// --- BCH Helpers ---
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
    const feeRate = BigInt(Math.max(await getFeeRateWrapped(), 1));
    const dustLimit = 546n;
    if (balance === 0n) return { success: false, error: 'No balance available' };
    if (balance < dustLimit) return { success: false, error: 'Dust balance only - cannot tip' };

    const utxos = await getUtxosWrapped(senderAddress);
    if (!utxos.length) return { success: false, error: 'No UTXOs found' };

    const estInputs = Math.min(utxos.length, 2);
    const estOutputs = 2;
    const estSize = 10 + estInputs * 148 + estOutputs * 34;
    const estFee = BigInt(estSize) * feeRate;
    const minRequired = amountSat + estFee + dustLimit;
    if (balance < minRequired) return { success: false, error: `Insufficient balance: ${balance} sats. Need at least ${minRequired} sats.` };

    const txId = await sendTransaction(senderAddress, recipientAddress, amountSat, utxos, sha256, privBytes, feeRate);
    return { success: true, txId };
  } catch (err) {
    console.error('sendTip error:', err);
    return { success: false, error: err.message };
  }
}

async function sendTransaction(senderAddress, recipientAddress, amountSat, utxos, sha256, privBytes, feeRate) {
  const libauth = await import('@bitauth/libauth');
  try {
    const { selected: inputs, total: totalInput } = await selectUtxos(utxos, amountSat, feeRate);
    let fee = BigInt(10 + inputs.length * 148 + 68) * feeRate; // Base fee estimate
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

    // Add change if viable, recalc fee if needed (loop for precision)
    let attempts = 0;
    while (attempts < 3) { // Prevent infinite loop
      if (change >= 546n) {
        transaction.outputs.push({
          valueSatoshis: change,
          lockingBytecode: await _buildP2PKHOutput(senderAddress)
        });
      }
      // Recalc exact fee based on current outputs
      const newFee = BigInt(10 + inputs.length * 148 + transaction.outputs.length * 34) * feeRate;
      if (newFee === fee) break; // Converged
      fee = newFee;
      change = totalInput - amountSat - fee;
      if (change < 0n) throw new Error('Insufficient funds');
      transaction.outputs = transaction.outputs.slice(0, 1); // Reset change output
      attempts++;
    }
    if (attempts === 3) throw new Error('Fee calculation failed to converge');

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
      const sig = secp.sign(message, privBytes, { der: false, lowS: true }); // Ensure low-S for canonical sig
      const derSig = _encodeDer(sig.r, sig.s);
      const sigWithType = new Uint8Array([...derSig, 0x41]);
      const pubkey = secp.getPublicKey(privBytes, true);
      transaction.inputs[i].unlockingBytecode = new Uint8Array([sigWithType.length, ...sigWithType, pubkey.length, ...pubkey]);
    }

    const rawTx = libauth.binToHex(libauth.encodeTransaction(transaction));
    return await broadcastTx(rawTx);
  } catch (err) {
    throw new Error('Failed to build/broadcast transaction: ' + err.message);
  }
}