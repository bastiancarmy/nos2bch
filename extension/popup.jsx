// extension/popup.jsx
import React, {useEffect, useState} from 'react'
import {createRoot} from 'react-dom/client'
import browser from 'webextension-polyfill'
import QRCode from 'react-qr-code'
import * as nip19 from 'nostr-tools/nip19'
import {getPublicKey} from 'nostr-tools/pure'
import {deriveBCHAddress, getBCHBalance} from './common'

function Popup() {
  let [pubkey, setPubkey] = useState(null)
  let [bchAddress, setBchAddress] = useState(null)
  let [bchBalance, setBchBalance] = useState(null)
  let [recipientNpub, setRecipientNpub] = useState('')
  let [amountSat, setAmountSat] = useState('')
  let [tipMessage, setTipMessage] = useState('')

  useEffect(() => {
    browser.storage.local.get('private_key').then(results => {
      if (results.private_key) {
        let pk = getPublicKey(results.private_key)
        setPubkey(pk)
        let addr = deriveBCHAddress(pk)
        setBchAddress(addr)
        getBCHBalance(addr)
          .then(balance => setBchBalance(balance))
          .catch(err => setBchBalance('Error: ' + err.message))
      }
    })
  }, [])

  async function sendTip() {
    setTipMessage('Sending...')
    try {
      if (bchBalance === 0) {
        setTipMessage('Error: Balance is 0 sat')
        return
      }
      let res = await browser.runtime.sendMessage({type: 'tipBCH', params: {recipientNpub, amountSat: parseInt(amountSat)}})
      if (res.error) {
        setTipMessage('Error: ' + res.error.message)
      } else {
        setTipMessage(`Tip sent! TXID: ${res.txid}`)
        // Update balance
        if (bchAddress) {
          getBCHBalance(bchAddress).then(setBchBalance).catch(err => setBchBalance('Error: ' + err.message))
        }
      }
    } catch (err) {
      setTipMessage('Error: ' + err.message)
    }
  }

  let npub = pubkey ? nip19.npubEncode(pubkey) : ''

  return (
    <div style={{padding: '20px', minWidth: '300px'}}>
      <h1>nos2bch</h1>
      {pubkey ? (
        <>
          <div>your pubkey:</div>
          <div style={{wordBreak: 'break-all', fontSize: '12px'}}>{npub}</div>
          <QRCode value={npub.toUpperCase()} size={128} style={{margin: '20px auto', display: 'block'}} />
          <div>BCH Address: {bchAddress || 'Loading...'}</div>
          <div>BCH Balance: {bchBalance !== null ? bchBalance + ' sat' : 'Loading...'}</div>
          <h2>Tip BCH</h2>
          <input 
            placeholder="recipient npub" 
            value={recipientNpub} 
            onChange={e => setRecipientNpub(e.target.value)} 
            style={{width: '100%', marginBottom: '10px'}}
          />
          <input 
            type="number" 
            placeholder="amount sat" 
            value={amountSat} 
            onChange={e => setAmountSat(e.target.value)} 
            style={{width: '100%', marginBottom: '10px'}}
          />
          <button onClick={sendTip} disabled={!recipientNpub || !amountSat}>Send Tip</button>
          {tipMessage && <div style={{marginTop: '10px', color: tipMessage.startsWith('Error') ? 'red' : 'green'}}>{tipMessage}</div>}
        </>
      ) : (
        <div>no key found. go to options.</div>
      )}
      <button onClick={() => browser.runtime.openOptionsPage()}>options</button>
    </div>
  )
}

createRoot(document.getElementById('main')).render(<Popup />)