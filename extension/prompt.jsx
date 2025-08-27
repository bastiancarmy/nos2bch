// extension/prompt.jsx
import React, {useEffect, useState} from 'react'
import {createRoot} from 'react-dom/client'
import browser from 'webextension-polyfill'

function Prompt() {
  let [host, setHost] = useState('')
  let [type, setType] = useState('')
  let [params, setParams] = useState(null)
  let [isSuccess, setIsSuccess] = useState(false)

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
    if (accept === 'true' || accept === 'forever') {
      setIsSuccess(true)
      setTimeout(() => {
        browser.runtime.sendMessage({prompt: true, type, host, accept, conditions})
        window.close()
      }, 2000)
    } else {
      browser.runtime.sendMessage({prompt: true, type, host, accept, conditions})
      window.close()
    }
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
      {isSuccess && (
        <div style={{textAlign: 'center', padding: '20px', background: '#d4edda', color: '#155724', borderRadius: '8px', margin: '10px 0'}}>
          <span style={{fontSize: '24px'}}>✔️</span> Tip sent successfully!
          {/* Optional confetti: Simple CSS keyframe animation */}
          <style>{`
            @keyframes confetti {
              0% { transform: translateY(0) rotate(0); opacity: 1; }
              100% { transform: translateY(100px) rotate(360deg); opacity: 0; }
            }
            .confetti { position: absolute; width: 10px; height: 10px; background: #ffc107; animation: confetti 1s ease-out forwards; }
          `}</style>
          {Array.from({length: 20}).map((_, i) => (
            <div key={i} className="confetti" style={{left: `${Math.random()*100}%`, top: '-10px', animationDelay: `${Math.random()*0.5}s`}} />
          ))}
        </div>
      )}
    </div>
  )
}

createRoot(document.getElementById('main')).render(<Prompt />);