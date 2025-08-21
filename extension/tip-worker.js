import { instantiateSha256, instantiateSecp256k1, binToHex, hexToBin, cashAddressToLockingBytecode, encodeVarint } from '@bitauth/libauth';
import { nip19, getPublicKey } from 'nostr-tools';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { deriveBCHAddress, getUtxos, getFeeRate, broadcastTx } from './common.js';

const sha256Lib = await instantiateSha256();
const secp256k1 = await instantiateSecp256k1();

const SIGHASH_ALL = 0x01;
const SIGHASH_FORKID = 0x40;
const DUST_LIMIT = 546;

function concatBytes(...arrays) {
  const totalLength = arrays.reduce((acc, arr) => acc + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

function encodeUint32LE(value) {
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setUint32(0, value, true);
  return buf;
}

function encodeUint64LE(value) {
  const buf = new Uint8Array(8);
  const dv = new DataView(buf.buffer);
  dv.setBigUint64(0, BigInt(value), true);
  return buf;
}

function dsha256(data) {
  return sha256Lib.hash(sha256Lib.hash(data));
}

function pushData(data) {
  const len = data.length;
  if (len <= 75) return new Uint8Array([len]);
  if (len < 256) return new Uint8Array([76, len]);
  if (len < 65536) {
    const buf = new Uint8Array(3);
    buf[0] = 77;
    new DataView(buf.buffer, 1).setUint16(0, len, true);
    return buf;
  }
  const buf = new Uint8Array(5);
  buf[0] = 78;
  new DataView(buf.buffer, 1).setUint32(0, len, true);
  return buf;
}

function buildRawTx(tx) {
  const parts = [];
  parts.push(encodeUint32LE(tx.version));
  parts.push(encodeVarint(tx.inputs.length));
  for (const inp of tx.inputs) {
    parts.push(inp.outpointTransactionHash);
    parts.push(encodeUint32LE(inp.outpointIndex));
    parts.push(encodeVarint(inp.unlockingScript.length));
    parts.push(inp.unlockingScript);
    parts.push(encodeUint32LE(inp.sequenceNumber));
  }
  parts.push(encodeVarint(tx.outputs.length));
  for (const out of tx.outputs) {
    parts.push(encodeUint64LE(out.value));
    parts.push(encodeVarint(out.lockingScript.length));
    parts.push(out.lockingScript);
  }
  parts.push(encodeUint32LE(tx.locktime));
  return concatBytes(...parts);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'sendTip') {
    (async () => {
      const { senderNpub, nsec, recipientNpub, amountSat } = message.params;
      try {
        const skBytes = hexToBytes(nip19.decode(nsec).data);
        const skHex = bytesToHex(skBytes);
        const pkHex = getPublicKey(skHex);
        const recipientPkHex = nip19.decode(recipientNpub).data;
        const senderAddr = await deriveBCHAddress(pkHex);
        const recipientAddr = await deriveBCHAddress(recipientPkHex);
        const utxos = await getUtxos(senderAddr);
        if (!utxos.length) throw new Error('No UTXOs found');
        const feeRate = await getFeeRate();
        let totalInput = 0;
        const inputs = utxos.map(utxo => {
          totalInput += utxo.value;
          return {
            outpointTransactionHash: hexToBytes(utxo.tx_hash).reverse(),
            outpointIndex: utxo.tx_pos,
            sequenceNumber: 0xffffffff,
            unlockingScript: new Uint8Array(0),
            scriptPubkey: hexToBytes(utxo.script_pubkey),  // For preimage
            value: utxo.value
          };
        });
        // Rough fee estimate (148 bytes/input est., 34/output, 10 overhead)
        let estFee = (inputs.length * 148 + 2 * 34 + 10) * feeRate;  // Assume change output
        if (totalInput < amountSat + DUST_LIMIT + estFee) throw new Error('Insufficient funds');
        const outputs = [
          {
            value: amountSat,
            lockingScript: cashAddressToLockingBytecode(recipientAddr)
          }
        ];
        let change = totalInput - amountSat - estFee;
        if (change > DUST_LIMIT) {
          outputs.push({
            value: change,
            lockingScript: cashAddressToLockingBytecode(senderAddr)
          });
        }
        const tx = {
          version: 2,
          inputs,
          outputs,
          locktime: 0
        };
        // Sign each input
        const sighashType = SIGHASH_ALL | SIGHASH_FORKID;
        const hashPrevoutsData = concatBytes(...inputs.map(inp => concatBytes(inp.outpointTransactionHash, encodeUint32LE(inp.outpointIndex))));
        const hashPrevouts = dsha256(hashPrevoutsData);
        const hashSequenceData = concatBytes(...inputs.map(inp => encodeUint32LE(inp.sequenceNumber)));
        const hashSequence = dsha256(hashSequenceData);
        const hashOutputsData = concatBytes(...outputs.map(out => concatBytes(encodeUint64LE(out.value), encodeVarint(out.lockingScript.length), out.lockingScript)));
        const hashOutputs = dsha256(hashOutputsData);
        for (let i = 0; i < inputs.length; i++) {
          const inp = inputs[i];
          const preimageParts = [
            encodeUint32LE(tx.version),
            hashPrevouts,
            hashSequence,
            inp.outpointTransactionHash,
            encodeUint32LE(inp.outpointIndex),
            encodeVarint(inp.scriptPubkey.length),
            inp.scriptPubkey,
            encodeUint64LE(inp.value),
            encodeUint32LE(inp.sequenceNumber),
            hashOutputs,
            encodeUint32LE(tx.locktime),
            encodeUint32LE(sighashType)
          ];
          const preimage = concatBytes(...preimageParts);
          const sighash = dsha256(preimage);
          const derSig = secp256k1.signMessageHashDER(skBytes, sighash);
          const fullSig = concatBytes(derSig, new Uint8Array([sighashType]));
          const compressedPk = hexToBytes(secp256k1.derivePublicKeyCompressed(skBytes));
          const unlockingScript = concatBytes(pushData(fullSig), fullSig, pushData(compressedPk), compressedPk);
          tx.inputs[i].unlockingScript = unlockingScript;
        }
        const rawTxBytes = buildRawTx(tx);
        const rawTxHex = bytesToHex(rawTxBytes);
        const txid = await broadcastTx(rawTxHex);
        sendResponse({ txid });
      } catch (err) {
        console.error('Tip offscreen error:', err);
        sendResponse({ error: err.message });
      }
    })();
    return true;  // Indicates async response
  }
});