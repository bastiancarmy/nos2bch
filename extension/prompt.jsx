// extension/prompt.jsx

import React, {useEffect, useState} from 'react'
import {createRoot} from 'react-dom/client'
import browser from 'webextension-polyfill'

function Prompt() {
  let [host, setHost] = useState('')
  let [type, setType] = useState('')
  let [params, setParams] = useState(null)
  let [processing, setProcessing] = useState(false)
  let [result, setResult] = useState(null) // {success: true/false, txid or error}

  useEffect(() => {
    browser.runtime.sendMessage({getPrompt: true}).then(prompt => {
      if (prompt) {
        setHost(prompt.host)
        setType(prompt.type)
        setParams(prompt.params)
      }
    });

    // Listen for result from background
    browser.runtime.onMessage.addListener((msg) => {
      if (msg.tipResult) {
        setResult(msg.tipResult);
        setTimeout(() => window.close(), 3000); // Auto-close after 3s
      }
    });
  }, []);

  function respond(accept, conditions = null) {
    browser.runtime.sendMessage({prompt: true, type, host, accept, conditions});
    setProcessing(true); // Don't close, show processing
  }

  let message = `Allow ${host} to ${type}?`;
  let estFee = ' ~200 sats';
  let estChange = params?.amountSat ? `Change: ~${bchBalance - params.amountSat - 200} sats` : ''; // Placeholder

  if (type === 'tipBCH' && params) {
    message = `Send ${params.amountSat} sats to ${params.recipientNpub}? Est fee:${estFee}. ${estChange}`;
  }

  if (processing) {
    if (result) {
      if (result.txid) {
        return <div style={{color: 'green'}}>Success! TxID: {result.txid} ✅</div>;
      } else {
        return <div style={{color: 'red'}}>Failed: {result.error} ❌</div>;
      }
    }
    return <div>Processing tip...</div>;
  }

  return (
    <div style={{padding: '10px'}}>
      <div>{message}</div>
      <button onClick={() => respond('true')}>Yes</button>
      <button onClick={() => respond('false')}>No</button>
      <button onClick={() => respond('forever')}>Always</button>
    </div>
  );
}

createRoot(document.getElementById('main')).render(<Prompt />);