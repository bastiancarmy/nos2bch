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
  let [success, setSuccess] = useState(false);
  let [error, setError] = useState(false);
  let [message, setMessage] = useState('');

  useEffect(() => {
    browser.runtime.sendMessage({getPrompt: true}).then(prompt => {
      if (prompt) {
        setHost(prompt.host)
        setType(prompt.type)
        setParams(prompt.params)
      }
    });

    const listener = (msg) => {
      if (msg.tipResult) {
        setProcessing(false);
        if (msg.tipResult.txid) {
          setSuccess(true); // Trigger green check/confetti UI
          setMessage(`Tip sent! TxID: ${msg.tipResult.txid}`);
          setTimeout(() => browser.windows.getCurrent().then(win => browser.windows.remove(win.id)), 3000); // Auto-close
        } else {
          setError(true);
          setMessage(`Error: ${msg.tipResult.error}`);
        }
      }
    };
    browser.runtime.onMessage.addListener(listener);
    return () => browser.runtime.onMessage.removeListener(listener);
  }, []);

  function respond(accept, conditions = null) {
    browser.runtime.sendMessage({prompt: true, type, host, accept, conditions});
    setProcessing(true); // Don't close, show processing
  }

  let initialMessage = `Allow ${host} to ${type}?`;
  let estFee = ' ~200 sats';
  let estChange = params?.amountSat ? `Change: ~${bchBalance - params.amountSat - 200} sats` : ''; // Placeholder

  if (type === 'tipBCH' && params) {
    initialMessage = `Send ${params.amountSat} sats to ${params.recipientNpub}? Est fee:${estFee}. ${estChange}`;
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
      <div>{success || error ? message : initialMessage}</div>
      <button onClick={() => respond('true')}>Yes</button>
      <button onClick={() => respond('false')}>No</button>
      <button onClick={() => respond('forever')}>Always</button>
    </div>
  );
}

createRoot(document.getElementById('main')).render(<Prompt />);