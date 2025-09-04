import React, {useEffect, useState} from 'react'
import {createRoot} from 'react-dom/client'
import browser from 'webextension-polyfill'
import {QRCodeSVG} from 'qrcode.react'
import {getPublicKey} from 'nostr-tools'
import {bytesToHex, hexToBytes} from '@noble/hashes/utils'
import {deriveBCHAddress, getBCHBalance} from './common'

function Popup() {
  const [privKey, setPrivKey] = useState(null)
  const [bchAddress, setBchAddress] = useState('')
  const [bchBalance, setBchBalance] = useState(null)
  const [balanceLoading, setBalanceLoading] = useState(false)

  useEffect(() => {
    console.log('Popup loading...'); // Debug
    browser.storage.local.get('private_key').then(results => {
      console.log('Popup storage:', results); // Debug
      if (results.private_key) {
        setPrivKey(results.private_key);
        const pub = getPublicKey(hexToBytes(results.private_key));
        const address = deriveBCHAddress(pub);
        setBchAddress(address);
        refreshBalance(address);
      }
    }).catch(err => console.error('Popup storage error:', err));
  }, []);

  async function refreshBalance(address, force = false) {
    setBalanceLoading(true);
    try {
      const bchValue = await getBCHBalance(address, force); // Assuming BCH value
      console.log('Raw balance from getBCHBalance:', bchValue); // Debug
      const sats = bchValue * 100000000; // Convert BCH to sats
      setBchBalance(sats);
    } catch (err) {
      setBchBalance(null);
      console.error('Error fetching balance:', err.message);
    } finally {
      setBalanceLoading(false);
    }
  }

  const openOptions = () => {
    browser.runtime.openOptionsPage();
  }

  const formattedBalance = bchBalance !== null ? bchBalance.toLocaleString() + ' sats' : '';

  return (
    <div style={{padding: '10px', width: '300px'}}>
      <h1>nos2bch</h1>
      {privKey ? (
        <>
          <div>BCH Address: {bchAddress}</div>
          <QRCodeSVG value={bchAddress.toUpperCase()} size={128} level="H" style={{margin: '10px 0'}} />
          <div>
            Balance: {balanceLoading ? <span>Loading...</span> :
              (bchBalance !== null ? formattedBalance :
                <span>Error - <button onClick={() => refreshBalance(bchAddress, true)}>Retry</button></span>)}
          </div>
          <button onClick={() => refreshBalance(bchAddress, true)} disabled={balanceLoading}>Refresh</button>
          <button onClick={openOptions}>Options</button>
        </>
      ) : (
        <>
          <p>No private key set. Click below to generate or import one.</p>
          <button onClick={openOptions}>Start</button>
        </>
      )}
    </div>
  )
}

createRoot(document.getElementById('main')).render(<Popup />);