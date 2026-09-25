/** The console renders only a screenshot; remote page code never runs in this document. */
export function browserConsole(previewUrl: string) {
  const preview = JSON.stringify(previewUrl).replace(/</g, "\\u003c");
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OpenMuse browser</title><style>
*{box-sizing:border-box}body{margin:0;background:#fcfcfc;color:#172125;font:13px -apple-system,BlinkMacSystemFont,system-ui,sans-serif}
.toolbar{display:flex;align-items:center;gap:6px;padding:6px 10px;background:#fff;border-bottom:1px solid #eef1f3;flex-wrap:wrap}
button,input{font:inherit;border:1px solid #e2e8f0;border-radius:6px;padding:4px 10px;background:white;color:inherit;min-height:30px}
button{cursor:pointer;font-size:12px;font-weight:500}button:hover{background:#edf7fd}button:disabled{opacity:.45;cursor:default}
button:focus-visible,input:focus-visible{outline:2px solid #1473c8;outline-offset:1px}
form{display:flex;gap:4px;flex:1;min-width:180px;margin:0}input{flex:1;min-width:0;background:#f8fafc;font-size:12px}
#type{background:#1473c8;color:#fff;border-color:#1473c8}#type:hover{background:#0e5ea6}
nav{display:flex;gap:4px}nav button{padding:4px 8px;font-size:11px}
#status{color:#697176;font-size:11px;font-weight:600;margin-left:auto}#status.live{color:#248258}
#refresh{padding:4px 8px}
#stage{overflow:hidden;background:#eef1f3;min-height:200px}img{display:block;width:100%;height:auto;cursor:default;touch-action:pan-y}img.stale{opacity:.45;pointer-events:none}
#error{margin:6px 10px;color:#984a41;background:#fbefed;padding:8px 12px;border-radius:8px;font-size:12px}#error:empty{display:none}
footer{padding:4px 10px;color:#8a9398;font-size:11px}
</style>
<div class="toolbar">
  <form id="type-form">
    <input id="text" aria-label="Text to type in browser" placeholder="Click page to focus, type text here..." autocomplete="off">
    <button id="type" type="submit">Send</button>
  </form>
  <nav aria-label="Browser keyboard">
    <button data-key="Enter" title="Enter">↵</button>
    <button data-key="Tab" title="Tab">Tab</button>
    <button data-key="Backspace" title="Delete">⌫</button>
    <button id="up" title="Scroll Up">↑</button>
    <button id="down" title="Scroll Down">↓</button>
  </nav>
  <span id="status" role="status">Connecting…</span>
  <button id="refresh" aria-label="Refresh browser preview">↻</button>
</div>
<div id="error" role="alert"></div><div id="stage"><img id="screen" class="stale" alt="Live browser session, click to interact" draggable="false" style="display:none"></div>
<script>
const image=document.querySelector('#screen'),error=document.querySelector('#error'),status=document.querySelector('#status'),field=document.querySelector('#text');
let refreshing=false,sending=false,imageUrl,live=false,previewError=false,followUp=0;const queue=[];
function controls(){document.querySelectorAll('nav button,#type').forEach(button=>button.disabled=!live);image.classList.toggle('stale',!live||sending);}
async function refresh(){if(refreshing||document.hidden)return;refreshing=true;try{
const r=await fetch(${preview},{cache:'no-store',signal:AbortSignal.timeout(20000)});
if(!r.ok)throw new Error(r.status===401?'Session access expired. Close this view and open the browser again.':'Browser disconnected. Reopen the session from OpenMuse.');
const blob=await r.blob();const next=URL.createObjectURL(blob);await new Promise((resolve,reject)=>{const probe=new Image();probe.onload=resolve;probe.onerror=()=>{URL.revokeObjectURL(next);reject(new Error('The browser preview could not be displayed.'));};probe.src=next;});
if(imageUrl)URL.revokeObjectURL(imageUrl);imageUrl=next;image.src=next;image.style.display='block';live=true;status.textContent='Live';status.className='live';if(previewError){error.textContent='';previewError=false;}
}catch(e){live=false;previewError=true;status.textContent='Disconnected';status.className='';error.textContent=e.message;}finally{refreshing=false;controls();}}
function input(body){if(!live)return Promise.resolve(false);return new Promise(resolve=>{queue.push({body,resolve});void pump();});}
async function pump(){if(sending||!queue.length)return;sending=true;controls();const item=queue.shift();error.textContent='';status.textContent='Updating…';let ok=false;try{
const r=await fetch(location.href,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(item.body),signal:AbortSignal.timeout(45000)});
if(!r.ok){const data=await r.json();throw new Error(typeof data.error==='string'?data.error:'Browser action failed. Your text is still here.');}ok=true;
}catch(e){error.textContent=e.message;}finally{sending=false;item.resolve(ok);controls();if(queue.length)void pump();else{refresh();clearTimeout(followUp);followUp=setTimeout(()=>{if(!sending&&!queue.length)refresh();},800);}}}
image.onclick=e=>{if(!live)return;const r=image.getBoundingClientRect();input({type:'click',x:Math.min(1279,Math.max(0,Math.floor((e.clientX-r.left)*1280/r.width))),y:Math.min(799,Math.max(0,Math.floor((e.clientY-r.top)*800/r.height)))});}
document.querySelector('form').onsubmit=async e=>{e.preventDefault();const text=field.value;if(text&&await input({type:'text',text})&&field.value===text)field.value='';};
document.querySelectorAll('[data-key]').forEach(b=>b.onclick=()=>input({type:'key',key:b.dataset.key}));
document.querySelector('#up').onclick=()=>input({type:'scroll',deltaY:-600});document.querySelector('#down').onclick=()=>input({type:'scroll',deltaY:600});
document.querySelector('#refresh').onclick=()=>{error.textContent='';refresh();};document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});
controls();refresh();const timer=setInterval(refresh,1000);window.addEventListener('pagehide',()=>{clearInterval(timer);if(imageUrl)URL.revokeObjectURL(imageUrl);});
</script></html>`;
}
