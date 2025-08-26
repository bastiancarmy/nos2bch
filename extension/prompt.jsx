// extension/prompt.jsx
// Updates:
// - Fetch prompt details via {getPrompt: true} message.
// - If type === 'tipBCH', populate custom message with amountSat and recipientNpub from params.
// - Fallback to generic if no params or other type.
// - Added estFee/change as approximate (hardcoded est for simplicity; can enhance later).

import React, {useEffect, useState} from 'react'
import {createRoot} from 'react-dom/client'
import browser from 'webextension-polyfill'

function Prompt() {
  let [host, setHost] = useState('')
  let [type, setType] = useState('')
  let [params, setParams] = useState(null)

  useEffect(() => {
    browser.runtime.sendMessage({getPrompt: true}).then(prompt => {
      if (prompt) {
        setHost(prompt.host)
        setType(prompt.type)
        setParams(prompt.params)
      }
    })
  }, [])

  function respond(accept, conditions = null) {
    browser.runtime.sendMessage({prompt: true, type, host, accept, conditions})
    window.close()
  }

  let message = `Allow ${host} to ${type}?`
  let estFee = ' ~200 sats' // Approximate; can compute if needed
  let estChange = params?.amountSat ? `Change: ~${bchBalance - params.amountSat - 200} sats` : '' // Placeholder, need balance

  if (type === 'tipBCH' && params) {
    message = `Send ${params.amountSat} sats to ${params.recipientNpub}? Est fee:${estFee}. ${estChange}`
  }

  return (
    <div style={{padding: '10px'}}>
      <div>{message}</div>
      <button onClick={() => respond('true')}>Yes</button>
      <button onClick={() => respond('false')}>No</button>
      <button onClick={() => respond('forever')}>Always</button>
    </div>
  )
}

createRoot(document.getElementById('main')).render(<Prompt />);